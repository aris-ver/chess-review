"""Freeze the puzzle packs and the daily list into chess_review/puzzle_packs/packs.json (see chess_review/packs.py).

Run it after rebuilding lichess.parquet, and only then: rebuilding it renumbers the packs and changes the
puzzle of the day for everyone on that version.

    python scripts/build_puzzle_packs.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chess_review import packs, puzzles  # noqa: E402


def main() -> None:
    rows = puzzles.Pack().rows()
    data = packs.build(rows)
    packs.PACKS.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    for p in data["packs"]:
        n = sum(len(s["ids"]) for s in p["stages"])
        print(f"{p['family']:9} {p['name']:28} {len(p['stages']):3} stages {n:5} puzzles  "
              f"{p['stages'][0]['lo']}-{p['stages'][-1]['hi']}")
    print(f"daily: {len(data['daily'])} puzzles; {packs.PACKS} {packs.PACKS.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
