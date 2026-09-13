"""Stage 3: evaluate positions with Stockfish into an on-disk cache.

Keyed on fen_key (FEN minus move counters), not on game. Fixed node count, one
single-threaded engine per worker process, hash cleared before every search so
results are reproducible run-to-run. Every search is MultiPV=3: rank 1 goes to
`evals`, all ranks to `evals_multipv` (needed for "great"/"only move").

Two entry points:
  - the CLI batch (`python -m chess_review analyse`) over every pending position
  - `Analyser`, a persistent worker pool the server uses for on-demand games

Sign convention: see pov.py. Everything is stored from the side-to-move POV.
"""

import argparse
import atexit
import logging
import multiprocessing as mp
import os
import threading
import time
from typing import Callable, Iterable, Optional

import chess
import chess.engine
import duckdb

from .config import DEFAULT_HASH_MB, DEFAULT_NODES, EVALS_DB, EVALS_PARQUET, MULTIPV_N, POSITIONS_PARQUET, STOCKFISH, sql_path
from .fen import board_from_key

log = logging.getLogger("analyse")

SCHEMA = """
CREATE TABLE IF NOT EXISTS evals (
    fen_key   TEXT PRIMARY KEY,
    nodes     INTEGER,
    eval_cp   INTEGER,
    mate_in   INTEGER,
    best_move TEXT,
    pv        TEXT[]
);
CREATE TABLE IF NOT EXISTS evals_multipv (
    fen_key   TEXT,
    rank      INTEGER,
    move      TEXT,
    eval_cp   INTEGER,
    mate_in   INTEGER,
    pv        TEXT[],
    PRIMARY KEY (fen_key, rank)
);
"""

_engine: Optional[chess.engine.SimpleEngine] = None
_limit: Optional[chess.engine.Limit] = None


_cfg: tuple = ()
CRASH_RETRY_NODES = (100_000, 20_000)   # Stockfish 18 segfaults on a few rare positions; retry shallower, then give up


def _start_engine() -> None:
    global _engine
    stockfish, hash_mb = _cfg
    _engine = chess.engine.SimpleEngine.popen_uci(stockfish)
    _engine.configure({"Threads": 1, "Hash": hash_mb})


def _worker_init(stockfish: str, hash_mb: int, nodes: int) -> None:
    global _cfg, _limit
    _cfg = (stockfish, hash_mb)
    _limit = chess.engine.Limit(nodes=nodes)
    _start_engine()
    atexit.register(lambda: _engine and _engine.quit())


def robust_multipv(board: chess.Board, engine_ref, limit: chess.engine.Limit, restart) -> tuple[dict, list[dict]]:
    """evaluate_multipv that survives an engine crash: restart, retry with fewer nodes, finally return no eval."""
    try:
        return evaluate_multipv(board, engine_ref(), limit)
    except chess.engine.EngineError:
        pass
    for nodes in CRASH_RETRY_NODES:
        restart()
        try:
            log.warning("engine died on %s, retrying with %d nodes", board.fen(), nodes)
            return evaluate_multipv(board, engine_ref(), chess.engine.Limit(nodes=nodes))
        except chess.engine.EngineError:
            continue
    restart()
    log.error("engine keeps dying on %s, storing no eval", board.fen())
    return {"nodes": 0, "eval_cp": None, "mate_in": None, "best_move": None, "pv": []}, []


def _score(info: dict) -> tuple[Optional[int], Optional[int]]:
    score = info["score"].relative
    mate = score.mate()
    return (None if mate is not None else score.score()), mate


