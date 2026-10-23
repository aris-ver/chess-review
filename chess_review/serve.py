"""Local server: static site + a tiny JSON API for on-demand work. Stdlib only.

    GET  /api/status                    {job (or null), queue: analyses waiting their turn, builds: the puzzle builds
                                        in order with their state (running, fetching, paused, waiting), finished:
                                        how the last build of each profile ended}
    GET  /api/profiles                  saved profiles with game counts; new_games per profile is what chess.com has
                                        that a refresh would fetch (scanned once per launch, in the background)
    POST /api/profiles/<id>/seen        the user has seen the new-games badge: drop it until the next scan
    GET  /api/profiles/<id>/unseen      games a refresh brought in that haven't been opened yet (flagged NEW in the list
                                        until opened, or until the launch after the list has shown them)
    POST /api/profiles/<id>/games/<game>/seen   the game was opened: drop its "new" flag in the list
    POST /api/profiles                  {source, username, puzzles?} -> create the profile and fetch its newest page of
                                        games (job "ingest"); puzzles=true makes its puzzles afterwards (a build, see
                                        below). The profile's `older` says whether the site has games before those
    POST /api/p/<id>/older              fetch the page of games before the oldest the profile has (job "older")
    POST /api/profiles/<id>/delete      remove a profile and everything under it (the engine cache is shared and stays)
    POST /api/profiles/<id>/pin         {pinned: bool} keep it at the top of the home screen
    POST /api/p/<id>/analyse/<slug>     analyse one game (MultiPV=3, fixed nodes), streaming progress into its JSON;
                                        queued behind another foreground job, ahead of a puzzle build
    POST /api/p/<id>/refresh            re-fetch the latest chess.com month, normalise, rebuild the site (games are
                                        analysed only when asked)
    POST /api/p/<id>/analyse_all        analyse every game that isn't fully analysed yet, newest first (no UI button;
                                        `python -m chess_review analyse` does the same from the CLI)
    POST /api/stop                      stop the running job (a puzzle build: for good, see build/stop)
    GET  /api/legal?fen=                legal moves in a position (for the board UI)
    POST /api/explore                   {fen, uci, my_colour} -> the move evaluated and classified on the spot
    POST /api/pgn                       {pgn, review_as?} -> stored in the "Pasted games" profile and reviewable at once
                                        (review_as defaults to the side a saved profile played, else white)
    GET  /api/engine                    {name, nodes, multipv} of the on-demand engine (shown next to results)
    GET  /api/fetch_image?url=          proxy an image so the board reader can inspect it on a canvas
    GET  /api/eval?fen=                 the engine's eval and best move in a position, no move required (sandbox), and its line in SAN (a puzzle's wrong move)
    GET  /api/update[?check=1]          installed version, the latest release if newer, download progress (desktop
                                        build only; check=1 asks GitHub again instead of using the hourly cache)
    POST /api/update/download           fetch the latest release into DATA/update (the small zip when it fits)
    POST /api/update/apply              swap the downloaded update in and restart the app (refused while a job runs)
    GET  /api/settings                  the page's saved preferences (volume, theme, ...): {key: string}
    POST /api/settings                  {key: string | null} -> merged into DATA/settings.json (null removes the key)
    GET  /api/puzzles/next[?themes=a,b&skip=id]   a puzzle near your puzzle rating, not tried before -> {puzzle, stats}
    GET  /api/puzzles/next?source=mine:<profile>[&skip=id]   from that profile's games: a review that is due, else a
                                        new one -> {puzzle, stats}; 404 {error, stats} when there is neither
    GET  /api/puzzles/get?id=           one puzzle by id, Lichess or your games (a reload, or Back to it) -> {puzzle, stats}
    GET  /api/puzzles/themes            the pack's themes with readable names and counts, and your stats
    GET  /api/puzzles/packs             every puzzle pack's progress (packs.py), your stats and today's daily
    GET  /api/puzzles/pack?id=          one pack's stages, which are open, and the state of every puzzle in them
    GET  /api/puzzles/daily             the puzzle of the day {date, n, id, result (once played), streak, best_streak}
    GET  /api/puzzles/sources          what the trainer can deal from: the Lichess pack, and each profile with games
                                        (its puzzle stats, games and how many are analysed). This and
                                        next?source=mine: start job "puzzles" in the background when a profile's
                                        puzzles still wait for the engine to settle their lines; any other job
                                        takes over from it
    POST /api/puzzles/attempt           {id, solved, ms?, hinted?} -> a Lichess puzzle's first try recorded {stats, counted};
                                        a puzzle from your games: every showing recorded {stats, review}
    POST /api/puzzles/solved            {id} -> a Lichess puzzle solved after a miss or a hint (its pack counts it)
    POST /api/puzzles/daily             {id, solved, clean, ms, marks} -> today's first showing, kept once -> as GET
    POST /api/puzzles/build             {profile} -> make its puzzles in the background (job "build": analyse the
                                        games not analysed yet, newest first, reclassifying as it goes so puzzles
                                        appear game by game, then settle their lines) -> status
    POST /api/puzzles/build/stop        {profile} -> stop making them (what is analysed stays) -> status
    POST /api/puzzles/reset             {what: "rating"} -> the Lichess puzzle rating starts over at 1500: the record
                                        is moved to puzzle_attempts.reset-<when>.jsonl (rename it back to undo);
                                        puzzles tried before still aren't dealt again
                                        {what: "schedule", profile} -> that profile's review schedule starts over (its
                                        record archived the same way): every puzzle from its games is new again
    POST /api/sync/<step>               the Blundr account's sync: state, delta, commit, switch, release (sync.py)
    /account/...                        the Blundr account: passed on to blundr.gr with this app's session token
                                        (account.py; on the website the page reaches the Worker itself)

    /                                   the app (data/site)
    /p/<id>/...                         a profile's games.json, games/<slug>.json, insights.html

One job at a time: analysis uses every core. The DuckDB write lock is held only
while a job runs, so the CLI stages still work in between. A puzzle build can run for hours, so it never makes
the user wait: whatever they ask for (analyse a game, refresh, add a profile) stops it at the next position and
gets every core, and the build carries on where it was once that is done (Runner). Builds still to do are kept
in DATA/puzzle_builds.json and carry on after a restart.
"""

