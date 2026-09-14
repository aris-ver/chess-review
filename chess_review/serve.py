"""Local server: static site + a tiny JSON API for on-demand work. Stdlib only.

    GET  /api/status          current job (or null)
    POST /api/analyse/<id>    analyse one game (MultiPV=3, fixed nodes), streaming progress into games/<id>.json
    POST /api/stop            stop the running analysis
    POST /api/refresh         re-fetch the latest chess.com month, normalise, rebuild the site
    POST /api/analyse_all     analyse every game that isn't fully analysed yet, newest first
    GET  /api/legal?fen=      legal moves in a position (for the board UI)
    POST /api/explore         {fen, uci, my_colour} -> the move evaluated and classified on the spot

One job at a time: analysis uses every core. The DuckDB write lock is held only
while a job runs, so the CLI stages still work in between.
"""

import argparse
import functools
import json
import logging
import signal
import sys
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import parse_qs, urlparse

from . import aggregates, classify, critical, ingest, normalise, site
from .explore import Explorer
from .analyse import Analyser, export_parquet, open_db, pending_keys
from .config import DEFAULT_NODES, ENGINE_IDLE_SECONDS, META_JSON, SITE_DIR
from .db import base_views

log = logging.getLogger("serve")


class Job:
    def __init__(self, kind: str, game_id: Optional[str] = None, slug: Optional[str] = None):
        self.kind, self.game_id, self.slug = kind, game_id, slug
        self.status = "queued"          # queued | running | finishing | done | error | stopped
        self.done, self.total = 0, 0
        self.error: Optional[str] = None
        self.started = time.time()
        self.stop_requested = False

        self.game_done, self.game_total = 0, 0   # analyse_all: position progress within the current game

    def to_dict(self) -> dict:
        return {"kind": self.kind, "game": self.slug, "status": self.status, "done": self.done, "total": self.total,
                "game_done": self.game_done, "game_total": self.game_total,
                "error": self.error, "elapsed": round(time.time() - self.started, 1)}


class Runner:
    def __init__(self, nodes: int, workers: Optional[int] = None):
        self.analyser = Analyser(workers=workers, nodes=nodes)
        self.explorer = Explorer(nodes=nodes, threads=workers)
        self.job: Optional[Job] = None
        self.lock = threading.Lock()

    def busy(self) -> bool:
        return self.job is not None and self.job.status in ("queued", "running", "finishing")

    def reap_idle(self) -> None:
        """Free engine memory when nothing has used the engines for a while."""
        now = time.time()
        if not self.busy() and self.analyser._pool is not None and now - self.analyser.last_used > ENGINE_IDLE_SECONDS:
            log.info("idle: shutting down the analysis pool")
            self.analyser.close()
        if self.explorer._engine is not None and now - self.explorer.last_used > ENGINE_IDLE_SECONDS and not self.explorer._lock.locked():
            log.info("idle: shutting down the exploration engine")
            self.explorer.close()

    def start(self, job: Job) -> bool:
        with self.lock:
            if self.busy():
                return False
            self.job = job
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return True

    def _run(self, job: Job) -> None:
        try:
            job.status = "running"
            if job.kind == "analyse":
                self._analyse(job)
            elif job.kind == "analyse_all":
                self._analyse_all(job)
            else:
                self._refresh(job)
            job.status = "stopped" if job.stop_requested else "done"
        except Exception as e:  # noqa: BLE001 - surfaced to the UI
            log.error("job failed: %s", traceback.format_exc())
            job.status, job.error = "error", str(e)

    def _analyse(self, job: Job) -> None:
        con = open_db()
        base_views(con)
        try:
            keys, stats = pending_keys(con, job.game_id)
            job.total = len(keys)
            log.info("analyse %s: %s", job.slug, stats)
            # positions in game order so the review fills in from move 1
            order = {r[0]: i for i, r in enumerate(con.execute(
                "SELECT fen_key, min(ply) FROM positions WHERE game_id = ? GROUP BY 1 ORDER BY 2", [job.game_id]).fetchall())}
            keys.sort(key=lambda k: order.get(k, 1 << 30))

            def progress(done: int, total: int) -> None:
                job.done = done
                site.update_index(site.write_game(con, job.game_id))

            self.analyser.run(keys, con, on_progress=progress, batch=self.analyser.workers, should_stop=lambda: job.stop_requested)
            job.status = "finishing"
            site.update_index(site.write_game(con, job.game_id))
            export_parquet(con)
        finally:
            con.close()
        # keep the batch tables current for the insights page (cheap, no engine)
        classify.build()
        critical.build()
        aggregates.build()

    def _analyse_all(self, job: Job) -> None:
        con = open_db()
        base_views(con)
        try:
            games = con.execute("SELECT game_id FROM games ORDER BY played_at DESC").fetchall()
            todo = []
            for (gid,) in games:
                keys, _ = pending_keys(con, gid)
                if keys:
                    todo.append((gid, keys))
            job.total = len(todo)
            log.info("analyse_all: %d games need work", len(todo))
            for gid, keys in todo:
                if job.stop_requested:
                    break
                job.slug, job.game_done, job.game_total = site.slug(gid), 0, len(keys)
                order = {r[0]: i for i, r in enumerate(con.execute(
                    "SELECT fen_key, min(ply) FROM positions WHERE game_id = ? GROUP BY 1 ORDER BY 2", [gid]).fetchall())}
                keys.sort(key=lambda k: order.get(k, 1 << 30))

                def progress(done: int, total: int) -> None:
                    job.game_done = done

                self.analyser.run(keys, con, on_progress=progress, batch=self.analyser.workers * 2,
                                  should_stop=lambda: job.stop_requested)
                site.update_index(site.write_game(con, gid))
                job.done += 1
                log.info("analyse_all: %d/%d games done (%s)", job.done, job.total, job.slug)
            job.status = "finishing"
            export_parquet(con)
        finally:
            con.close()
        classify.build()
        critical.build()
        aggregates.build()

    def _refresh(self, job: Job) -> None:
        username = json.loads(META_JSON.read_text())["username"]
        job.total = 3
        stats = ingest.fetch_archives(username, refresh_latest=True)
        log.info("refresh: %s", stats)
        job.done = 1
        normalise.build(username)
        job.done = 2
        site.build()
        classify.build()
        critical.build()
        aggregates.build()
        job.done = 3