def evaluate(board: chess.Board, engine: chess.engine.SimpleEngine, limit: chess.engine.Limit) -> dict:
    """Single-PV evaluation. Terminal positions are resolved without the engine (mate_in=0 = checkmated)."""
    if board.is_checkmate():
        return {"nodes": 0, "eval_cp": None, "mate_in": 0, "best_move": None, "pv": []}
    if board.is_stalemate() or board.is_insufficient_material():
        return {"nodes": 0, "eval_cp": 0, "mate_in": None, "best_move": None, "pv": []}
    # A fresh game object forces `ucinewgame` (hash clear) before every search,
    # so a fixed node count gives the same answer every time.
    info = engine.analyse(board, limit, game=object())
    cp, mate = _score(info)
    pv = [m.uci() for m in info.get("pv", [])]
    return {"nodes": info.get("nodes", 0), "eval_cp": cp, "mate_in": mate, "best_move": pv[0] if pv else None, "pv": pv}


def evaluate_multipv(board: chess.Board, engine: chess.engine.SimpleEngine, limit: chess.engine.Limit, n: int = MULTIPV_N) -> tuple[dict, list[dict]]:
    """(evals row, evals_multipv rows) for one position."""
    if board.is_game_over():
        return evaluate(board, engine, limit), []
    infos = engine.analyse(board, limit, multipv=n, game=object())
    ranks = []
    for info in infos:
        if "pv" not in info or "score" not in info:
            continue
        cp, mate = _score(info)
        pv = [m.uci() for m in info["pv"]]
        ranks.append({"rank": info.get("multipv", len(ranks) + 1), "move": pv[0], "eval_cp": cp, "mate_in": mate, "pv": pv})
    ranks.sort(key=lambda r: r["rank"])
    top = ranks[0] if ranks else {"eval_cp": None, "mate_in": None, "pv": []}
    nodes = max((i.get("nodes", 0) for i in infos), default=0)
    main = {"nodes": nodes, "eval_cp": top["eval_cp"], "mate_in": top["mate_in"],
            "best_move": top["pv"][0] if top["pv"] else None, "pv": top["pv"]}
    return main, ranks


def _analyse_key(fen_key: str) -> tuple[str, dict, list[dict]]:
    main, ranks = robust_multipv(board_from_key(fen_key), lambda: _engine, _limit, _start_engine)
    return fen_key, main, ranks


# --- storage ------------------------------------------------------------------

def open_db(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    EVALS_DB.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(EVALS_DB), read_only=read_only)
    if not read_only:
        con.execute(SCHEMA)
    return con


def write_results(con: duckdb.DuckDBPyConnection, results: list[tuple[str, dict, list[dict]]]) -> None:
    con.executemany("INSERT OR IGNORE INTO evals VALUES (?, ?, ?, ?, ?, ?)",
                    [(k, m["nodes"], m["eval_cp"], m["mate_in"], m["best_move"], m["pv"]) for k, m, _ in results])
    rows = [(k, r["rank"], r["move"], r["eval_cp"], r["mate_in"], r["pv"]) for k, _, ranks in results for r in ranks]
    if rows:
        con.executemany("INSERT OR IGNORE INTO evals_multipv VALUES (?, ?, ?, ?, ?, ?)", rows)