import argparse
import collections
import datetime
import functools
import itertools
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
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

import chess
import duckdb
import requests

from . import account, aggregates, book, classify, ingest, migrate_sqlite, normalise, own_puzzles, packs, profiles, puzzles, site, sync, updater
from .analyse import Analyser, LivePace, export_parquet, open_db, pending_keys
from .config import DATA, DEFAULT_NODES, ENGINE_IDLE_SECONDS, MULTIPV_N, SITE_DIR, USER_AGENT
from .db import base_views
from .explore import Explorer
from .pov import pov_win_pct
from .profiles import Profile
from .site import eval_text

log = logging.getLogger("serve")
_PROFILE_PATH = re.compile(r"^/p/([A-Za-z0-9_.-]+)/(.*)$")


_job_ids = itertools.count(1)


class Job:
    def __init__(self, kind: str, profile: Profile, game_id: Optional[str] = None, slug: Optional[str] = None):
        self.id = next(_job_ids)
        self.kind, self.profile, self.game_id, self.slug = kind, profile, game_id, slug
        self.status = "queued"          # queued | running | finishing | done | error | stopped
        self.done, self.total = 0, 0
        self.error: Optional[str] = None
        self.started = time.time()
        self.stop_requested = False
        self.preempted = False          # stopped to make way for another job: it comes back once that one is done

        self.game_done, self.game_total = 0, 0   # analyse_all: position progress within the current game
        self.phase: Optional[str] = None         # build: "analysing" (done/total count games) or "lines" (puzzles)
        self.puzzles: Optional[int] = None       # build: puzzles the profile has so far
        self.note: Optional[str] = None          # a fetch waiting out a site's "slow down", said while it waits

    def to_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "profile": self.profile.id, "username": self.profile.username,
                "game": self.slug, "status": self.status,
                "done": self.done, "total": self.total, "game_done": self.game_done, "game_total": self.game_total,
                "error": self.error, "elapsed": round(time.time() - self.started, 1),
                "phase": self.phase, "puzzles": self.puzzles, "note": self.note}


BACKGROUND = ("puzzles", "build")    # jobs that give way to anything the user asks for
FETCHES = ("ingest", "refresh", "older")    # a profile's games: a new profile's first page, what's new, a page back
LIVE_WRITE_S = 0.3                   # a game analysed on demand: its review is rewritten at most this often
PUZZLE_REFRESH_S = 20                # a build reclassifies the profile (its puzzles) at most this often, after a game


def live_order(con, game_id: str, keys: list[str]) -> list[str]:
    """A game's pending positions in the order its review on screen wants them: game order, so it fills in from the
    first move, but with the positions book moves are played from last. A book move is labelled book whatever the
    engine says and the page shows it at once, so the engines start where the game leaves the book (on the position
    the first move out of it is played from) and the book's evals, wanted only for the graph, come in at the end."""
    plies = [r[0] for r in con.execute("SELECT fen_key FROM positions WHERE game_id = ? ORDER BY ply", [game_id]).fetchall()]
    order: dict[str, int] = {}
    for i, k in enumerate(plies):
        if k not in order:
            order[k] = i
    # position i is played from by move i, a book move when the position after it is in book
    later = {k for i, k in enumerate(plies[:-1]) if book.is_book(plies[i + 1])}
    return sorted(keys, key=lambda k: (k in later, order.get(k, 1 << 30)))


