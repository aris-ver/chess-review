"""On-the-spot analysis of "what if" moves made on the board in the UI.

Uses one multi-threaded engine (all cores, one search at a time) at the same
node count as the batch, so a move is answered in about a second. Results are
kept in memory only: the DuckDB cache stays strictly single-threaded-search data.
"""

import contextlib
import logging
import os
import threading
import time
from typing import Iterator, Optional

import chess
import chess.engine

from . import explain
from .analyse import _score, robust_multipv
from .classify import classify_game
from .config import DEFAULT_NODES, ENGINE_POPEN, STOCKFISH
from .db import connect
from .facts import extract
from .fen import fen_key
from .pov import pov_win_pct
from .site import eval_text

log = logging.getLogger("explore")
PV_PLIES = 16   # how much of each engine line the sandbox shows


def _lines_snapshot(board: chess.Board, lines: dict[int, dict]) -> dict:
    """Format the current top lines of an in-progress multipv search for the client."""
    side = "white" if board.turn else "black"
    out = []
    for rank in sorted(lines):
        info = lines[rank]
        move = info["pv"][0]
        cp, mate = _score(info)
        # the whole line in SAN (capped: the tail of a deep PV is noise in the UI)
        pv, b = [], board.copy(stack=False)
        for m in info["pv"][:PV_PLIES]:
            try:
                pv.append(b.san(m))
                b.push(m)
            except (ValueError, AssertionError):
                break
        wp_white = pov_win_pct(cp, mate, side, "white") if (cp is not None or mate is not None) else None
        out.append({"rank": rank, "uci": move.uci(), "san": pv[0] if pv else move.uci(), "pv": pv,
                    "eval": eval_text(cp, mate, side),
                    "wp_white": round(wp_white, 1) if wp_white is not None else None, "depth": info.get("depth")})
    return {"lines": out}


def _lines_rows(lines: dict[int, dict], nodes: int) -> tuple[dict, list[dict]]:
    """(evals row, evals_multipv rows) from the current lines of a running search: the shape evaluate() returns,
    so a deep snapshot can stand in for the fixed-budget eval of the same position."""
    ranks = []
    for rank in sorted(lines):
        info = lines[rank]
        cp, mate = _score(info)
        pv = [m.uci() for m in info["pv"]]
        ranks.append({"rank": rank, "move": pv[0], "eval_cp": cp, "mate_in": mate, "pv": pv})
    top = ranks[0]
    main = {"nodes": nodes, "eval_cp": top["eval_cp"], "mate_in": top["mate_in"], "best_move": top["pv"][0], "pv": top["pv"]}
    return main, ranks


def _after_from_line(ranks: list[dict], uci: str, nodes: int) -> Optional[dict]:
    """The eval of the position after `uci`, read off the search that listed it as a candidate: the line's own
    score seen from the other side, and the rest of its pv. None when the move wasn't among the lines."""
    for r in ranks:
        if r["move"] != uci or (r["eval_cp"] is None and r["mate_in"] is None):
            continue
        m = r["mate_in"]
        # "mate in m" for the mover is, once the first move is on the board, "mated in m-1" for the opponent
        # (0 = checkmated, as evaluate() reports it); "mated in |m|" becomes the opponent's "mate in |m|"
        mate = None if m is None else (-(m - 1) if m > 0 else -m)
        cp = None if r["eval_cp"] is None else -r["eval_cp"]
        pv = r["pv"][1:]
        return {"nodes": nodes, "eval_cp": cp, "mate_in": mate, "best_move": pv[0] if pv else None, "pv": pv}
    return None


