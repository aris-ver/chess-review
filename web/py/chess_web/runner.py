"""serve.Runner for the browser: jobs are asyncio tasks instead of threads, and the engine pool is Stockfish WASM
in Web Workers (web/engines.js) instead of a process pool. Pyodide has neither threads nor subprocesses.

A search is awaited, so the worker keeps answering the page (status polls, the game's JSON filling in) while the
engines work. The engine settings are analyse.py's: one single-threaded engine per physical core, MultiPV 3, a
fixed node count, the hash cleared before every position. Its `info` lines go through python-chess's own parser
into analyse.evaluate_multipv, so a browser eval is stored exactly as a desktop one.
"""

import asyncio
import logging
import time
from typing import Callable, Iterable, Optional

import chess
import chess.engine

from chess_review import aggregates, analyse, classify, serve, site
from chess_review.analyse import CRASH_RETRY_NODES, LivePace, export_parquet, open_db, pending_keys, write_results
from chess_review.config import DEFAULT_NODES, MULTIPV_N
from chess_review.db import base_views
from chess_review.explore import Explorer
from chess_review.fen import board_from_key

log = logging.getLogger("web.runner")
NO_EVAL = {"nodes": 0, "eval_cp": None, "mate_in": None, "best_move": None, "pv": []}


def persist() -> None:
    """Write the file system back to IndexedDB (debounced by the worker). A no-op outside the browser."""
    try:
        import js
        js.crPersist()
    except (ImportError, AttributeError):
        pass


class _Replay:
    """Stands in for chess.engine.SimpleEngine in analyse.evaluate_multipv: the info lines of a search that has
    already run, merged per MultiPV rank as AnalysisResult does."""

    def __init__(self, lines: list[str]):
        self.lines = lines

    def analyse(self, board: chess.Board, limit, multipv=None, game=None):
        ranks: list[dict] = []
        for line in self.lines:
            info = chess.engine._parse_uci_info(line[5:], board)
            if not info:
                continue
            n = info.get("multipv", 1)
            while len(ranks) < n:
                ranks.append({})
            ranks[n - 1].update(info)
        return ranks if multipv else (ranks[0] if ranks else {})


class BrowserAnalyser:
    """analyse.Analyser.run over the browser's engine pool, awaited."""

    def __init__(self, engines, nodes: int = DEFAULT_NODES):
        self.engines, self.nodes = engines, nodes
        self.workers = int(engines.size)

    async def evaluate(self, key: str) -> tuple[str, dict, list[dict]]:
        board = board_from_key(key)
        if board.is_game_over():        # resolved without the engine (mate, stalemate, bare kings)
            return (key, *analyse.evaluate_multipv(board, None, chess.engine.Limit(nodes=0)))
        for nodes in (self.nodes, *CRASH_RETRY_NODES):  # an engine that dies is restarted by the pool: go shallower
            try:
                lines = (await self.engines.search(key + " 0 1", nodes, MULTIPV_N)).to_py()
                return (key, *analyse.evaluate_multipv(board, _Replay(lines), chess.engine.Limit(nodes=nodes)))
            except Exception as e:  # noqa: BLE001 - a JsException: the WASM engine crashed
                log.warning("engine failed on %s at %d nodes: %s", key, nodes, e)
        log.error("engine keeps failing on %s, storing no eval", key)
        return key, dict(NO_EVAL), []

    async def run(self, keys: Iterable[str], con, on_progress: Optional[Callable[[int, int], None]] = None,
                  batch: int = 20, should_stop: Optional[Callable[[], bool]] = None,
                  live: Optional[LivePace] = None) -> int:
        keys = list(keys)
        if not keys:
            return 0
        todo, buf, done, stop, timer = iter(keys), [], 0, False, None

        def flush() -> None:
            started = time.monotonic()
            write_results(con, buf)
            buf.clear()
            if on_progress:
                on_progress(done, len(keys))
            if live:
                live.wrote(started)
            persist()

        async def due() -> None:        # live: the results in hand go out once due, whether or not more come
            nonlocal timer
            while live.wait():
                await asyncio.sleep(live.wait())
            timer = None
            if buf:
                flush()

        async def lane() -> None:       # one per engine, taking the next position as it frees up
            nonlocal done, stop, timer
            for key in todo:
                buf.append(await self.evaluate(key))
                done += 1
                if live:
                    live.got()
                if len(buf) >= batch or done == len(keys):
                    flush()
                elif live and timer is None:
                    timer = asyncio.ensure_future(due())
                if should_stop and should_stop():
                    stop = True
                if stop:
                    return

        await asyncio.gather(*(lane() for _ in range(self.workers)))
        if timer:
            timer.cancel()
        if buf:         # stopped: what is in hand is kept
            flush()
        return done


class WebExplorer(Explorer):
    """The sandbox's engine. Not in the browser yet (the lite engine will answer it); only its name is."""

    def __init__(self, engines, nodes: int = DEFAULT_NODES):
        super().__init__(nodes=nodes, threads=1)
        self.engines = engines

    def name(self) -> str:
        return str(self.engines.name)

    def engine(self):
        raise RuntimeError("trying moves needs the engine, which the browser version doesn't run here yet")


class WebRunner(serve.Runner):
    def __init__(self, engines, nodes: int = DEFAULT_NODES):
        super().__init__(nodes, workers=int(engines.size))
        self.analyser = BrowserAnalyser(engines, nodes)
        self.explorer = WebExplorer(engines, nodes)

    def _spawn(self, job: serve.Job, before):
        return asyncio.ensure_future(self._run_async(job, before))

    async def _run_async(self, job: serve.Job, before) -> None:
        if before is not None:
            await before
        try:
            try:
                job.status = "running"
                if job.kind == "analyse":
                    await self._analyse(job)
                elif job.kind in ("analyse_all", "build", "puzzles"):
                    raise RuntimeError(f"{job.kind} isn't in the browser version yet")
                else:
                    self._work(job)     # no engine: ingest, refresh (the worker is busy until it is done)
                job.status = "stopped" if job.stop_requested else "done"
            except Exception as e:  # noqa: BLE001 - surfaced to the UI
                self._failed(job, e)
        finally:
            self._ended(job)
            persist()

    async def _analyse(self, job: serve.Job) -> None:
        """serve.Runner._analyse with the search awaited."""
        p = job.profile
        con = open_db()
        base_views(con, p)
        try:
            keys, stats = pending_keys(con, p, job.game_id)
            job.total = len(keys)
            log.info("analyse %s/%s: %s", p.id, job.slug, stats)
            keys = serve.live_order(con, job.game_id, keys)

            def progress(done: int, _total: int) -> None:
                job.done = done
                site.update_index(p, site.write_game(con, p, job.game_id))

            await self.analyser.run(keys, con, on_progress=progress, batch=self.analyser.workers,
                                    should_stop=lambda: job.stop_requested, live=LivePace(serve.LIVE_WRITE_S))
            job.status = "finishing"
            site.update_index(p, site.write_game(con, p, job.game_id))
            export_parquet(con)
        finally:
            con.close()
        classify.build(p)
        aggregates.build(p)
