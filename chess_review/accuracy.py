"""Game accuracy, lichess style (lila AccuracyPercent).

Per move: 103.1668 * exp(-0.04354 * win%loss) - 3.1669.
Per game and side: the average of (a) the harmonic mean of the move accuracies
and (b) their mean weighted by position volatility (stdev of win% over a
sliding window), so blunders and sharp positions weigh more than a plain mean.
Book moves are excluded. Numbers land close to chess.com's, which is unpublished.
"""

import math
import statistics
from typing import Optional


def move_accuracy(wp_loss: float) -> float:
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * wp_loss) - 3.1669))


def _wp_white_sequence(moves: list[dict], start_wp_white: Optional[float]) -> list[Optional[float]]:
    """White-POV win% after each ply, derived from the mover-POV numbers on classified move rows."""
    seq = [start_wp_white]
    for m in moves:
        a = m["wp_after"]
        seq.append(None if a is None else (a if m["side_to_move"] == "white" else 100 - a))
    return seq


def game_accuracy(moves: list[dict], side: str, start_wp_white: Optional[float] = 50.0) -> Optional[float]:
    """moves: classified rows for one game, ordered by ply."""
    wps = _wp_white_sequence(moves, start_wp_white)
    n = len(wps)
    window = max(2, min(8, n // 10))
    vols = []
    for i in range(n):
        w = [x for x in wps[max(0, i - window // 2):min(n, i + window // 2 + 1)] if x is not None]
        vols.append(max(0.5, min(12.0, statistics.pstdev(w))) if len(w) > 1 else 0.5)
    accs, weights = [], []
    for m in moves:
        if m["side_to_move"] != side or m["wp_loss"] is None or m["in_book"]:
            continue
        accs.append(move_accuracy(m["wp_loss"]))
        weights.append(vols[m["ply"]])
    if not accs:
        return None
    weighted = sum(a * w for a, w in zip(accs, weights)) / sum(weights)
    harmonic = len(accs) / sum(1 / max(a, 1e-9) for a in accs)
    return round((weighted + harmonic) / 2, 1)