class Explorer:
    def __init__(self, nodes: int = DEFAULT_NODES, threads: Optional[int] = None):
        self.nodes = nodes
        self.threads = threads or max(1, (os.cpu_count() or 2) // 2)
        self._engine: Optional[chess.engine.SimpleEngine] = None
        self._lock = threading.Lock()
        self._stream: Optional[chess.engine.SimpleAnalysisResult] = None   # the infinite search, while one runs
        self._cache: dict[str, tuple[dict, list[dict]]] = {}     # fen_key -> (evals row, multipv rows)
        self.last_used = 0.0

    def engine(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            self._engine = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH), **ENGINE_POPEN)
            self._engine.configure({"Threads": self.threads, "Hash": 256})
        return self._engine

    def name(self) -> str:
        """The engine's UCI id, e.g. "Stockfish 17.1" (starts it if needed)."""
        return self.engine().id.get("name", "engine")

    def close(self) -> None:
        if self._engine is not None:
            with contextlib.suppress(Exception):
                self._engine.quit()
            self._engine = None

    def legal(self, fen: str) -> dict:
        board = chess.Board(fen)
        return {"turn": "white" if board.turn else "black", "moves": [m.uci() for m in board.legal_moves]}

    def _lookup(self, key: str) -> Optional[tuple[dict, list[dict]]]:
        """Cached eval from the exploration cache or the on-disk cache (if readable right now)."""
        if key in self._cache:
            return self._cache[key]
        try:
            con = connect()
            row = con.execute("SELECT nodes, eval_cp, mate_in, best_move, pv FROM evals WHERE fen_key = ?", [key]).fetchone()
            if row is None:
                return None
            main = dict(zip(("nodes", "eval_cp", "mate_in", "best_move", "pv"), row))
            ranks = [dict(zip(("fen_key", "rank", "move", "eval_cp", "mate_in", "pv"), r)) for r in
                     con.execute("SELECT * FROM evals_multipv WHERE fen_key = ? AND rank > 0 ORDER BY rank", [key]).fetchall()]
            return main, ranks
        except Exception as e:  # noqa: BLE001 - locked/missing cache is not fatal here
            log.debug("cache lookup failed for %s: %s", key, e)
            return None

    def interrupt(self) -> None:
        """Stop the infinite search if one is running, so the engine lock frees up now rather than when the
        stream next notices its client has gone (up to a second later). Safe from any thread."""
        stream = self._stream
        if stream is not None:
            with contextlib.suppress(Exception):
                stream.stop()

    def evaluate(self, board: chess.Board) -> tuple[dict, list[dict]]:
        key = fen_key(board.fen())
        hit = self._lookup(key)
        if hit is not None:
            return hit
        self.interrupt()
        with self._lock:
            self.last_used = time.time()
            limit = chess.engine.Limit(nodes=self.nodes)
            res = robust_multipv(board, self.engine, limit, self._restart)
        if res[0]["eval_cp"] is None and res[0]["mate_in"] is None:
            raise RuntimeError("the engine crashes on this position (Stockfish bug), no evaluation")
        self._cache[key] = res
        return res

    def _restart(self) -> None:
        self.close()
        self.engine()

    def analyse_stream(self, board: chess.Board, multipv: int = 3) -> Iterator[dict]:
        """Yield snapshots of the top `multipv` lines while Stockfish searches the position indefinitely
        (`go infinite`, like an analysis board): it keeps deepening for as long as the caller keeps
        reading. The caller stopping (a closed connection closes this generator) cancels the search via
        analysis.stop() on the way out, which also releases the engine for evaluate()/move().

        Between depth iterations the engine can be quiet for seconds (only `currmove` infos, no pv), so
        the last snapshot is re-sent about once a second as a heartbeat: the write is what detects a
        client that has gone away, and without it a deep search would hold the engine lock unwatched.

        The fixed-budget eval of the position is computed first (cached, ~0.5 s): move() will need it
        as the "before" side of the next move the user makes, and doing it now, while they are looking
        at the position anyway, is what makes that move come back fast.

        As the search deepens, its snapshots replace that eval in the cache (whenever they have seen more
        nodes), so the move the user then plays is graded by the same search that drew the arrows: the
        engine's move as shown on the board can't come back as a "miss" against a shallower opinion."""
        try:
            best_nodes = self.evaluate(board)[0]["nodes"]
        except RuntimeError:
            return   # the engine crashes on this position; nothing to stream either
        key = fen_key(board.fen())
        self.interrupt()   # there is one sandbox: a new stream always supersedes the previous position's
        with self._lock:
            self.last_used = time.time()
            lines: dict[int, dict] = {}
            last_emit, nodes = 0.0, 0
            name = self.name()
            try:
                with self.engine().analysis(board, multipv=multipv, game=object()) as analysis:
                    self._stream = analysis
                    for info in analysis:
                        nodes = max(nodes, info.get("nodes", 0))
                        now = time.time()
                        fresh = "pv" in info and info["pv"] and "multipv" in info and "score" in info
                        if fresh:
                            lines[info["multipv"]] = info
                            if 1 in lines and nodes > best_nodes:
                                self._cache[key] = _lines_rows(lines, nodes)
                                best_nodes = nodes
                        if not lines or now - last_emit < (0.12 if fresh else 1.0):
                            continue   # throttle: ~8 snapshots/s while lines change, 1/s heartbeat otherwise
                        last_emit = now
                        yield {"engine": name, "nodes": nodes, **_lines_snapshot(board, lines)}
            except chess.engine.EngineError:
                self._restart()
            finally:
                self._stream = None

    def move(self, fen: str, uci: str, my_colour: str, ply: int = 0) -> dict:
        board = chess.Board(fen)
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            raise ValueError(f"illegal move {uci}")
        before_main, before_ranks = self.evaluate(board)
        after = board.copy(stack=False)
        after.push(move)
        # a move the search already had a line for is graded by that line (the numbers the user was looking at);
        # anything else gets its own fixed-budget search
        after_main = _after_from_line(before_ranks, uci, before_main["nodes"]) or self.evaluate(after)[0]

        # Two-row "game" through the normal classifier so labels/comments match the main line exactly.
        rows = [
            {"game_id": "explore", "ply": ply, "fen": board.fen(), "fen_key": fen_key(board.fen()),
             "side_to_move": "white" if board.turn else "black", "move_played": uci, "clock_remaining": None, **before_main},
            {"game_id": "explore", "ply": ply + 1, "fen": after.fen(), "fen_key": fen_key(after.fen()),
             "side_to_move": "white" if after.turn else "black", "move_played": None, "clock_remaining": None, **after_main},
        ]
        multipv = {rows[0]["fen_key"]: [{"fen_key": rows[0]["fen_key"], **r} for r in before_ranks]}
        m = classify_game({"game_id": "explore", "my_colour": my_colour, "time_control": None}, rows, multipv)[0]
        facts = extract(m, board, rows[0], rows[1], multipv.get(rows[0]["fen_key"]))
        wp_after = pov_win_pct(after_main["eval_cp"], after_main["mate_in"], rows[1]["side_to_move"], "white")
        return {
            "san": m["san"], "uci": uci, "fen": after.fen(), "label": m["label"], "is_mine": m["is_mine"],
            "wp_white": round(wp_after, 1) if (after_main["eval_cp"] is not None or after_main["mate_in"] is not None) else None,
            "eval": eval_text(after_main["eval_cp"], after_main["mate_in"], rows[1]["side_to_move"]),
            "wp_loss": None if m["wp_loss"] is None else round(m["wp_loss"], 1),
            "best_san": m["best_san"], "best_uci": before_main["best_move"],
            "clock": None, "spent": None,
            "comment": explain.comment(facts), "hung": [h["square"] for h in facts.hung_pieces],
            "reply_uci": facts.refutation_uci[0] if facts.refutation_uci else None,
            "game_over": after.is_game_over(),
        }