class Handler(SimpleHTTPRequestHandler):
    runner: Runner = None  # set in main

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        log.debug(fmt, *args)

    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        if self.path.startswith("/api/status"):
            return self._json({"job": self.runner.job.to_dict() if self.runner.job else None})
        if self.path.startswith("/api/legal"):
            fen = parse_qs(urlparse(self.path).query).get("fen", [""])[0]
            try:
                return self._json(self.runner.explorer.legal(fen))
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
        return super().do_GET()

    def do_POST(self):
        r = self.runner
        if self.path.startswith("/api/analyse/"):
            slug = self.path.rsplit("/", 1)[-1]
            game_id = _game_id_for(slug)
            if game_id is None:
                return self._json({"error": "unknown game"}, 404)
            job = Job("analyse", game_id, slug)
            if not r.start(job):
                return self._json({"error": "busy", "job": r.job.to_dict()}, 409)
            return self._json({"job": job.to_dict()})
        if self.path.startswith("/api/analyse_all"):
            job = Job("analyse_all")
            if not r.start(job):
                return self._json({"error": "busy", "job": r.job.to_dict()}, 409)
            return self._json({"job": job.to_dict()})
        if self.path.startswith("/api/refresh"):
            job = Job("refresh")
            if not r.start(job):
                return self._json({"error": "busy", "job": r.job.to_dict()}, 409)
            return self._json({"job": job.to_dict()})
        if self.path.startswith("/api/explore"):
            b = self._body()
            try:
                return self._json(r.explorer.move(b["fen"], b["uci"], b.get("my_colour", "white"), int(b.get("ply", 0))))
            except (ValueError, KeyError) as e:
                return self._json({"error": str(e)}, 400)
            except Exception as e:  # noqa: BLE001
                log.error("explore failed: %s", traceback.format_exc())
                return self._json({"error": str(e)}, 500)
        if self.path.startswith("/api/stop"):
            if r.job:
                r.job.stop_requested = True
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)


def _game_id_for(slug: str) -> Optional[str]:
    path = SITE_DIR / "games" / f"{slug}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))["url"]


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="serve", description=__doc__)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8123)
    p.add_argument("--nodes", type=int, default=DEFAULT_NODES, help="nodes per position for on-demand analysis")
    p.add_argument("--workers", type=int, default=None, help="engine processes for game analysis (default: physical cores)")
    args = p.parse_args(argv)
    if not (SITE_DIR / "index.html").exists():
        site.build()
    Handler.runner = Runner(args.nodes, args.workers)

    def reaper():
        while True:
            time.sleep(30)
            try:
                Handler.runner.reap_idle()
            except Exception:  # noqa: BLE001
                log.debug("reaper: %s", traceback.format_exc())
    threading.Thread(target=reaper, daemon=True).start()
    handler = functools.partial(Handler, directory=str(SITE_DIR))
    srv = ThreadingHTTPServer((args.host, args.port), handler)
    log.info("serving %s at http://%s:%d/", SITE_DIR, args.host, args.port)

    def shutdown(signum, frame):
        log.info("signal %d: shutting down", signum)
        Handler.runner.analyser.close()
        Handler.runner.explorer.close()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        Handler.runner.analyser.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
