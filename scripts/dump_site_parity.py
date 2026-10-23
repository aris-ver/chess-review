"""Parity dumps for the JavaScript port's site and explore (docs/js-port.md, round 2 `site`).

    tests/parity/site.json      site.build, write_game and update_index over the profiles of tests/parity/storage.json:
                                the same games, positions and cache rows the storage dump has, its outputs here
                                (the review files, parsed, without their fingerprint, which the JS makes its own way)
    tests/parity/explore.json   Explorer.legal and Explorer.move on positions of the fixture and odd FENs, with the
                                engine output each search printed, and the sandbox's snapshots (_lines_snapshot,
                                _lines_rows) along recorded searches

    python scripts/dump_site_parity.py            the fixtures (run dump_parity.py and dump_storage_parity.py first)
    python scripts/dump_site_parity.py --local    also tests/parity/local/storage-*.json (dump_storage_parity.py
                                                  --local's) to tests/parity/local/site-<id>.json (gitignored)

Everything runs in a scratch data directory. Needs bin/stockfish (or $STOCKFISH) and data/book, as dump_parity.py;
--data points at another data directory (the one with the book, e.g. the main checkout's from a worktree).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
OUT = ROOT / "tests" / "parity"
EXPLORE_NODES = 20_000
SEED = 20261023

_args = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
_args.add_argument("--local", action="store_true", help="also dump tests/parity/local/storage-*.json's profiles")
_args.add_argument("--data", type=Path, default=ROOT / "data", help="the data directory to read the book from")
ARGS = _args.parse_args()
SCRATCH = Path(tempfile.mkdtemp(prefix="site-parity-"))
os.environ["CHESS_REVIEW_DATA"] = str(SCRATCH)        # before chess_review is imported: every path it has goes here

import chess  # noqa: E402
import chess.engine  # noqa: E402

from chess_review import analyse, book, explore, normalise, profiles, site  # noqa: E402
from chess_review.config import MULTIPV_N, STOCKFISH  # noqa: E402
from chess_review.db import connect, write_parquet  # noqa: E402
from chess_review.fen import fen_key  # noqa: E402
from dump_parity import SPECIAL_FENS, SYNTHETIC_LINES, Recorder, Replay  # noqa: E402

book.BOOK_DIR = ARGS.data.resolve() / "book"
site.write_static = lambda: None        # the static page isn't ported; nothing reads it here


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


# --- site -----------------------------------------------------------------------------------------------------

def site_case(c: dict) -> dict:
    """A storage dump's profile (its games, positions, cache rows and results) through site.build, then write_game
    and update_index as the server calls them during an analysis."""
    keys = set(c["book"])
    book.is_book = lambda k: k in keys       # the dump's book, as the JS replays it
    p = profiles.create(c["source"], c["username"])
    write_parquet(c["games"], normalise.GAMES_SCHEMA, p.games_parquet)
    write_parquet(c["positions"], normalise.POSITIONS_SCHEMA, p.positions_parquet)
    analyse.EVALS_DB.unlink(missing_ok=True)
    analyse.EVALS_PARQUET.unlink(missing_ok=True)
    con = analyse.open_db()
    cols = ("fen_key", "nodes", "eval_cp", "mate_in", "best_move", "pv")
    if c["cache"]["evals"]:
        con.executemany("INSERT INTO evals VALUES (?, ?, ?, ?, ?, ?)", [[r[k] for k in cols] for r in c["cache"]["evals"]])
    mcols = ("fen_key", "rank", "move", "eval_cp", "mate_in", "pv")
    if c["cache"]["multipv"]:
        con.executemany("INSERT INTO evals_multipv VALUES (?, ?, ?, ?, ?, ?)", [[r[k] for k in mcols] for r in c["cache"]["multipv"]])
    if c["results"]:
        analyse.write_results(con, [tuple(r) for r in c["results"]])
    con.close()

    stats = site.build(p)
    again = site.build(p)
    out = {"name": p.id, "build": {"games": stats["games"], "rebuilt": stats["rebuilt"]},
           "again": {"games": again["games"], "rebuilt": again["rebuilt"]},
           "games_json": json.loads((p.site_dir / "games.json").read_text(encoding="utf-8")), "reviews": {}}
    for f in sorted((p.site_dir / "games").iterdir()):
        r = json.loads(f.read_text(encoding="utf-8"))
        del r["fp"]
        out["reviews"][f.stem] = r
    # the server's path: one game rewritten, its entry put back into the index; and an entry the index lacks
    gid = c["games"][-1]["game_id"]
    con = connect(p)
    entry = site.write_game(con, p, gid)
    con.close()
    site.update_index(p, entry)
    site.update_index(p, {**entry, "id": "extra", "played_at": "2025-06-01T00:00:00"})
    out["write_game"] = {"game_id": gid, "entry": entry}
    out["updated"] = json.loads((p.site_dir / "games.json").read_text(encoding="utf-8"))
    shutil.rmtree(p.dir)
    return out


# --- explore --------------------------------------------------------------------------------------------------

def explorer(rec: Recorder):
    """An Explorer whose cache is its own memory only, and whose searches are recorded: fen -> the lines it printed."""
    ex = explore.Explorer(nodes=EXPLORE_NODES, threads=1)
    ex._lookup = lambda key: ex._cache.get(key)
    searches: dict[str, list[str]] = {}
    real = analyse.robust_multipv

    def recording(board, engine_ref, limit, restart):
        res = real(board, engine_ref, limit, restart)
        terminal = board.is_checkmate() or board.is_stalemate() or board.is_insufficient_material()
        searches[board.fen()] = [] if terminal else list(rec.lines)
        return res

    explore.robust_multipv = recording
    return ex, searches


def move_cases(rec: Recorder) -> list[dict]:
    rng = random.Random(SEED)
    storage = json.loads((OUT / "storage.json").read_text(encoding="utf-8"))
    fixture = [r for r in storage[0]["positions"] if r["move_played"]]
    fens = [(r["fen"], r["ply"]) for r in fixture[::3]] + [(f, 0) for f in SPECIAL_FENS]
    fens.append(("4k3/8/8/8/8/8/4P3/4K3 w - - 149 120", 30))      # the 75-move rule: over after any move
    ratings = [None, {"white": 1200, "black": 1800}, {"white": None, "black": 2500}, {"white": 3100, "black": 600}]
    ex, searches = explorer(rec)
    cases = []
    try:
        for i, (fen, ply) in enumerate(fens):
            board = chess.Board(fen)
            legal = [m.uci() for m in board.legal_moves]
            if not legal:
                continue
            tries = [rng.choice(legal)]
            ex._cache.clear()
            searches.clear()
            ex.evaluate(board)
            ranks = ex._cache[fen_key(fen)][1]
            tries += [r["move"] for r in ranks if r["move"] not in tries]
            for j, u in enumerate(tries):
                ex._cache.clear()
                searches.clear()
                colour = "white" if (i + j) % 2 else "black"
                r = ratings[(i + j) % len(ratings)]
                case = {"fen": fen, "uci": u, "my_colour": colour, "ply": ply, "ratings": r}
                case["result"] = ex.move(fen, u, colour, ply, r)
                case["searches"] = dict(searches)
                after = board.copy(stack=False)
                after.push_uci(u)
                case["book"] = sorted(k for k in {fen_key(fen), fen_key(after.fen())} if book.is_book(k))
                cases.append(case)
        ex._cache.clear()
        board = chess.Board(SPECIAL_FENS[3])
        try:
            ex.move(board.fen(), "a1b3", "white")
        except ValueError as e:
            cases.append({"fen": board.fen(), "uci": "a1b3", "my_colour": "white", "ply": 0, "ratings": None,
                          "error": str(e), "searches": {}})
    finally:
        ex.close()
    return cases


def stream_case(fen: str, lines: list[str]) -> dict:
    """What analyse_stream makes of a search's info lines, info by info: the lines it keeps, and at each fresh one
    the snapshot it would send and the cache rows it would store."""
    board = chess.Board(fen)
    kept: dict[int, dict] = {}
    nodes, steps = 0, []
    for line in lines:
        token, rest = chess.engine._next_token(line)
        if token != "info":
            continue
        info = chess.engine._parse_uci_info(rest, board)
        nodes = max(nodes, info.get("nodes", 0))
        fresh = "pv" in info and info["pv"] and "multipv" in info and "score" in info
        if fresh:
            kept[info["multipv"]] = info
        step = {"nodes": nodes, "fresh": bool(fresh)}
        if kept:
            step["snapshot"] = explore._lines_snapshot(board, kept)
        if fresh and 1 in kept:
            main, ranks = explore._lines_rows(kept, nodes)
            step["rows"] = [main, ranks]
        steps.append(step)
    return {"fen": fen, "lines": lines, "steps": steps}


def stream_cases(cases: list[dict]) -> list[dict]:
    out = [stream_case(f, lines) for f, lines in SYNTHETIC_LINES]
    seen = set()
    for c in cases:
        for f, lines in c["searches"].items():
            if lines and f not in seen and len(out) < 12:
                seen.add(f)
                out.append(stream_case(f, lines))
    return out


def after_cases() -> list[dict]:
    """_after_from_line on made-up lines: every sign of mate, a missing score, a one-move pv."""
    ranks = [{"rank": 1, "move": "e2e4", "eval_cp": None, "mate_in": 3, "pv": ["e2e4", "e7e5", "d1h5"]},
             {"rank": 2, "move": "d2d4", "eval_cp": None, "mate_in": 1, "pv": ["d2d4"]},
             {"rank": 3, "move": "g1f3", "eval_cp": None, "mate_in": -2, "pv": ["g1f3", "f7f6"]},
             {"rank": 4, "move": "c2c4", "eval_cp": 0, "mate_in": None, "pv": ["c2c4", "c7c5"]},
             {"rank": 5, "move": "b2b3", "eval_cp": -35, "mate_in": None, "pv": ["b2b3"]},
             {"rank": 6, "move": "a2a3", "eval_cp": None, "mate_in": None, "pv": ["a2a3"]}]
    return [{"ranks": ranks, "uci": u, "nodes": 1234, "after": explore._after_from_line(ranks, u, 1234)}
            for u in ("e2e4", "d2d4", "g1f3", "c2c4", "b2b3", "a2a3", "h2h4")]


def legal_cases() -> list[dict]:
    ex = explore.Explorer()
    return [{"fen": f, **ex.legal(f)} for f in [chess.STARTING_FEN, *SPECIAL_FENS]]


def explore_dump() -> dict:
    rec = Recorder()
    log = logging.getLogger("chess.engine")
    log.setLevel(logging.DEBUG)
    log.addHandler(rec)
    moves = move_cases(rec)
    return {"nodes": EXPLORE_NODES, "multipv": MULTIPV_N, "legal": legal_cases(), "moves": moves,
            "streams": stream_cases(moves), "after": after_cases()}


def main() -> None:
    if not STOCKFISH.exists() or not book.BOOK_DIR.exists():
        sys.exit("needs bin/stockfish (or $STOCKFISH) and data/book (scripts/fetch_book.sh, or --data)")
    try:
        is_book = book.is_book
        write(OUT / "site.json", [site_case(c) for c in json.loads((OUT / "storage.json").read_text(encoding="utf-8"))])
        if ARGS.local:
            for f in sorted((OUT / "local").glob("storage-*.json")):
                c = json.loads(f.read_text(encoding="utf-8"))
                write(OUT / "local" / f"site-{c['name']}.json", site_case(c))
        book.is_book = is_book
        write(OUT / "explore.json", explore_dump())
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    main()
