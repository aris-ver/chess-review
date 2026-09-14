"""Stage 4b: pick the 3-5 moves per game that decided it (selected live by site.py).

Candidates are unforced moves (either side) losing >= MISTAKE win%, ignoring
the first OPENING_SKIP_PLIES unless the move is already a blunder. Ranked by
whether the move crossed a decision boundary (winning / equal / losing bands of
the mover's win%), then by win% loss. A game may have zero.
"""

from .config import BLUNDER, CRITICAL_MAX, MISTAKE, OPENING_SKIP_PLIES

WINNING = 65.0
LOSING = 35.0


def band(wp: float) -> str:
    if wp >= WINNING:
        return "winning"
    if wp <= LOSING:
        return "losing"
    return "equal"


def select(moves: list[dict]) -> list[dict]:
    """moves: classified rows for one game, any order. Returns ranked critical rows."""
    cands = []
    for m in moves:
        if m["wp_loss"] is None or m["is_forced"] or m["in_book"]:
            continue
        if m["wp_loss"] < MISTAKE:
            continue
        if m["ply"] < OPENING_SKIP_PLIES and m["wp_loss"] <= BLUNDER:
            continue
        b0, b1 = band(m["wp_before"]), band(m["wp_after"])
        cands.append({
            "game_id": m["game_id"], "ply": m["ply"],
            "band_before": b0, "band_after": b1, "crosses_boundary": b0 != b1,
            "_loss": m["wp_loss"],
        })
    cands.sort(key=lambda c: (not c["crosses_boundary"], -c["_loss"]))
    out = []
    for rank, c in enumerate(cands[:CRITICAL_MAX], start=1):
        c.pop("_loss")
        out.append({**c, "rank": rank})
    return out

