"""Build the puzzle pack the trainer ships with (chess_review/puzzle_packs/puzzles.json) from Lichess's puzzle
database: CC0, about 5 million puzzles mined from real games, each rated by the players who tried it.

    curl -LO https://database.lichess.org/lichess_db_puzzle.csv.zst
    python scripts/build_puzzle_pack.py lichess_db_puzzle.csv.zst          # or the unpacked .csv

Only well-liked, well-tested puzzles are kept (Popularity, NbPlays, RatingDeviation below), sampled evenly over
100-point rating bands so the pack doesn't pile up around 1500. Within a band no single theme may fill more than
THEME_CAP of the quota, which keeps the generic tags (crushing, advantage, middlegame) from crowding out the rest.
The sample is seeded, so the same input builds the same pack. The puzzles in the packs (packs.json, picked from the
whole database by scripts/build_puzzle_packs.py) are kept on top of the sample, so the packs go on working.

puzzles.json is a JSON array with one puzzle a line, so a rebuild diffs by puzzle; both apps read it as it is.
A build tool, not part of the app: it needs pyarrow for the .zst (pip install pyarrow).
"""
import argparse
import csv
import io
import json
import random
import sys
from pathlib import Path

import pyarrow as pa

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "chess_review" / "puzzle_packs" / "puzzles.json"

MIN_POPULARITY = 85     # -100..100: how many players liked it, net
MIN_PLAYS = 500
MAX_RD = 80             # the puzzle's rating is settled
BAND = 100
RATING_LO, RATING_HI = 500, 2900
THEME_CAP = 0.35        # share of a band's quota one theme may take
# tags every puzzle carries some of: they say how long or which phase, not what to look for, so they aren't capped
UNCAPPED = {"short", "long", "veryLong", "oneMove", "opening", "middlegame", "endgame", "master", "masterVsMaster", "superGM"}
SEED = 20261020

SCHEMA = pa.schema([
    ("id", pa.string()),
    ("fen", pa.string()),         # before the setup move (the opponent's)
    ("moves", pa.string()),       # UCI, space-separated: setup move, then the solution
    ("rating", pa.int16()),
    ("popularity", pa.int8()),
    ("plays", pa.int32()),
    ("themes", pa.string()),      # space-separated Lichess theme ids
    ("game_url", pa.string()),
    ("opening", pa.string()),     # Lichess opening tags, space-separated
])


def read_library(path: Path = OUT) -> list[dict]:
    """puzzles.json's rows, themes as stored (a space-separated string); [] when there is none."""
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def write_library(rows: list[dict], path: Path = OUT) -> None:
    """rows as puzzles.json: SCHEMA's columns in order, one puzzle a line."""
    lines = (json.dumps({k: r[k] for k in SCHEMA.names}, separators=(",", ":")) for r in rows)
    path.write_text("[\n" + ",\n".join(lines) + "\n]\n", encoding="utf-8", newline="\n")


def rows(path: Path):
    """The CSV's rows as dicts, decompressing a .zst on the fly (pyarrow reads zstd, so nothing else is needed)."""
    if path.suffix != ".zst":
        with path.open(newline="", encoding="utf-8") as f:
            yield from csv.DictReader(f)
        return
    with pa.CompressedInputStream(pa.OSFile(str(path)), "zstd") as zr:
        yield from csv.DictReader(io.TextIOWrapper(io.BufferedReader(zr), encoding="utf-8", newline=""))


def build(src: Path, total: int, keep_ids=frozenset()) -> list[dict]:
    rng = random.Random(SEED)
    bands = list(range(RATING_LO, RATING_HI, BAND))
    quota = total // len(bands)
    keep = quota * 4            # reservoir per band: room for the theme cap to pick around
    pools: dict[int, list[dict]] = {b: [] for b in bands}
    seen: dict[int, int] = {b: 0 for b in bands}
    scanned = eligible = 0
    kept = []
    for r in rows(src):
        scanned += 1
        if r["PuzzleId"] in keep_ids:
            kept.append({"id": r["PuzzleId"], "fen": r["FEN"], "moves": r["Moves"], "rating": int(r["Rating"]),
                         "popularity": int(r["Popularity"]), "plays": int(r["NbPlays"]), "themes": r["Themes"],
                         "game_url": r["GameUrl"], "opening": r.get("OpeningTags") or ""})
        try:
            rating, rd = int(r["Rating"]), int(r["RatingDeviation"])
            pop, plays = int(r["Popularity"]), int(r["NbPlays"])
        except (KeyError, ValueError):
            continue
        if pop < MIN_POPULARITY or plays < MIN_PLAYS or rd > MAX_RD or not RATING_LO <= rating < RATING_HI:
            continue
        eligible += 1
        b = RATING_LO + (rating - RATING_LO) // BAND * BAND
        seen[b] += 1
        row = {"id": r["PuzzleId"], "fen": r["FEN"], "moves": r["Moves"], "rating": rating, "popularity": pop,
               "plays": plays, "themes": r["Themes"], "game_url": r["GameUrl"], "opening": r.get("OpeningTags") or ""}
        pool = pools[b]
        if len(pool) < keep:
            pool.append(row)
        else:                       # reservoir sampling: every eligible puzzle in the band equally likely to stay
            j = rng.randrange(seen[b])
            if j < keep:
                pool[j] = row
        if scanned % 500_000 == 0:
            print(f"  {scanned:,} scanned, {eligible:,} eligible", file=sys.stderr)
    print(f"{scanned:,} puzzles scanned, {eligible:,} pass the quality filter", file=sys.stderr)

    # bands at the ends have fewer good puzzles than the quota: what they can't use goes to the bands that have more
    quotas = {b: min(quota, len(pools[b])) for b in bands}
    while (spare := total - sum(quotas.values())) > 0:
        room = [b for b in bands if len(pools[b]) > quotas[b]]
        if not room:
            break
        for b in room:
            quotas[b] = min(len(pools[b]), quotas[b] + max(1, spare // len(room)))

    out = []
    for b in bands:
        pool, quota = pools[b], quotas[b]
        cap = max(1, int(quota * THEME_CAP))
        rng.shuffle(pool)
        counts: dict[str, int] = {}
        taken = []
        for row in pool:
            if len(taken) >= quota:
                break
            capped = [t for t in row["themes"].split() if t not in UNCAPPED]
            if any(counts.get(t, 0) >= cap for t in capped):
                continue
            for t in capped:
                counts[t] = counts.get(t, 0) + 1
            taken.append(row)
        out += taken
        print(f"  {b}-{b + BAND - 1}: {len(taken)} of {seen[b]:,}", file=sys.stderr)
    have = {r["id"] for r in out}
    out += [r for r in kept if r["id"] not in have]
    print(f"  {len(kept):,} pack puzzles kept, {len(out) - len(have):,} of them not in the sample", file=sys.stderr)
    out.sort(key=lambda r: (r["rating"], r["id"]))
    return out


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("src", type=Path, help="lichess_db_puzzle.csv.zst (or .csv)")
    p.add_argument("--total", type=int, default=30_000, help="puzzles in the pack (default 30000)")
    p.add_argument("--out", type=Path, default=OUT)
    args = p.parse_args(argv)
    packs_json = OUT.parent / "packs.json"
    in_packs = ({i for p in json.loads(packs_json.read_text(encoding="utf-8"))["packs"] for s in p["stages"] for i in s["ids"]}
                if packs_json.exists() else set())
    pack = build(args.src, args.total, in_packs)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    write_library(pack, args.out)
    print(f"wrote {len(pack):,} puzzles to {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
