"""Local server: static site + a tiny JSON API for on-demand work. Stdlib only.

    GET  /api/status                    current job (or null)
    GET  /api/profiles                  saved profiles with game counts; new_games per profile is what chess.com has
                                        that a refresh would fetch (scanned once per launch, in the background)
    POST /api/profiles/<id>/seen        the user has seen the new-games badge: drop it until the next scan
    GET  /api/profiles/<id>/unseen      games a refresh brought in that haven't been opened yet
    POST /api/profiles/<id>/games/<game>/seen   the game was opened: drop its "new" flag in the list
    POST /api/profiles                  {source, username} -> create the profile and fetch its games (job "ingest")
    POST /api/profiles/<id>/delete      remove a profile and everything under it (the engine cache is shared and stays)
    POST /api/profiles/<id>/pin         {pinned: bool} keep it at the top of the home screen
    POST /api/p/<id>/analyse/<slug>     analyse one game (MultiPV=3, fixed nodes), streaming progress into its JSON
    POST /api/p/<id>/refresh            {analyse?: bool} re-fetch the latest chess.com month, normalise, rebuild the
                                        site; with analyse=true the new games are analysed in the same job
    POST /api/p/<id>/analyse_all        analyse every game that isn't fully analysed yet, newest first (no UI button;
                                        `python -m chess_review analyse` does the same from the CLI)
    POST /api/stop                      stop the running job
    GET  /api/legal?fen=                legal moves in a position (for the board UI)
    POST /api/explore                   {fen, uci, my_colour} -> the move evaluated and classified on the spot
    POST /api/pgn                       {pgn, review_as?} -> stored in the "Pasted games" profile and reviewable at once
                                        (review_as defaults to the side a saved profile played, else white)
    GET  /api/engine                    {name, nodes, multipv} of the on-demand engine (shown next to results)
    GET  /api/fetch_image?url=          proxy an image so the board reader can inspect it on a canvas
    GET  /api/eval?fen=                 the engine's eval and best move in a position, no move required (sandbox)
    GET  /api/update[?check=1]          installed version, the latest release if newer, download progress (desktop
                                        build only; check=1 asks GitHub again instead of using the hourly cache)
    POST /api/update/download           fetch the latest release into DATA/update (the small zip when it fits)
    POST /api/update/apply              swap the downloaded update in and restart the app (refused while a job runs)

    /                                   the app (data/site)
    /p/<id>/...                         a profile's games.json, games/<slug>.json, insights.html

One job at a time: analysis uses every core. The DuckDB write lock is held only
while a job runs, so the CLI stages still work in between.
"""

import argparse
import functools
import json
import logging
import posixpath
import re
import signal
import sys
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

import chess
import requests

from . import aggregates, classify, ingest, normalise, profiles, site, updater
from .analyse import Analyser, export_parquet, open_db, pending_keys
from .config import DEFAULT_NODES, ENGINE_IDLE_SECONDS, MULTIPV_N, SITE_DIR, USER_AGENT
from .db import base_views
from .explore import Explorer
from .pov import pov_win_pct
from .profiles import Profile
from .site import eval_text

log = logging.getLogger("serve")
_PROFILE_PATH = re.compile(r"^/p/([A-Za-z0-9_.-]+)/(.*)$")