def export_parquet(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(f"COPY evals TO {sql_path(EVALS_PARQUET)} (FORMAT PARQUET)")


def pending_keys(con: duckdb.DuckDBPyConnection, game_id: Optional[str] = None) -> tuple[list[str], dict]:
    """Distinct position keys (optionally for one game) that lack an eval or MultiPV rows."""
    # DDL can't take bind parameters, so the game id goes in as a quoted literal
    where = "WHERE game_id = " + sql_path(game_id) if game_id else ""
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW position_keys AS
        SELECT DISTINCT array_to_string(list_slice(string_split(fen, ' '), 1, 4), ' ') AS fen_key
        FROM read_parquet({sql_path(POSITIONS_PARQUET)}) {where}
    """)
    total = con.execute(f"SELECT count(*) FROM read_parquet({sql_path(POSITIONS_PARQUET)}) {where}").fetchone()[0]
    distinct = con.execute("SELECT count(*) FROM position_keys").fetchone()[0]
    keys = [r[0] for r in con.execute("""
        SELECT k.fen_key FROM position_keys k
        LEFT JOIN evals e USING (fen_key)
        LEFT JOIN (SELECT DISTINCT fen_key FROM evals_multipv) m USING (fen_key)
        WHERE e.fen_key IS NULL OR m.fen_key IS NULL
    """).fetchall()]
    stats = {"position_rows": total, "distinct_positions": distinct,
             "dedupe_pct": round(100 * (1 - distinct / total), 1) if total else 0.0,
             "already_cached": distinct - len(keys), "pending": len(keys)}
    return keys, stats


# --- persistent pool ----------------------------------------------------------

class Analyser:
    """A worker pool that lives across jobs. Not thread-safe per job: run one job at a time."""

    def __init__(self, workers: Optional[int] = None, nodes: int = DEFAULT_NODES, hash_mb: int = DEFAULT_HASH_MB):
        self.workers = workers or default_workers()
        self.nodes, self.hash_mb = nodes, hash_mb
        self._pool = None
        self._lock = threading.Lock()

    def pool(self):
        if self._pool is None:
            if not STOCKFISH.exists():
                raise FileNotFoundError(f"stockfish not found at {STOCKFISH}")
            ctx = mp.get_context("spawn")
            self._pool = ctx.Pool(self.workers, initializer=_worker_init, initargs=(str(STOCKFISH), self.hash_mb, self.nodes))
        return self._pool

    def close(self) -> None:
        if self._pool is not None:
            self._pool.terminate()
            self._pool = None

    def run(self, keys: Iterable[str], con: duckdb.DuckDBPyConnection, on_progress: Optional[Callable[[int, int], None]] = None,
            batch: int = 20, should_stop: Optional[Callable[[], bool]] = None) -> int:
        """Analyse `keys`, writing to `con` every `batch` results. Returns count analysed."""
        keys = list(keys)
        if not keys:
            return 0
        with self._lock:
            buf, done = [], 0
            t0 = time.time()
            it = self.pool().imap_unordered(_analyse_key, keys, chunksize=1)
            for res in it:
                buf.append(res)
                done += 1
                if len(buf) >= batch or done == len(keys):
                    write_results(con, buf)
                    buf = []
                    if on_progress:
                        on_progress(done, len(keys))
                    rate = done / (time.time() - t0)
                    log.info("%d/%d  %.2f pos/s", done, len(keys), rate)
                if should_stop and should_stop():
                    log.warning("job stopped after %d/%d", done, len(keys))
                    # drain: results for remaining keys are cheap to keep, but stop waiting on them
                    self.close()
                    break
            return done


def default_workers() -> int:
    # One engine per PHYSICAL core: on the dev box 6 procs = 1.9 Mnps aggregate, 11 procs = 1.6 Mnps.
    return max(1, (os.cpu_count() or 2) // 2)


# --- CLI batch ----------------------------------------------------------------

def run(workers: int, nodes: int, hash_mb: int, limit: Optional[int] = None) -> dict:
    con = open_db()
    keys, stats = pending_keys(con)
    log.info("positions: %s", stats)
    if limit:
        keys = keys[:limit]
    t0 = time.time()
    analyser = Analyser(workers, nodes, hash_mb)
    try:
        done = analyser.run(keys, con, batch=100)
    finally:
        analyser.close()
        export_parquet(con)
    stats["analysed_this_run"] = done
    stats["elapsed_s"] = round(time.time() - t0, 1)
    return stats


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="analyse", description=__doc__)
    p.add_argument("--workers", type=int, default=default_workers())
    p.add_argument("--nodes", type=int, default=DEFAULT_NODES)
    p.add_argument("--hash", type=int, default=DEFAULT_HASH_MB, help="MB per worker")
    p.add_argument("--limit", type=int, help="analyse at most N pending positions (smoke test)")
    args = p.parse_args(argv)
    if not STOCKFISH.exists():
        p.error(f"stockfish not found at {STOCKFISH} (set STOCKFISH env var)")
    log.info("done: %s", run(args.workers, args.nodes, args.hash, args.limit))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
