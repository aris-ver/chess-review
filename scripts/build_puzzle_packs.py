"""Pick the puzzle packs (see chess_review/packs.py) and freeze them into chess_review/puzzle_packs/packs.json.

    curl -LO https://database.lichess.org/lichess_db_puzzle.csv.zst
    python scripts/build_puzzle_packs.py lichess_db_puzzle.csv.zst

The packs are picked from the whole Lichess puzzle database: every puzzle with Popularity >= MIN_POPULARITY, at least
MIN_PLAYS plays and a settled rating is a candidate (with lower floors at the EDGES of the rating range). The ones picked that the library (lichess.parquet) doesn't have yet
are added to it, so they can be played; scripts/build_puzzle_pack.py keeps them when it rebuilds the library. Without
the database the packs are picked from the library alone.

The daily list in packs.json is kept as it is, so the puzzle of the day doesn't change for anyone; --new-daily draws
it afresh from the library. Rebuilding changes what's in the packs: progress carries over because it is kept per
puzzle, and a stage also opens on the solved puzzles of its themes (packs.credit). A build tool: it needs pyarrow.
"""

import argparse
import json
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_puzzle_pack import SCHEMA, rows as csv_rows  # noqa: E402
from chess_review import packs, puzzles  # noqa: E402

MIN_POPULARITY = 92
MIN_PLAYS = 2000
MAX_RD = 80
# few puzzles are rated below 1000 or above 2300, and fewer still are played much: there the library's own floors
EDGES = (1000, 2300)
EDGE_POPULARITY, EDGE_PLAYS = 85, 500


def candidates(src: Path) -> list[dict]:
    out = []
    for r in csv_rows(src):
        try:
            rating, rd = int(r["Rating"]), int(r["RatingDeviation"])
            pop, plays = int(r["Popularity"]), int(r["NbPlays"])
        except (KeyError, ValueError):
            continue
        edge = not EDGES[0] <= rating < EDGES[1]
        if (pop >= (EDGE_POPULARITY if edge else MIN_POPULARITY) and plays >= (EDGE_PLAYS if edge else MIN_PLAYS)
                and rd <= MAX_RD):
            out.append({"id": r["PuzzleId"], "fen": r["FEN"], "moves": r["Moves"], "rating": rating, "popularity": pop,
                        "plays": plays, "themes": r["Themes"].split(), "game_url": r["GameUrl"],
                        "opening": r.get("OpeningTags") or ""})
    print(f"{len(out):,} candidates from {src}", file=sys.stderr)
    return out


def add_to_library(picked: list[dict]) -> int:
    """Append the picked puzzles the library lacks to lichess.parquet; how many."""
    have = {r["id"] for r in puzzles.Pack().rows()}
    new = [dict(r, themes=" ".join(r["themes"])) for r in picked if r["id"] not in have]
    if new:
        old = pq.read_table(puzzles.PACK).to_pylist()
        both = sorted(old + [{k: r[k] for k in SCHEMA.names} for r in new], key=lambda r: (r["rating"], r["id"]))
        pq.write_table(pa.Table.from_pylist(both, schema=SCHEMA), puzzles.PACK, compression="zstd", compression_level=19)
    return len(new)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("src", type=Path, nargs="?", help="lichess_db_puzzle.csv.zst (or .csv); the library alone without it")
    p.add_argument("--new-daily", action="store_true", help="draw the daily list afresh (changes the puzzle of the day)")
    args = p.parse_args(argv)
    library = puzzles.Pack().rows()
    old = json.loads(packs.PACKS.read_text(encoding="utf-8")) if packs.PACKS.exists() else {}
    daily = None if args.new_daily or not old.get("daily") else old["daily"]
    rows = candidates(args.src) if args.src else library
    if daily is None:
        daily = packs.daily_list(library)
    data = packs.build(rows, daily=daily)
    by_id = {r["id"]: r for r in rows}
    added = add_to_library([by_id[i] for p in data["packs"] for s in p["stages"] for i in s["ids"]])
    packs.PACKS.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    for p in data["packs"]:
        n = sum(len(s["ids"]) for s in p["stages"])
        print(f"{p['family']:9} {p['name']:28} {len(p['stages']):3} stages {n:5} puzzles  "
              f"{p['stages'][0]['lo']}-{p['stages'][-1]['hi']}")
    total = sum(len(s["ids"]) for p in data["packs"] for s in p["stages"])
    print(f"{total} puzzles in {len(data['packs'])} packs, {added} added to the library; daily: {len(data['daily'])}; "
          f"{packs.PACKS} {packs.PACKS.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