class Job:
    def __init__(self, kind: str, profile: Profile, game_id: Optional[str] = None, slug: Optional[str] = None,
                 analyse: bool = False):
        self.kind, self.profile, self.game_id, self.slug = kind, profile, game_id, slug
        self.analyse = analyse                 # refresh: analyse the new games afterwards
        self.status = "queued"          # queued | running | finishing | done | error | stopped
        self.done, self.total = 0, 0
        self.error: Optional[str] = None
        self.started = time.time()
        self.stop_requested = False

        self.game_done, self.game_total = 0, 0   # analyse_all: position progress within the current game

    def to_dict(self) -> dict:
        return {"kind": self.kind, "profile": self.profile.id, "game": self.slug, "status": self.status,
                "done": self.done, "total": self.total, "game_done": self.game_done, "game_total": self.game_total,
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
            elif job.kind == "ingest":
                self._ingest(job)
            else:
                self._refresh(job)
            job.status = "stopped" if job.stop_requested else "done"
        except Exception as e:  # noqa: BLE001 - surfaced to the UI
            log.error("job failed: %s", traceback.format_exc())
            job.status, job.error = "error", str(e)
            if job.kind == "ingest" and not (job.profile.site_dir / "games.json").exists():
                # a profile that never got its games (typo, unknown user) shouldn't linger on the home screen
                if "404" in job.error:
                    job.error = f"chess.com has no user called {job.profile.username}"
                profiles.delete(job.profile.id)

    def _analyse(self, job: Job) -> None:
        p = job.profile
        con = open_db()
        base_views(con, p)
        try:
            keys, stats = pending_keys(con, p, job.game_id)
            job.total = len(keys)
            log.info("analyse %s/%s: %s", p.id, job.slug, stats)
            # positions in game order so the review fills in from move 1
            order = {r[0]: i for i, r in enumerate(con.execute(
                "SELECT fen_key, min(ply) FROM positions WHERE game_id = ? GROUP BY 1 ORDER BY 2", [job.game_id]).fetchall())}
            keys.sort(key=lambda k: order.get(k, 1 << 30))

            def progress(done: int, _total: int) -> None:
                job.done = done
                site.update_index(p, site.write_game(con, p, job.game_id))

            self.analyser.run(keys, con, on_progress=progress, batch=self.analyser.workers, should_stop=lambda: job.stop_requested)
            job.status = "finishing"
            site.update_index(p, site.write_game(con, p, job.game_id))
            export_parquet(con)
        finally:
            con.close()
        # keep moves.parquet and the insights page current (cheap, no engine)
        classify.build(p)
        aggregates.build(p)

    def _analyse_all(self, job: Job) -> None:
        p = job.profile
        job.kind, job.done, job.total = "analyse_all", 0, 0
        con = open_db()
        base_views(con, p)
        try:
            games = con.execute("SELECT game_id FROM games ORDER BY played_at DESC").fetchall()
            todo = []
            for (gid,) in games:
                keys, _ = pending_keys(con, p, gid)
                if keys:
                    todo.append((gid, keys))
            job.total = len(todo)
            log.info("analyse_all %s: %d games need work", p.id, len(todo))
            for gid, keys in todo:
                if job.stop_requested:
                    break
                job.slug, job.game_done, job.game_total = site.slug(gid), 0, len(keys)
                order = {r[0]: i for i, r in enumerate(con.execute(
                    "SELECT fen_key, min(ply) FROM positions WHERE game_id = ? GROUP BY 1 ORDER BY 2", [gid]).fetchall())}
                keys.sort(key=lambda k: order.get(k, 1 << 30))

                def progress(done: int, _total: int) -> None:
                    job.game_done = done

                self.analyser.run(keys, con, on_progress=progress, batch=self.analyser.workers * 2,
                                  should_stop=lambda: job.stop_requested)
                site.update_index(p, site.write_game(con, p, gid))
                job.done += 1
                log.info("analyse_all: %d/%d games done (%s)", job.done, job.total, job.slug)
            job.status = "finishing"
            export_parquet(con)
        finally:
            con.close()
        classify.build(p)
        aggregates.build(p)

    def _rebuild(self, job: Job) -> None:
        """normalise -> site -> classify -> aggregates for the job's profile (no engine work)."""
        p = job.profile
        normalise.build(p)
        job.done += 1
        site.build(p)
        job.done += 1
        classify.build(p)
        aggregates.build(p)
        job.done += 1   # (rebuild_profile() is the same sequence without the progress counter)

    def _ingest(self, job: Job) -> None:
        """New profile: fetch every archive, then build its site. done/total count months while fetching."""
        p = job.profile
        if p.source != "chesscom":
            raise ValueError(f"{p.source} profiles can't be fetched yet")

        def progress(done: int, total: int) -> None:
            job.done, job.total = done, total + 3

        stats = ingest.fetch_archives(p, on_progress=progress)
        log.info("ingest %s: %s", p.id, stats)
        Handler.new_games.clear(p.id)
        job.total = max(job.total, 3)
        job.done = job.total - 3
        self._rebuild(job)

    def _refresh(self, job: Job) -> None:
        p = job.profile
        job.total = 4
        had = p.game_ids()
        stats = ingest.fetch_archives(p, refresh_latest=True)
        log.info("refresh %s: %s", p.id, stats)
        Handler.new_games.clear(p.id)
        job.done = 1
        self._rebuild(job)
        profiles.add_unseen(p.id, p.game_ids() - had)     # what the refresh brought in: flagged in the list until opened
        if job.analyse:
            # the UI switches to the batch progress display for the rest of the job
            self._analyse_all(job)


class NewGames:
    """Once per launch, in the background: for each chess.com profile, how many games the site has that aren't
    on disk yet -- the "3 new games" badge on the home screen's profile cards. Counts drop when the user opens
    the card (seen) or a fetch brings the games in."""

    def __init__(self):
        self.counts: dict[str, int] = {}
        self.state = "idle"             # idle | running | done

    def start(self) -> None:
        self.state = "running"
        threading.Thread(target=self._run, daemon=True, name="new-games").start()

    def _run(self) -> None:
        for p in profiles.list_profiles():
            if p.source != "chesscom" or not p.raw_dir.exists():
                continue
            try:
                n = ingest.count_new_games(p)
            except Exception as e:  # noqa: BLE001 - offline, rate-limited, renamed account: no badge, nothing else
                log.info("new-games scan for %s failed: %s", p.id, e)
                continue
            if n:
                self.counts[p.id] = n
            log.info("new-games scan %s: %d", p.id, n)
        self.state = "done"

    def clear(self, pid: str) -> None:
        self.counts.pop(pid, None)


class Handler(SimpleHTTPRequestHandler):
    runner: Runner = None  # set in main
    updates: updater.Updater = None
    new_games: NewGames = None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        log.debug(fmt, *args)

    def translate_path(self, path: str) -> str:
        """/p/<id>/<file> comes from that profile's site dir; everything else from data/site."""
        m = _PROFILE_PATH.match(urlparse(path).path)
        if m:
            p = profiles.load(m.group(1))
            rel = posixpath.normpath("/" + unquote(m.group(2))).lstrip("/")
            if p is None:
                return str(SITE_DIR / "__missing__")
            return str(p.site_dir / rel)
        return super().translate_path(path)

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

    def _start(self, job: Job) -> None:
        if not self.runner.start(job):
            return self._json({"error": "busy", "job": self.runner.job.to_dict()}, 409)
        return self._json({"job": job.to_dict()})

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/status":
            return self._json({"job": self.runner.job.to_dict() if self.runner.job else None})
        if url.path == "/api/profiles":
            out = []
            for p in profiles.list_profiles():
                out.append({**p.summary(), "new_games": self.new_games.counts.get(p.id, 0)})
            return self._json({"profiles": out, "scan": self.new_games.state})
        m = re.match(r"^/api/profiles/([A-Za-z0-9_.-]+)/unseen$", url.path)
        if m:
            p = profiles.load(m.group(1))
            return self._json({"unseen": p.summary()["unseen"] if p else []})
        if url.path == "/api/legal":
            fen = parse_qs(url.query).get("fen", [""])[0]
            try:
                return self._json(self.runner.explorer.legal(fen))
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
        if url.path == "/api/eval":
            fen = parse_qs(url.query).get("fen", [""])[0]
            try:
                board = chess.Board(fen)
                main, _ = self.runner.explorer.evaluate(board)
            except (ValueError, IndexError) as e:
                return self._json({"error": str(e)}, 400)
            except Exception as e:  # noqa: BLE001
                log.error("eval failed: %s", traceback.format_exc())
                return self._json({"error": str(e)}, 500)
            best_uci, best_san = main.get("best_move"), None
            if best_uci:
                try:
                    best_san = board.san(chess.Move.from_uci(best_uci))
                except ValueError:
                    best_san = None
            side = "white" if board.turn else "black"
            has_eval = main["eval_cp"] is not None or main["mate_in"] is not None
            wp = pov_win_pct(main["eval_cp"], main["mate_in"], side, "white") if has_eval else None
            return self._json({"eval": eval_text(main["eval_cp"], main["mate_in"], side),
                               "wp_white": round(wp, 1) if wp is not None else None,
                               "best_uci": best_uci, "best_san": best_san})
        if url.path == "/api/fetch_image":
            # the browser reads the board off a canvas, and a cross-origin image would taint it: fetch it server-side
            target = parse_qs(url.query).get("url", [""])[0]
            if not target.startswith(("http://", "https://")):
                return self._json({"error": "http(s) URL required"}, 400)
            try:
                resp = requests.get(target, timeout=20, headers={"User-Agent": USER_AGENT}, stream=True)
                resp.raise_for_status()
                ctype = resp.headers.get("Content-Type", "")
                if not ctype.startswith("image/"):
                    return self._json({"error": f"not an image ({ctype or 'unknown type'})"}, 415)
                body = resp.raw.read(MAX_IMAGE_BYTES + 1, decode_content=True)
            except requests.RequestException as e:
                return self._json({"error": str(e)}, 502)
            if len(body) > MAX_IMAGE_BYTES:
                return self._json({"error": "image larger than 10 MB"}, 413)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == "/api/engine":
            try:
                return self._json({"name": self.runner.explorer.name(), "nodes": self.runner.explorer.nodes, "multipv": MULTIPV_N})
            except Exception as e:  # noqa: BLE001
                return self._json({"error": str(e)}, 500)
        if url.path == "/api/update":
            self.updates.check(force=parse_qs(url.query).get("check", ["0"])[0] == "1")
            return self._json(self.updates.status())
        if url.path == "/api/eval_stream":
            q = parse_qs(url.query)
            fen = q.get("fen", [""])[0]
            try:
                multipv = max(1, min(5, int(q.get("multipv", ["3"])[0])))
            except ValueError:
                multipv = 3
            try:
                board = chess.Board(fen)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            return self._stream_eval(board, multipv)
        return super().do_GET()

    def _stream_eval(self, board: chess.Board, multipv: int) -> None:
        """NDJSON, one line per snapshot as the engine iterates, so the client can draw live-updating
        arrows instead of waiting for the final, settled result. This server speaks HTTP/1.0, so the body
        is simply delimited by the connection closing: no Content-Length and no chunked framing (browsers
        don't decode Transfer-Encoding on a 1.0 response and would hand the chunk sizes to the client)."""
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        gen = self.runner.explorer.analyse_stream(board, multipv)
        try:
            for snapshot in gen:
                self.wfile.write((json.dumps(snapshot) + "\n").encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass   # client moved on; closing the generator below stops the search rather than burning the node budget unwatched
        except Exception:  # noqa: BLE001
            log.error("eval_stream failed: %s", traceback.format_exc())
        finally:
            gen.close()

    def do_POST(self):
        r = self.runner
        path = urlparse(self.path).path
        if path == "/api/pgn":
            b = self._body()
            text = (b.get("pgn") or "").strip()
            if not text:
                return self._json({"error": "empty PGN"}, 400)
            review_as = b.get("review_as") or _side_of_saved_player(text)
            p = profiles.create("pgn", PGN_PROFILE_NAME)
            if r.busy() and r.job.profile.id == p.id:
                return self._json({"error": "busy", "job": r.job.to_dict()}, 409)
            digest = ingest.store_pgn(p, text, review_as)
            stored = (p.pgn_dir / f"{digest}.pgn").read_text(encoding="utf-8")
            slugs = [site.slug(row["game_id"]) for row, _ in normalise.parse_pgn_text(stored, p.username, digest)]
            if not slugs:
                return self._json({"error": "no standard game found in that PGN"}, 400)
            try:
                rebuild_profile(p)
            except Exception as e:  # noqa: BLE001
                log.error("pgn rebuild failed: %s", traceback.format_exc())
                return self._json({"error": str(e)}, 500)
            return self._json({"profile": p.summary(), "games": slugs})
        if path == "/api/profiles":
            b = self._body()
            source, username = b.get("source", "chesscom"), (b.get("username") or "").strip()
            if source != "chesscom":
                return self._json({"error": "only chess.com profiles can be added for now"}, 400)
            try:
                p = profiles.create(source, username)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            if (p.site_dir / "games.json").exists():
                return self._json({"profile": p.summary(), "job": None})   # already set up: just open it
            return self._start(Job("ingest", p))
        m = re.match(r"^/api/profiles/([A-Za-z0-9_.-]+)/seen$", path)
        if m:
            self.new_games.clear(m.group(1))
            return self._json({"ok": True})
        m = re.match(r"^/api/profiles/([A-Za-z0-9_.-]+)/games/([^/]+)/seen$", path)
        if m:
            profiles.mark_seen(m.group(1), m.group(2))
            return self._json({"ok": True})
        m = re.match(r"^/api/profiles/([A-Za-z0-9_.-]+)/pin$", path)
        if m:
            out = profiles.set_pinned(m.group(1), bool(self._body().get("pinned", True)))
            return self._json({"profile": out}) if out else self._json({"error": "unknown profile"}, 404)
        m = re.match(r"^/api/profiles/([A-Za-z0-9_.-]+)/delete$", path)
        if m:
            if r.busy() and r.job.profile.id == m.group(1):
                return self._json({"error": "busy", "job": r.job.to_dict()}, 409)
            return self._json({"ok": profiles.delete(m.group(1))})
        m = re.match(r"^/api/p/([A-Za-z0-9_.-]+)/(analyse_all|refresh|analyse/([^/]+))$", path)
        if m:
            p = profiles.load(m.group(1))
            if p is None:
                return self._json({"error": "unknown profile"}, 404)
            action = m.group(2)
            if action.startswith("analyse/"):
                slug = m.group(3)
                game_id = _game_id_for(p, slug)
                if game_id is None:
                    return self._json({"error": "unknown game"}, 404)
                return self._start(Job("analyse", p, game_id, slug))
            if action == "analyse_all":
                return self._start(Job("analyse_all", p))
            return self._start(Job("refresh", p, analyse=bool(self._body().get("analyse"))))
        if path.startswith("/api/explore"):
            b = self._body()
            try:
                return self._json(r.explorer.move(b["fen"], b["uci"], b.get("my_colour", "white"), int(b.get("ply", 0))))
            except (ValueError, KeyError) as e:
                return self._json({"error": str(e)}, 400)
            except Exception as e:  # noqa: BLE001
                log.error("explore failed: %s", traceback.format_exc())
                return self._json({"error": str(e)}, 500)
        if path.startswith("/api/stop"):
            if r.job:
                r.job.stop_requested = True
            return self._json({"ok": True})
        if path == "/api/update/download":
            self.updates.check()
            return self._json({"ok": self.updates.download(), **self.updates.status()})
        if path == "/api/update/apply":
            if r.busy():
                return self._json({"error": "busy", "job": r.job.to_dict()}, 409)
            try:
                self.updates.apply()
            except (RuntimeError, OSError) as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)


MAX_IMAGE_BYTES = 10 * 1024 * 1024
PGN_PROFILE_NAME = "Pasted games"   # every pasted PGN lands in profile pgn-pasted-games


def _side_of_saved_player(pgn: str) -> str:
    """Which side to review a pasted PGN from: the one played by a saved profile's username, else White."""
    mine = {p.username.lower() for p in profiles.list_profiles() if p.source != "pgn"}
    for side in ("White", "Black"):
        m = re.search(rf'(?m)^\[{side} "([^"]*)"\]', pgn)
        if m and m.group(1).strip().lower() in mine:
            return side.lower()
    return "white"


def rebuild_profile(p: Profile) -> None:
    """normalise -> site -> classify -> aggregates (no engine work); what a refresh does after fetching."""
    normalise.build(p)
    site.build(p)
    classify.build(p)
    aggregates.build(p)


def _game_id_for(profile: Profile, slug: str) -> Optional[str]:
    path = profile.site_dir / "games" / f"{slug}.json"
    if not path.exists() or "/" in slug or ".." in slug:
        return None
    return json.loads(path.read_text(encoding="utf-8"))["url"]


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="serve", description=__doc__)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8123)
    p.add_argument("--nodes", type=int, default=DEFAULT_NODES, help="nodes per position for on-demand analysis")
    p.add_argument("--workers", type=int, default=None, help="engine processes for game analysis (default: physical cores)")
    args = p.parse_args(argv)
    profiles.migrate_legacy()
    site.write_static()     # index.html is a pure copy of static/, so it is always current after a restart
    Handler.runner = Runner(args.nodes, args.workers)
    Handler.updates = updater.Updater()
    Handler.new_games = NewGames()
    Handler.new_games.start()

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
    log.info("serving %s (%d profiles) at http://%s:%d/", SITE_DIR, len(profiles.list_profiles()), args.host, args.port)

    def shutdown(signum, _frame):
        log.info("signal %d: shutting down", signum)
        Handler.runner.analyser.close()
        Handler.runner.explorer.close()
        sys.exit(0)

    if threading.current_thread() is threading.main_thread():   # the desktop launcher runs us off the main thread
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