class Runner:
    """One job at a time, since analysis uses every core. What the user asks for comes first: a background job
    (a puzzle build, or settling puzzle lines) is stopped at the next position to make way, and a build picks up
    where it was once the way is clear. An analysis asked for while another foreground job runs waits its turn
    in `queue` instead of being refused."""

    def __init__(self, nodes: int, workers: Optional[int] = None, builds_file: Optional[Path] = None):
        self.analyser = Analyser(workers=workers, nodes=nodes)
        self.explorer = Explorer(nodes=nodes, threads=workers)
        self.job: Optional[Job] = None
        self.thread: Optional[threading.Thread] = None
        self.lock = threading.RLock()
        self._lines_tried: dict[str, float] = {}     # profile -> moves.parquet stamp the puzzles job last ran for
        self.queue: list[Job] = []                   # analyses waiting for the running foreground job
        self.builds_file = builds_file               # the builds still to do, so they carry on after a restart
        self.builds: list[str] = self._load_builds()  # profiles whose puzzles are being made, the current one first
        self.build_state: dict[str, dict] = {}       # profile -> its build's last progress (shown while it waits)
        self.finished: dict[str, dict] = {}          # profile -> how its last build ended (done or error)
        # jobs just ended: a build takes over the moment an analysis ends, and the page still learns how that went
        self.recent: collections.deque = collections.deque(maxlen=8)

    def busy(self) -> bool:
        return self.job is not None and self.job.status in ("queued", "running", "finishing")

    def _load_builds(self) -> list[str]:
        try:
            ids = json.loads(self.builds_file.read_text(encoding="utf-8")) if self.builds_file else []
            return [i for i in ids if isinstance(i, str)]
        except (OSError, ValueError):
            return []

    def _save_builds(self) -> None:
        if self.builds_file is None:
            return
        try:
            self.builds_file.parent.mkdir(parents=True, exist_ok=True)
            self.builds_file.write_text(json.dumps(self.builds), encoding="utf-8")
        except OSError as e:
            log.warning("could not save the puzzle builds: %s", e)

    def reap_idle(self) -> None:
        """Free engine memory when nothing has used the engines for a while."""
        now = time.time()
        if not self.busy() and self.analyser._pool is not None and now - self.analyser.last_used > ENGINE_IDLE_SECONDS:
            log.info("idle: shutting down the analysis pool")
            self.analyser.close()
        if self.explorer._engine is not None and now - self.explorer.last_used > ENGINE_IDLE_SECONDS and not self.explorer._lock.locked():
            log.info("idle: shutting down the exploration engine")
            self.explorer.close()

    def start(self, job: Job, then_build: bool = False) -> Optional[Job]:
        """Start `job`, or queue it: the job that will do the work (`job`, or the same analysis already running or
        queued), None when another foreground job runs and this one can't wait for it. A background job gives way:
        it is asked to stop and the new job starts once it has. then_build: make the profile's puzzles afterwards
        (a profile added from the Personal puzzles screen)."""
        with self.lock:
            out = self._start(job)
            if out is not None and then_build and job.profile.id not in self.builds:
                self.builds.append(job.profile.id)
                self._save_builds()
            return out

    def _start(self, job: Job) -> Optional[Job]:
        before = None
        if self.busy():
            cur = self.job
            if cur.kind in BACKGROUND and (job.kind not in BACKGROUND or (job.kind == "build" and cur.kind == "puzzles")):
                cur.stop_requested = cur.preempted = True
                before = self.thread
            elif job.kind in FETCHES and cur.kind == job.kind and cur.profile.id == job.profile.id:
                return cur      # asked again (the page redrawn by an account sync, say): the fetch under way
            elif job.kind == "analyse":
                same = next((j for j in [cur, *self.queue] if j.kind == "analyse" and j.profile.id == job.profile.id
                             and j.game_id == job.game_id), None)
                if same is not None:
                    return same
                self.queue.append(job)
                return job
            else:
                return None
        self.job = job
        self.thread = self._spawn(job, before)
        return job

    def _spawn(self, job: Job, before):
        """Run the job off the request thread, once `before` (the job giving way to it) has ended."""
        t = threading.Thread(target=self._run, args=(job, before), daemon=True)
        t.start()
        return t

    def _kick(self) -> None:
        """Start what waits once the way is clear: a queued analysis first, then the next puzzle build (which also
        takes over from a puzzles job settling lines)."""
        with self.lock:
            if self.busy() and self.job.kind != "puzzles":
                return
            if self.queue and not self.busy():
                self._start(self.queue.pop(0))
                return
            while self.builds:
                p = profiles.load(self.builds[0])
                if p is not None and (p.site_dir / "games.json").exists():
                    self._start(Job("build", p))
                    return
                self.builds.pop(0)          # removed, or its games never came (an unknown username)
                self._save_builds()

    def request_build(self, profile: Profile) -> None:
        """Make the profile's puzzles in the background: analyse its games, newest first, then settle the lines."""
        with self.lock:
            self.finished.pop(profile.id, None)
            if profile.id not in self.builds:
                self.builds.append(profile.id)
                self._save_builds()
            self._kick()

    def cancel_build(self, pid: str) -> bool:
        """Stop making the profile's puzzles (what is analysed so far stays, and its puzzles with it)."""
        with self.lock:
            had = pid in self.builds
            if had:
                self.builds.remove(pid)
                self._save_builds()
            self.build_state.pop(pid, None)
            if self.busy() and self.job.kind == "build" and self.job.profile.id == pid:
                self.job.stop_requested, self.job.preempted = True, False
                had = True
            return had

    def builds_status(self) -> list[dict]:
        """The builds for the bottom bar, in order: running, fetching (the profile's games), paused (another job has
        the engines), waiting (its turn hasn't come)."""
        with self.lock:
            out = []
            for i, pid in enumerate(self.builds):
                cur = self.job if self.busy() else None
                if cur is not None and cur.profile.id == pid and cur.kind in ("build", "ingest"):
                    d = cur.to_dict()
                    d["state"] = "running" if cur.kind == "build" else "fetching"
                    if cur.kind == "ingest":
                        d["phase"] = "fetching"
                else:
                    d = dict(self.build_state.get(pid) or {"profile": pid, "phase": None, "done": 0, "total": 0, "puzzles": None})
                    d["state"] = "paused" if i == 0 and cur is not None else "waiting"
                    d["game"] = None
                p = profiles.load(pid)
                d["username"] = p.username if p else pid
                out.append(d)
            return out

    def status(self) -> dict:
        with self.lock:
            return {"job": self.job.to_dict() if self.job else None, "queue": [j.to_dict() for j in self.queue],
                    "recent": list(self.recent), "builds": self.builds_status(), "finished": list(self.finished.values())}

    def extend_puzzles(self, profile: Profile) -> None:
        """Start the puzzles job for `profile` if some of its puzzles wait for engine lines. Once per change of its
        classified moves, so a job that can't finish (the engine cache locked by the CLI) isn't retried each request."""
        try:
            stamp = profile.moves_parquet.stat().st_mtime
        except OSError:
            return
        if self.busy() or self.builds or self._lines_tried.get(profile.id) == stamp or not own_puzzles.POOL.waiting(profile):
            return
        self.start(Job("puzzles", profile))

    def _puzzles(self, job: Job) -> None:
        """Settle the lines of the profile's own-game puzzles: MultiPV searches of the positions they wait on, a ply
        at a time, into the shared cache (own_puzzles.extend)."""
        p = job.profile
        self._lines_tried[p.id] = p.moves_parquet.stat().st_mtime
        con = open_db()
        base_views(con, p)
        try:
            def progress(done: int, total: int) -> None:
                job.done, job.total = done, total

            def search(keys: list[str]) -> None:
                self.analyser.run(keys, con, batch=self.analyser.workers * 2, should_stop=lambda: job.stop_requested)
                own_puzzles.POOL.invalidate(p.id)

            stats = own_puzzles.extend(con, search, should_stop=lambda: job.stop_requested, on_progress=progress)
            log.info("puzzle lines %s: %s", p.id, stats)
            if job.stop_requested:
                self._lines_tried.pop(p.id, None)     # given way to another job: try again later
            else:
                job.status = "finishing"
                export_parquet(con)
        finally:
            con.close()
            own_puzzles.POOL.invalidate(p.id)

    def _run(self, job: Job, before: Optional[threading.Thread] = None) -> None:
        if before is not None:
            before.join()
        try:
            self._do(job)
        finally:
            self._ended(job)

    def _ended(self, job: Job) -> None:
        self.recent.append(job.to_dict())
        if job.kind == "build":
            self._build_ended(job)
        if self.job is job:
            self._kick()

    def _build_ended(self, job: Job) -> None:
        pid = job.profile.id
        with self.lock:
            if job.preempted and job.status == "stopped":
                self.build_state[pid] = {**job.to_dict(), "status": "paused"}
                return
            if pid in self.builds:          # done, failed, or stopped by the user: it doesn't come back by itself
                self.builds.remove(pid)
                self._save_builds()
            self.build_state.pop(pid, None)
            if job.status in ("done", "error"):
                self.finished[pid] = {**job.to_dict(), "username": job.profile.username, "ended": time.time()}

    def _do(self, job: Job) -> None:
        try:
            job.status = "running"
            self._work(job)
            job.status = "stopped" if job.stop_requested else "done"
        except Exception as e:  # noqa: BLE001 - surfaced to the UI
            self._failed(job, e)

    def _work(self, job: Job) -> None:
        if job.kind == "puzzles":
            self._puzzles(job)
        elif job.kind == "build":
            self._build(job)
        elif job.kind == "analyse":
            self._analyse(job)
        elif job.kind == "analyse_all":
            self._analyse_all(job)
        elif job.kind == "ingest":
            self._ingest(job)
        elif job.kind == "older":
            self._older(job)
        else:
            self._refresh(job)

    def _failed(self, job: Job, e: Exception) -> None:
        log.error("job failed: %s", traceback.format_exc())
        job.status, job.error = "error", str(e)
        if job.kind == "ingest" and isinstance(e, ingest.NoSuchPlayer) and not (job.profile.site_dir / "games.json").exists():
            # a typo shouldn't linger on the home screen. Any other failure (offline, a timeout) keeps the profile:
            # opening it fetches again, and deleting it would take it off the account too (sync.py)
            profiles.delete(job.profile.id)

    def _analyse(self, job: Job) -> None:
        p = job.profile
        con = open_db()
        base_views(con, p)
        try:
            keys, stats = pending_keys(con, p, job.game_id)
            job.total = len(keys)
            log.info("analyse %s/%s: %s", p.id, job.slug, stats)
            keys = live_order(con, job.game_id, keys)

            def progress(done: int, _total: int) -> None:
                job.done = done
                site.update_index(p, site.write_game(con, p, job.game_id))

            # the review is on screen, following the analysis: rewritten as results come in, not in batches
            self.analyser.run(keys, con, on_progress=progress, batch=self.analyser.workers, should_stop=lambda: job.stop_requested,
                              live=LivePace(LIVE_WRITE_S))
            job.status = "finishing"
            site.update_index(p, site.write_game(con, p, job.game_id))
            export_parquet(con)
        finally:
            con.close()
        # keep moves.parquet and the insights page current (cheap, no engine)
        classify.build(p)
        aggregates.build(p)

    @staticmethod
    def _todo(con, p: Profile) -> tuple[int, list[tuple[str, list[str]]]]:
        """(games, the ones not fully analysed with their pending positions), newest first. One query for all of
        them (pending_keys per game took seconds for a few dozen games, and a build lists them at every resume)."""
        games = [r[0] for r in con.execute("SELECT game_id FROM games ORDER BY played_at DESC").fetchall()]
        pending = dict(con.execute("""
            WITH k AS (SELECT DISTINCT game_id, fen_key FROM positions)
            SELECT k.game_id, list(k.fen_key) FROM k
            LEFT JOIN evals e USING (fen_key)
            LEFT JOIN (SELECT DISTINCT fen_key FROM evals_multipv) m USING (fen_key)
            WHERE e.fen_key IS NULL OR m.fen_key IS NULL
            GROUP BY 1
        """).fetchall())
        return len(games), [(gid, list(pending[gid])) for gid in games if gid in pending]

    def _analyse_game(self, job: Job, con, gid: str, keys: list[str]) -> None:
        """One game of a batch, its positions in game order, then its review page."""
        p = job.profile
        job.slug, job.game_done, job.game_total = site.slug(gid), 0, len(keys)
        order = {r[0]: i for i, r in enumerate(con.execute(
            "SELECT fen_key, min(ply) FROM positions WHERE game_id = ? GROUP BY 1 ORDER BY 2", [gid]).fetchall())}
        keys.sort(key=lambda k: order.get(k, 1 << 30))

        def progress(done: int, _total: int) -> None:
            job.game_done = done

        self.analyser.run(keys, con, on_progress=progress, batch=self.analyser.workers * 2,
                          should_stop=lambda: job.stop_requested)
        site.update_index(p, site.write_game(con, p, gid))

    def _analyse_all(self, job: Job) -> None:
        p = job.profile
        job.kind, job.done, job.total = "analyse_all", 0, 0
        con = open_db()
        base_views(con, p)
        try:
            _, todo = self._todo(con, p)
            job.total = len(todo)
            log.info("analyse_all %s: %d games need work", p.id, len(todo))
            for gid, keys in todo:
                if job.stop_requested:
                    break
                self._analyse_game(job, con, gid, keys)
                job.done += 1
                log.info("analyse_all: %d/%d games done (%s)", job.done, job.total, job.slug)
            job.status = "finishing"
            export_parquet(con)
        finally:
            con.close()
        classify.build(p)
        aggregates.build(p)

    def _build(self, job: Job) -> None:
        """Make a profile's puzzles: analyse the games that aren't yet, newest first, reclassifying after each
        game (at most every PUZZLE_REFRESH_S) so its puzzles can be played while the rest are analysed; then
        settle their lines (_puzzles). done/total count the profile's games, all of them, analysed or not.
        Stopped to make way for another job, it skips the bookkeeping: it comes back and does it then."""
        p = job.profile
        job.phase = "analysing"
        job.puzzles = (self.build_state.get(p.id) or {}).get("puzzles")
        if job.puzzles is None:
            job.puzzles = len(own_puzzles.POOL.puzzles(p))      # the ones its analysed games already have
        con = _open_db_retry()
        base_views(con, p)
        try:
            n, todo = self._todo(con, p)
            job.total, job.done = n, n - len(todo)
            log.info("build %s: %d of %d games to analyse", p.id, len(todo), n)
            last = 0.0
            for gid, keys in todo:
                if job.stop_requested:
                    break
                self._analyse_game(job, con, gid, keys)
                if job.stop_requested:
                    break               # cut short: not done (what it searched is cached)
                job.done += 1
                if time.time() - last >= PUZZLE_REFRESH_S:
                    con.close()         # classify reads the live cache, which this write connection would lock
                    self._refresh_puzzles(job)
                    last = time.time()
                    con = _open_db_retry()
                    base_views(con, p)
            job.slug = None
            if not job.preempted:
                export_parquet(con)
        finally:
            con.close()
        if job.preempted:
            return
        self._refresh_puzzles(job)
        aggregates.build(p)
        if job.stop_requested:
            return
        job.phase, job.done, job.total = "lines", 0, 0
        self._puzzles(job)

    def _refresh_puzzles(self, job: Job) -> None:
        p = job.profile
        classify.build(p)
        own_puzzles.POOL.invalidate(p.id)
        job.puzzles = len(own_puzzles.POOL.puzzles(p))
        self.build_state[p.id] = job.to_dict()

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
        """New profile: fetch its newest page of games, then build its site. done/total count the page's games
        while fetching."""
        self._ingested(job, ingest.fetch(job.profile, on_progress=self._fetching(job), on_wait=self._waiting(job)))

    def _older(self, job: Job) -> None:
        """The page of games before the oldest the profile has ("Load older games"), then its site again."""
        self._ingested(job, ingest.fetch(job.profile, older=True, on_progress=self._fetching(job),
                                         on_wait=self._waiting(job)))

    @staticmethod
    def _fetching(job: Job):
        def progress(done: int, total: int) -> None:
            job.done, job.total = done, total + 3
        return progress

    @staticmethod
    def _waiting(job: Job):
        def note(text: Optional[str]) -> None:
            job.note = text
        return note

    def _ingested(self, job: Job, stats: dict) -> None:
        p = job.profile
        log.info("ingest %s: %s", p.id, stats)
        Handler.new_games.clear(p.id)
        job.total = max(job.total, 3)
        job.done = job.total - 3
        self._rebuild(job)

    def _refresh(self, job: Job) -> None:
        job.total = 4
        had = job.profile.game_ids()
        self._refreshed(job, had, ingest.fetch(job.profile, refresh=True, on_wait=self._waiting(job)))

    def _refreshed(self, job: Job, had: set, stats: dict) -> None:
        p = job.profile
        log.info("refresh %s: %s", p.id, stats)
        Handler.new_games.clear(p.id)
        job.done = 1
        self._rebuild(job)
        profiles.add_unseen(p.id, p.game_ids() - had)     # what the refresh brought in: flagged in the list until opened


