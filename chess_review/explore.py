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
from typing import Optional

import chess
import chess.engine

from . import explain
from .analyse import robust_multipv
from .classify import classify_game
from .config import DEFAULT_NODES, STOCKFISH
from .db import connect
from .facts import extract
from .fen import fen_key
from .pov import pov_win_pct
from .site import eval_text

log = logging.getLogger("explore")


class Explorer:
    def __init__(self, nodes: int = DEFAULT_NODES, threads: Optional[int] = None):
        self.nodes = nodes
        self.threads = threads or max(1, (os.cpu_count() or 2) // 2)
        self._engine: Optional[chess.engine.SimpleEngine] = None
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[dict, list[dict]]] = {}     # fen_key -> (evals row, multipv rows)
        self.last_used = 0.0

    def engine(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            self._engine = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH))
            self._engine.configure({"Threads": self.threads, "Hash": 256})
        return self._engine

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

    def evaluate(self, board: chess.Board) -> tuple[dict, list[dict]]:
        key = fen_key(board.fen())
        hit = self._lookup(key)
        if hit is not None:
            return hit
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

    def move(self, fen: str, uci: str, my_colour: str, ply: int = 0) -> dict:
        board = chess.Board(fen)
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            raise ValueError(f"illegal move {uci}")
        before_main, before_ranks = self.evaluate(board)
        after = board.copy(stack=False)
        after.push(move)
        after_main, _ = self.evaluate(after)

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
