"""Parity dumps for the JavaScript port's storage (docs/js-port.md, round 1 `storage`): profiles' games and positions
through the Python database code -- normalise's parquet, the evals cache, analyse.pending_keys, classify.build,
classify.load_multipv, profiles.summary -- written with their inputs to tests/parity/storage.json, which
js/server/storage.test.js replays on SQLite.

    python scripts/dump_storage_parity.py            the fixtures: tests/fixtures/clocks.pgn through normalise, and the
                                                     made-up games of tests/parity/games.json (run dump_parity.py first)
    python scripts/dump_storage_parity.py --local    also every profile in data/profiles with its real evals, to
                                                     tests/parity/local/storage-<id>.json (gitignored)

Everything runs in a scratch data directory; data/ is only read (the book, and --local's profiles and evals).
Needs bin/stockfish (or $STOCKFISH) and data/book, as dump_parity.py; --data points at another data directory
(the one with the book and the profiles, e.g. the main checkout's from a worktree).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OUT = ROOT / "tests" / "parity"
FIXTURE = ROOT / "tests" / "fixtures" / "clocks.pgn"
NODES = 20_000
NOW = datetime(2026, 10, 23, 12, 0, 0, tzinfo=timezone.utc)     # profiles.summary's "now"
EVAL_FIELDS = ("eval_cp", "mate_in", "best_move", "pv")

_args = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
_args.add_argument("--local", action="store_true", help="also dump every profile in data/profiles to tests/parity/local/")
_args.add_argument("--data", type=Path, default=ROOT / "data", help="the data directory to read the book (and --local's profiles) from")
ARGS = _args.parse_args()
SOURCE = ARGS.data.resolve()
SCRATCH = Path(tempfile.mkdtemp(prefix="storage-parity-"))
os.environ["CHESS_REVIEW_DATA"] = str(SCRATCH)        # before chess_review is imported: every path it has goes here

import chess  # noqa: E402
import chess.engine  # noqa: E402

from chess_review import analyse, book, classify, normalise, profiles  # noqa: E402
from chess_review.config import STOCKFISH  # noqa: E402
from chess_review.db import connect, dicts, write_parquet  # noqa: E402
from chess_review.fen import board_from_key  # noqa: E402

book.BOOK_DIR = SOURCE / "book"


class FixedNow(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz else NOW.replace(tzinfo=None)


profiles.datetime = FixedNow


def plain(v):
    """A value from DuckDB as JSON has it: datetimes as isoformat (what the JS side stores), lists as lists."""
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, tuple):
        return list(v)
    return v


def rows_of(con, sql: str, params=()) -> list[dict]:
    return [{k: plain(v) for k, v in r.items()} for r in dicts(con.execute(sql, list(params)))]


def pending(con, p, game_id=None) -> dict:
    keys, stats = analyse.pending_keys(con, p, game_id)
    return {"game_id": game_id, "keys": sorted(keys), "stats": stats}


def games_json(p, games: list[dict]) -> str:
    """A site/games.json for summary() to read, made from the games rows (site.py's index has more fields)."""
    entries = [{"id": g["game_id"], "played_at": g["played_at"], "time_class": g["time_class"], "my_rating": g["my_rating"],
                "analysed": (i % 3) / 2} for i, g in enumerate(games)]
    # around "now", in several classes and in every form played_at comes in, for the 7-day deltas and _parse_ts
    forms = [lambda t: t.isoformat(), lambda t: t.isoformat() + "Z", lambda t: t.replace(tzinfo=timezone.utc).isoformat(),
             lambda t: (t.isoformat() + "+02:00"), lambda t: t.strftime("%Y-%m-%d %H:%M"), lambda t: t.date().isoformat(),
             lambda t: t.isoformat(timespec="microseconds"), lambda t: "not a date", lambda t: None, lambda t: ""]
    classes = ["blitz", "rapid", None, "bullet", "daily"]
    base = NOW.replace(tzinfo=None)
    for i in range(30):
        t = base - timedelta(days=i * 0.7, hours=i)
        entries.append({"id": f"extra-{i}", "played_at": forms[i % len(forms)](t), "time_class": classes[i % len(classes)],
                        "my_rating": None if i % 7 == 3 else 1000 + 17 * i - (i % 4) * 40, "analysed": 1.0 if i % 2 else 0.9989})
    text = json.dumps({"games": entries})
    p.site_dir.mkdir(parents=True, exist_ok=True)
    (p.site_dir / "games.json").write_text(text, encoding="utf-8")
    return text


def profile_case(p, cache_rows=None, results=None) -> dict:
    """Everything the database answers for profile p, which has its games/positions parquet. cache_rows: evals and
    evals_multipv rows to put in the cache first, as they are; results: [(key, main, ranks)] written after that
    through analyse.write_results. Each case starts from an empty cache."""
    analyse.EVALS_DB.unlink(missing_ok=True)
    analyse.EVALS_PARQUET.unlink(missing_ok=True)
    con = analyse.open_db()
    if cache_rows:
        con.executemany("INSERT INTO evals VALUES (?, ?, ?, ?, ?, ?)", [[r[k] for k, _ in EVALS] for r in cache_rows["evals"]])
        if cache_rows["multipv"]:
            con.executemany("INSERT INTO evals_multipv VALUES (?, ?, ?, ?, ?, ?)", [[r[k] for k, _ in EVALS_MPV] for r in cache_rows["multipv"]])
    con.close()
    view = connect(p)
    games = rows_of(view, "SELECT * FROM games ORDER BY game_id")
    positions = rows_of(view, "SELECT * FROM positions ORDER BY game_id, ply")
    first = games[0]["game_id"]
    case = {"name": p.id, "source": p.source, "username": p.username, "games": games,
            "positions": [{k: v for k, v in r.items() if k != "fen_key"} for r in positions],
            "fen_keys": [r["fen_key"] for r in positions],
            "cache": cache_rows or {"evals": [], "multipv": []}, "results": [],
            "pending_before": [pending(view, p), pending(view, p, first)]}
    view.close()
    if results:
        con = analyse.open_db()
        analyse.write_results(con, results)
        con.close()
        case["results"] = [[k, m, r] for k, m, r in results]
    view = connect(p)
    case["pending_after"] = [pending(view, p), pending(view, p, first)]
    case["multipv_game"] = {k: sorted(v, key=lambda m: m["rank"]) for k, v in classify.load_multipv(view, first).items()}
    view.close()
    stats = classify.build(p)
    again = classify.build(p)          # the second build keeps every game's moves (fingerprints unchanged)
    assert again["moves"] == stats["moves"]
    view = connect(p)
    case["moves"] = rows_of(view, "SELECT * FROM moves ORDER BY game_id, ply")
    view.close()
    case["build"] = {"moves": stats["moves"], "games": stats["games"],
                     "distribution": sorted([list(d) for d in stats["distribution"]], key=lambda d: (-d[1], d[0] or ""))}
    case["games_json"] = games_json(p, games)
    profiles.add_unseen(p.id, [g["game_id"] for g in games[:2]])
    profiles.set_pinned(p.id, True)
    case["meta_json"] = p.meta_json.read_text(encoding="utf-8")
    case["summary"] = p.summary()
    case["now"] = NOW.isoformat()
    return case


EVALS = (("fen_key", 0), ("nodes", 0), ("eval_cp", 0), ("mate_in", 0), ("best_move", 0), ("pv", 0))
EVALS_MPV = (("fen_key", 0), ("rank", 0), ("move", 0), ("eval_cp", 0), ("mate_in", 0), ("pv", 0))


def search(keys: list[str]) -> list[tuple]:
    eng = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH))
    eng.configure({"Threads": 1, "Hash": 16})
    try:
        out = []
        for k in keys:
            main, ranks = analyse.evaluate_multipv(board_from_key(k), eng, chess.engine.Limit(nodes=NODES))
            out.append((k, main, ranks))
        return out
    finally:
        eng.quit()


