"""Stage 4b: pick the 3-5 moves per game that decided it -> data/critical.parquet.

Candidates are unforced moves (either side) losing >= MISTAKE win%, ignoring
the first OPENING_SKIP_PLIES unless the move is already a blunder. Ranked by
whether the move crossed a decision boundary (winning / equal / losing bands of
the mover's win%), then by win% loss. A game may have zero.
"""

import argparse
import logging

import pyarrow as pa
import pyarrow.parquet as pq

from .config import BLUNDER, CRITICAL_MAX, CRITICAL_PARQUET, MISTAKE, OPENING_SKIP_PLIES
from .db import connect

log = logging.getLogger("critical")

WINNING = 65.0
LOSING = 35.0

SCHEMA = pa.schema([
    ("game_id", pa.string()),
    ("ply", pa.int32()),
    ("rank", pa.int32()),
    ("band_before", pa.string()),
    ("band_after", pa.string()),
    ("crosses_boundary", pa.bool_()),
])


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


def build() -> dict:
    con = connect()
    rows = con.execute("SELECT * FROM moves ORDER BY game_id, ply").fetch_arrow_table().to_pylist()
    by_game: dict[str, list[dict]] = {}
    for r in rows:
        by_game.setdefault(r["game_id"], []).append(r)
    out = []
    for gid, ms in by_game.items():
        out.extend(select(ms))
    CRITICAL_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(out, schema=SCHEMA), CRITICAL_PARQUET)
    per_game = [len([c for c in out if c["game_id"] == g]) for g in by_game]
    hist = {k: per_game.count(k) for k in range(CRITICAL_MAX + 1)}
    return {"games": len(by_game), "critical": len(out), "per_game_histogram": hist}


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="critical", description=__doc__)
    p.parse_args(argv)
    log.info("done: %s", build())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
