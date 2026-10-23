"""The shipped puzzle pack as JSON for the Electron app (js/server/puzzles.js's Pack reads it), the same rows
scripts/build_web.py writes for the web: chess_review/puzzle_packs/lichess.parquet read by puzzles.Pack.

    python packaging/puzzles_json.py [OUT]      (default: packaging/build/puzzles.json)
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from chess_review import puzzles  # noqa: E402


def main(argv=None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    out = Path(argv[0]) if argv else ROOT / "packaging" / "build" / "puzzles.json"
    rows = puzzles.PACK_INSTANCE._read()
    if not rows:
        raise SystemExit(f"no puzzle pack at {puzzles.PACK}")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, separators=(",", ":")), encoding="utf-8")
    print(f"{len(rows)} puzzles -> {out}")


if __name__ == "__main__":
    main()
