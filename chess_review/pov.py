"""Eval sign convention.

Stored evals (`evals.eval_cp`, `evals.mate_in`) are from the SIDE-TO-MOVE point
of view, exactly as the engine reports them. `mate_in` is signed: +N means the
side to move mates in N, -N means the side to move gets mated in N, and 0 means
the side to move is already checkmated (terminal position).

Everything downstream that wants "how good is this for white" or "for me" goes
through the helpers here. Never flip signs inline elsewhere.
"""

import math
from typing import Optional


def win_pct(cp: int) -> float:
    """Lichess win-probability formula, 0-100, for a centipawn eval."""
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def to_pov(eval_cp: Optional[int], mate_in: Optional[int], side_to_move: str, pov: str):
    """Re-sign a stored (side-to-move POV) eval to `pov` ('white' | 'black')."""
    if side_to_move == pov:
        return eval_cp, mate_in
    cp = None if eval_cp is None else -eval_cp
    mate = None if mate_in is None else -mate_in
    return cp, mate


def to_white_pov(eval_cp, mate_in, side_to_move):
    return to_pov(eval_cp, mate_in, side_to_move, "white")


def pov_win_pct(eval_cp: Optional[int], mate_in: Optional[int], side_to_move: str, pov: str) -> float:
    """Win% for `pov`, folding mate scores to 0/100 so they never enter cp arithmetic."""
    cp, mate = to_pov(eval_cp, mate_in, side_to_move, pov)
    if mate is not None:
        if mate == 0:
            return 0.0 if side_to_move == pov else 100.0
        return 100.0 if mate > 0 else 0.0
    return win_pct(cp)