def fixtures() -> list[dict]:
    cases = []
    # 1. the PGN fixture through normalise, half its positions cached already and the rest searched now
    p = profiles.create("pgn", "testuser")
    p.pgn_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(FIXTURE, p.pgn_dir / "fixture.pgn")
    normalise.build(p)
    con = connect(p)
    keys = [r[0] for r in con.execute("SELECT fen_key FROM positions GROUP BY fen_key ORDER BY min(game_id), min(ply)").fetchall()]
    con.close()
    results = search(keys)
    pre, post = results[::2], results[1::2]
    cache = {"evals": [{"fen_key": k, **{f: m[f] for f in ("nodes", "eval_cp", "mate_in", "best_move", "pv")}} for k, m, _ in pre],
             "multipv": [{"fen_key": k, **r} for k, _, ranks in pre for r in ranks]
                        + [{"fen_key": k, "rank": 0, "move": None, "eval_cp": m["eval_cp"], "mate_in": m["mate_in"], "pv": []}
                           for k, m, ranks in pre if not ranks]}
    cases.append(profile_case(p, cache, post))
    # 2. the made-up games of games.json (classify's every branch), their evals in the cache as they were dumped
    dumped = json.loads((OUT / "games.json").read_text(encoding="utf-8"))
    p = profiles.create("pgn", "fuzz")
    games, positions, evals, multipv = [], [], {}, {}
    for c in dumped:
        if not c["name"].startswith("fuzz-"):
            continue
        games.append({**c["game"], "played_at": datetime(2026, 1, 1 + len(games), 10, 0, 0), "time_class": "blitz"})
        for r in c["rows"]:
            positions.append({k: v for k, v in r.items() if k not in EVAL_FIELDS + ("fen_key",)})
            evals.setdefault(r["fen_key"], {"fen_key": r["fen_key"], "nodes": 1, **{f: r[f] for f in EVAL_FIELDS}})
        for k, lines in c["multipv"].items():
            multipv.setdefault(k, lines)
    write_parquet(games, normalise.GAMES_SCHEMA, p.games_parquet)
    write_parquet(positions, normalise.POSITIONS_SCHEMA, p.positions_parquet)
    keys = list(evals)
    cached = set(keys[: len(keys) * 2 // 3])          # a third of the positions stay pending
    cache = {"evals": [evals[k] for k in keys if k in cached],
             "multipv": [{"fen_key": k, **{f: m[f] for f in ("rank", "move", "eval_cp", "mate_in", "pv")}}
                         for k in keys if k in cached for m in multipv.get(k, [])]}
    cases.append(profile_case(p, cache))
    cases[-1]["book"] = sorted({k for c in dumped if c["name"].startswith("fuzz-") for k in c["book"]})
    cases[0]["book"] = sorted(k for k in set(cases[0]["fen_keys"]) if book.is_book(k))
    return cases


def local() -> None:
    import duckdb

    out = OUT / "local"
    out.mkdir(parents=True, exist_ok=True)
    evdb = duckdb.connect(str(SOURCE / "evals.duckdb"), read_only=True)
    for src in sorted((SOURCE / "profiles").iterdir()):
        if not (src / "positions.parquet").exists() or not (src / "meta.json").exists():
            continue
        m = json.loads((src / "meta.json").read_text(encoding="utf-8"))
        p = profiles.create(m["source"], m["username"])
        for f in ("games.parquet", "positions.parquet"):
            shutil.copy(src / f, p.dir / f)
        con = connect(p)
        keys = sorted({r[0] for r in con.execute("SELECT fen_key FROM positions").fetchall()})
        con.close()
        evdb.execute("CREATE OR REPLACE TEMP TABLE want (fen_key TEXT)")
        evdb.executemany("INSERT INTO want VALUES (?)", [[k] for k in keys])
        cache = {"evals": rows_of(evdb, "SELECT e.* FROM evals e JOIN want USING (fen_key) ORDER BY fen_key"),
                 "multipv": rows_of(evdb, "SELECT m.* FROM evals_multipv m JOIN want USING (fen_key) ORDER BY fen_key, rank")}
        case = profile_case(p, cache)
        case["book"] = sorted(k for k in keys if book.is_book(k))
        path = out / f"storage-{p.id}.json"
        path.write_text(json.dumps(case, separators=(",", ":"), default=plain), encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")
        shutil.rmtree(p.dir)


def main() -> None:
    if not STOCKFISH.exists() or not book.BOOK_DIR.exists():
        sys.exit("needs bin/stockfish (or $STOCKFISH) and data/book (scripts/fetch_book.sh, or --data)")
    try:
        cases = fixtures()
        path = OUT / "storage.json"
        path.write_text(json.dumps(cases, separators=(",", ":"), default=plain), encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")
        if ARGS.local:
            for d in (SCRATCH / "profiles").iterdir():
                shutil.rmtree(d)
            local()
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    main()