def _open_db_retry(tries: int = 20):
    """The engine cache for writing. A request thread may hold it read-only for a moment (DuckDB won't open one
    file both ways in one process), so a build that reopens it after each game waits for that instead of failing."""
    for i in range(tries):
        try:
            return open_db()
        except duckdb.Error:
            if i == tries - 1:
                raise
            time.sleep(0.25)


class NewGames:
    """Once per launch, in the background: for each chess.com or lichess profile, how many games the site has that aren't
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
            if p.source not in ("chesscom", "lichess") or not p.raw_dir.exists():
                continue
            try:
                n = ingest.count_new(p)
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
    # the theme files, whatever the Windows registry says about these extensions
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".svg": "image/svg+xml", ".webp": "image/webp",
                      ".mp3": "audio/mpeg", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json"}

    def end_headers(self):
        # themes (pieces, boards, sounds) may be cached and revalidated: no-store would refetch every piece image
        self.send_header("Cache-Control", "no-cache" if self.path.startswith("/themes/") else "no-store")
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

    def _start(self, job: Job, then_build: bool = False) -> None:
        out = self.runner.start(job, then_build)
        if out is None:
            return self._json({"error": "busy", "job": self.runner.job.to_dict()}, 409)
        return self._json({"job": out.to_dict()})

    def _account(self, method: str) -> None:
        """account/* (account.py). Only from the app's own page: on this port, by its own address (no other site's
        page, nor one that DNS-rebinds a name of its own to 127.0.0.1, can act for the account)."""
        url = urlparse(self.path)
        port = self.server.server_address[1]
        ours = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("Origin")
        if self.headers.get("Host") not in ours or (origin and origin.split("://", 1)[-1] not in ours):
            return self._json({"error": "cross-site request"}, 403)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if method == "POST" else None
        try:
            code, ctype, out = account.handle(method, url.path, url.query, body, port)
        except requests.RequestException as e:
            log.info("account %s: %s", url.path, e)
            return self._json({"error": "Blundr can't be reached. Check the internet connection and try again."}, 502)
        except (ValueError, KeyError) as e:
            return self._json({"error": f"bad account request: {e}"}, 400)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/account/"):
            return self._account("GET")
        if url.path == "/api/status":
            return self._json(self.runner.status())
        if url.path == "/api/profiles":
            out = []
            for p in profiles.list_profiles():
                out.append({**p.summary(), "new_games": self.new_games.counts.get(p.id, 0)})
            return self._json({"profiles": out, "scan": self.new_games.state})
        m = re.match(r"^/api/profiles/([A-Za-z0-9_.-]+)/unseen$", url.path)
        if m:
            p = profiles.load(m.group(1))
            unseen = p.summary()["unseen"] if p else []
            profiles.mark_shown(m.group(1), unseen)     # the list is about to show them: flags come off at the next launch
            return self._json({"unseen": unseen})
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
            pv_san, b = [], board.copy(stack=False)     # the line, for a puzzle's "why not" (a few moves)
            for u in (main.get("pv") or [])[:6]:
                try:
                    mv = chess.Move.from_uci(u)
                    pv_san.append(b.san(mv))
                    b.push(mv)
                except (ValueError, AssertionError):
                    break
            return self._json({"eval": eval_text(main["eval_cp"], main["mate_in"], side),
                               "wp_white": round(wp, 1) if wp is not None else None,
                               "best_uci": best_uci, "best_san": best_san, "pv_san": pv_san,
                               "mate_in": main["mate_in"], "eval_cp": main["eval_cp"]})
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
        if url.path == "/api/settings":
            return self._json(load_settings())
        if url.path.startswith("/api/puzzles/"):
            return self._puzzles_get(url.path[len("/api/puzzles/"):], parse_qs(url.query))
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

    def _puzzles_get(self, what: str, q: dict) -> None:
        pack = puzzles.PACK_INSTANCE
        if what == "themes":
            return self._json({"themes": pack.themes(), "total": len(pack.rows()), "stats": puzzles.stats(puzzles.attempts())})
        if what == "sources":
            out = [{"id": "lichess", "name": "Lichess puzzles", "count": len(pack.rows())}]
            for p in profiles.list_profiles():
                s = p.summary()
                if not s["games"]:
                    continue
                st = own_puzzles.summary(p)
                out.append({"id": f"mine:{p.id}", "profile": p.id, "name": p.username, "source": p.source,
                            "count": st["total"], "stats": st, "games": s["games"], "analysed": s["analysed"]})
                if st["total"]:
                    self.runner.extend_puzzles(p)
            return self._json({"sources": out})
        if what == "next":
            source = q.get("source", ["lichess"])[0]
            if source.startswith("mine:"):
                prof = profiles.load(source[5:])
                if prof is None:
                    return self._json({"error": "unknown profile"}, 404)
                p, st = own_puzzles.next_puzzle(prof, q.get("skip", [None])[0])
                self.runner.extend_puzzles(prof)
                if p is None:
                    msg = "no puzzles from these games yet: analyse some games first" if not st["total"] else "all caught up with your games"
                    return self._json({"error": msg, "stats": st}, 404)
                return self._json({"puzzle": p, "stats": st})
            themes = {t for t in q.get("themes", [""])[0].split(",") if t}
            p, st = puzzles.next_puzzle(themes or None, q.get("skip", [None])[0])
            if p is None:
                return self._json({"error": "no puzzles left with those themes", "stats": st}, 404)
            return self._json({"puzzle": p, "stats": st})
        if what == "packs":
            st = puzzles.stats(puzzles.attempts())
            return self._json({"packs": packs.shelf(st), "stats": st, "daily": packs.daily(datetime.date.today())})
        if what == "pack":
            p = packs.INSTANCE.get(q.get("id", [""])[0])
            if p is None:
                return self._json({"error": "unknown pack"}, 404)
            st = puzzles.stats(puzzles.attempts())
            ratings = {i: (pack.get(i) or {}).get("rating") for s in p["stages"] for i in s["ids"]}
            first, later = packs.first_tries(), packs.solved_later()
            return self._json({"pack": packs.ladder(p, first, later, st, ratings, packs.credit(p, first, later)), "stats": st})
        if what == "daily":
            return self._json(packs.daily(datetime.date.today()))
        if what == "get":
            pid = q.get("id", [""])[0]
            if own_puzzles.is_own_id(pid):
                p = own_puzzles.POOL.find(pid)
                if p is None:
                    return self._json({"error": "unknown puzzle"}, 404)
                return self._json({"puzzle": p, "stats": own_puzzles.summary(profiles.load(p["profile"]))})
            row = pack.get(pid)
            if row is None:
                return self._json({"error": "unknown puzzle"}, 404)
            return self._json({"puzzle": puzzles.line(row), "stats": puzzles.stats(puzzles.attempts())})
        return self._json({"error": "not found"}, 404)

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
        if path.startswith("/account/"):
            return self._account("POST")
        if path.startswith("/api/sync/"):
            try:
                out = sync.handle(path, self._body())
            except ValueError:
                out = None
            return self._json(out if out is not None else {"error": "bad sync request"}, 200 if out is not None else 400)
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
            if source not in ("chesscom", "lichess"):
                return self._json({"error": "profiles come from chess.com or lichess"}, 400)
            try:
                p = profiles.create(source, username)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            want = bool(b.get("puzzles"))     # from Personal puzzles: make its puzzles once its games are in
            if (p.site_dir / "games.json").exists():
                if want:
                    r.request_build(p)
                return self._json({"profile": p.summary(), "job": None})   # already set up: just open it
            return self._start(Job("ingest", p), then_build=want)
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
            r.cancel_build(m.group(1))
            return self._json({"ok": profiles.delete(m.group(1))})
        m = re.match(r"^/api/p/([A-Za-z0-9_.-]+)/(analyse_all|refresh|older|analyse/([^/]+))$", path)
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
            return self._start(Job(action, p))
        if path.startswith("/api/explore"):
            b = self._body()
            try:
                return self._json(r.explorer.move(b["fen"], b["uci"], b.get("my_colour", "white"), int(b.get("ply", 0)),
                                                  b.get("ratings") or {}))
            except (ValueError, KeyError) as e:
                return self._json({"error": str(e)}, 400)
            except Exception as e:  # noqa: BLE001
                log.error("explore failed: %s", traceback.format_exc())
                return self._json({"error": str(e)}, 500)
        if path.startswith("/api/stop"):
            if r.job and r.job.kind == "build":
                r.cancel_build(r.job.profile.id)
            elif r.job:
                r.job.stop_requested = True
            return self._json({"ok": True})
        if path == "/api/puzzles/build" or path == "/api/puzzles/build/stop":
            p = profiles.load(str(self._body().get("profile", "")))
            if p is None:
                return self._json({"error": "unknown profile"}, 404)
            if path.endswith("/stop"):
                r.cancel_build(p.id)
            else:
                r.request_build(p)
            return self._json(r.status())
        if path == "/api/puzzles/reset":
            b = self._body()
            if b.get("what") == "rating":
                moved = puzzles.reset()
                return self._json({"archived": moved.name if moved else None, "stats": puzzles.stats(puzzles.attempts())})
            if b.get("what") == "schedule":
                p = profiles.load(str(b.get("profile", "")))
                if p is None:
                    return self._json({"error": "unknown profile"}, 404)
                moved = own_puzzles.reset(p)
                return self._json({"archived": moved.name if moved else None, "stats": own_puzzles.summary(p)})
            return self._json({"error": "what: rating or schedule"}, 400)
        if path == "/api/settings":
            b = self._body()
            if not isinstance(b, dict) or not all(v is None or isinstance(v, str) for v in b.values()):
                return self._json({"error": "{key: string | null} expected"}, 400)
            save_settings(b)
            return self._json({"ok": True})
        if path == "/api/puzzles/attempt":
            b = self._body()
            pid, ms = str(b.get("id", "")), b.get("ms")
            ms = int(ms) if isinstance(ms, (int, float)) else None
            if own_puzzles.is_own_id(pid):
                p = own_puzzles.POOL.find(pid)
                if p is None:
                    return self._json({"error": "unknown puzzle"}, 404)
                return self._json(own_puzzles.record(profiles.load(p["profile"]), pid, bool(b.get("solved")), ms, bool(b.get("hinted"))))
            row = puzzles.PACK_INSTANCE.get(pid)
            if row is None:
                return self._json({"error": "unknown puzzle"}, 404)
            st = puzzles.record(row["id"], row["rating"], bool(b.get("solved")), ms, bool(b.get("hinted")))
            return self._json({"stats": st or puzzles.stats(puzzles.attempts()), "counted": st is not None})
        if path == "/api/puzzles/solved":
            pid = str(self._body().get("id", ""))
            if puzzles.PACK_INSTANCE.get(pid) is None:
                return self._json({"error": "unknown puzzle"}, 404)
            packs.mark_solved(pid)
            return self._json({"ok": True})
        if path == "/api/puzzles/daily":
            b = self._body()
            ms = b.get("ms")
            return self._json(packs.record_daily(datetime.date.today(), str(b.get("id", "")), bool(b.get("solved")),
                                                 bool(b.get("clean")), int(ms) if isinstance(ms, (int, float)) else None,
                                                 b.get("marks") if isinstance(b.get("marks"), list) else []))
        if path == "/api/update/download":
            self.updates.check()
            return self._json({"ok": self.updates.download(), **self.updates.status()})
        if path == "/api/update/apply":
            if r.busy() and r.job.kind not in BACKGROUND:     # these just carry on after the restart
                return self._json({"error": "busy", "job": r.job.to_dict()}, 409)
            try:
                self.updates.apply()
            except (RuntimeError, OSError) as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)


MAX_IMAGE_BYTES = 10 * 1024 * 1024
PGN_PROFILE_NAME = "Pasted games"   # every pasted PGN lands in profile pgn-pasted-games

# The page's preferences live here rather than only in localStorage: localStorage belongs to the origin, and the
# desktop app's port changes whenever 8123 is taken, which handed the page an empty one and lost every setting.
SETTINGS_FILE = DATA / "settings.json"
_settings_lock = threading.Lock()


def load_settings() -> dict:
    try:
        d = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(changes: dict) -> None:
    with _settings_lock:
        d = load_settings()
        for k, v in changes.items():
            if v is None:
                d.pop(k, None)
            else:
                d[k] = v
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(d, indent=1, sort_keys=True), encoding="utf-8")
        tmp.replace(SETTINGS_FILE)


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
    migrate_sqlite.on_start()   # the JS port's SQLite files, once: off unless the bridge release switches it on
    profiles.expire_shown()  # "new" flags the list displayed in an earlier run: seen
    site.write_static()     # index.html is a pure copy of static/, so it is always current after a restart
    Handler.runner = Runner(args.nodes, args.workers, builds_file=DATA / "puzzle_builds.json")
    Handler.runner._kick()      # a puzzle build the last run didn't finish carries on
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
    # the opening book takes seconds to read, and a review wants it before its engines start (live_order)
    threading.Thread(target=book.load, daemon=True).start()
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
