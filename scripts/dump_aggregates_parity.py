"""Parity dumps for the JavaScript port's aggregates and export (docs/js-port.md, round 2 `aggregates`): aggregates'
query_all, render and game_accuracies, and export's two CSV files, run by the Python code on profiles made from
tests/parity/storage.json, written to tests/parity/aggregates.json, which js/server/aggregates.test.js replays on
SQLite. Also the end-to-end case: raw chess.com archives and lichess exports through normalise.build, whose rows
js/server/games.test.js gets to through a fake fetch.

    python scripts/dump_aggregates_parity.py            the fixtures (run dump_storage_parity.py first)
    python scripts/dump_aggregates_parity.py --local    also every profile in data/profiles with its moves and evals,
                                                        to tests/parity/local/aggregates-<id>.json (gitignored)

A case's input is either a storage.json case (`base`, its index) with games of its own: each game's positions and
moves are those of the base game `copy` names (the same game_id when not named), plus `extra_positions` and
`extra_evals`, the evals being the base's cache and results; or, for --local, every row as it is (`rows`).
No engine is needed. Everything runs in a scratch data directory; --data is only read (--local's profiles and evals).
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

_args = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
_args.add_argument("--local", action="store_true", help="also dump every profile in data/profiles to tests/parity/local/")
_args.add_argument("--data", type=Path, default=ROOT / "data", help="the data directory to read --local's profiles from")
ARGS = _args.parse_args()
SOURCE = ARGS.data.resolve()
SCRATCH = Path(tempfile.mkdtemp(prefix="aggregates-parity-"))
os.environ["CHESS_REVIEW_DATA"] = str(SCRATCH)        # before chess_review is imported: every path it has goes here

from chess_review import aggregates, analyse, classify, export, normalise, profiles  # noqa: E402
from chess_review.db import connect, dicts, write_parquet  # noqa: E402
from chess_review.fen import fen_key  # noqa: E402

EVAL_COLS = ("fen_key", "nodes", "eval_cp", "mate_in", "best_move", "pv")


def plain(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, tuple):
        return list(v)
    if isinstance(v, float) and v != v:
        return "NaN"            # JSON has no NaN; the JS test reads it back as one
    return v


def deep(v):
    if isinstance(v, dict):
        return {k: deep(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [deep(x) for x in v]
    return plain(v)


def rows_of(con, sql: str, params=()) -> list[dict]:
    return [{k: plain(v) for k, v in r.items()} for r in dicts(con.execute(sql, list(params)))]


def expand(storage: list[dict], inp: dict) -> dict:
    """A case's input as rows: {games, positions, moves, evals}. aggregates.test.js has the same function."""
    if "rows" in inp:
        return inp["rows"]
    base = storage[inp["base"]]
    copy = inp.get("copy", {})
    positions, moves = [], []
    for g in inp["games"]:
        src = copy.get(g["game_id"], g["game_id"])
        positions += [{**r, "game_id": g["game_id"]} for r in base["positions"] if r["game_id"] == src]
        if not inp.get("no_moves"):
            moves += [{**r, "game_id": g["game_id"]} for r in base["moves"] if r["game_id"] == src]
    positions += inp.get("extra_positions", [])
    evals = {r["fen_key"]: r for r in base["cache"]["evals"]}
    for k, m, _ in base["results"]:
        evals.setdefault(k, {"fen_key": k, **{c: m[c] for c in EVAL_COLS[1:]}})
    for r in inp.get("extra_evals", []):
        evals.setdefault(r["fen_key"], r)
    return {"games": inp["games"], "positions": positions, "moves": moves, "evals": list(evals.values())}


def run(name: str, source: str, username: str, rows: dict) -> dict:
    """aggregates and export for one profile with these rows, as the Python code answers."""
    p = profiles.create(source, username)
    games = [{**g, "played_at": datetime.fromisoformat(g["played_at"]) if g["played_at"] else None} for g in rows["games"]]
    write_parquet(games, normalise.GAMES_SCHEMA, p.games_parquet)
    write_parquet(rows["positions"], normalise.POSITIONS_SCHEMA, p.positions_parquet)
    write_parquet(rows["moves"], classify.MOVES_SCHEMA, p.moves_parquet)
    analyse.EVALS_DB.unlink(missing_ok=True)
    con = analyse.open_db()
    if rows["evals"]:
        con.executemany("INSERT INTO evals VALUES (?, ?, ?, ?, ?, ?)", [[r[c] for c in EVAL_COLS] for r in rows["evals"]])
    con.close()
    con = connect(p)
    acc = aggregates.game_accuracies(con)
    d = aggregates.query_all(con)
    con.close()
    html = aggregates.render(d, p.username, p.id)
    export.main(["--profile", p.id])
    case = {"name": name, "source": source, "username": username, "id": p.id,
            "accuracies": acc, "out": deep(d), "html": html,
            "export": {f: (p.export_dir / f).read_text(encoding="utf-8") for f in ("games.csv", "positions_evals.csv")}}
    shutil.rmtree(p.dir)
    return case


# ECO codes with how many of the mixed profile's games have each: ten with 3 or more (the heatmap's top ten, no tie at
# the cut), three below the by_eco minimum, and games without one
ECOS = [("B01", 7), ("C41", 6), ("A00", 5), ("B20", 4), ("C00", 4), ("D02", 3), ("E60", 3), ("A45", 3), ("B10", 3),
        ("C50", 3), ("D00", 2), ("E00", 2), ("A04", 1), (None, 2)]

# endgame entries: (fen, eval_cp, mate_in) of the positions after a middlegame one; None: no eval for it
ENDGAMES = [
    ([("8/5k2/8/8/8/8/3R4/4K3 w - - 0 50", 420, None)], "white", "win"),
    ([("8/5k2/3n4/8/8/8/3R4/4K3 b - - 0 50", -35, None)], "white", "draw"),
    ([("8/5k2/3n4/8/8/8/3R4/4K3 w - - 0 50", 60, None)], "black", "loss"),
    ([("4k3/8/8/3b4/8/8/3N4/4K3 w - - 0 40", None, None), ("4k3/8/8/3b4/8/8/3N4/5K2 b - - 1 40", 10, None)], "white", "draw"),
    ([("r3k3/8/8/8/8/8/8/R3K3 w - - 0 30", None, 3)], "black", "loss"),
    ([("r3k3/8/8/8/8/8/8/R3K3 b - - 0 30", 0, None)], "white", "win"),
    ([("4k3/8/8/8/8/8/8/1NB1K3 w - - 0 60", 250, None)], "white", None),
    ([("q3k3/8/8/8/8/8/8/4K3 w - - 0 60", -900, None)], "white", "loss"),        # 9 points: not an endgame
    ([("4k3/8/8/8/8/8/8/1NB1K3 b - - 0 60", None, -2)], "white", "win"),
    ([("8/8/4k3/8/8/4K3/8/8 w - - 0 70", 0, None)], "black", "draw"),
]
MIDDLEGAME = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"


def mixed(storage: list[dict]) -> dict:
    """The fuzz games again under many ids, with ECO codes, results, time classes, dates (two on the same second,
    some missing) and ratings, plus made-up endgames: something in every table of the page."""
    fuzz = storage[1]
    srcs = [g["game_id"] for g in fuzz["games"]]
    by_id = {g["game_id"]: g for g in fuzz["games"]}
    games, copy = [], {}
    ecos = [e for e, n in ECOS for _ in range(n)]
    results = ["win", "loss", "draw", "win", None, "loss", "win"]
    classes = ["blitz", "rapid", "bullet", None, "blitz", "daily"]
    t0 = datetime(2025, 1, 1, 9, 30, 0)
    for i, eco in enumerate(ecos):
        src = srcs[(i * 5) % len(srcs)]
        gid = f"mixed-{i:02d}"
        copy[gid] = src
        t = t0 + timedelta(days=i, hours=i % 5)
        if i % 13 == 7:
            t = t0 + timedelta(days=i - 1, hours=(i - 1) % 5)      # the same second as the game before
        games.append({**by_id[src], "game_id": gid, "eco": eco, "opening_name": f"{eco} line {i % 3}" if eco else None,
                      "result": results[i % len(results)], "time_class": classes[i % len(classes)],
                      "played_at": None if i % 11 == 4 else t.isoformat(), "my_rating": None if i % 9 == 2 else 1200 + 7 * i,
                      "opponent_rating": 1250 - 3 * i})
    extra_positions, extra_evals = [], {}
    for j, (line, colour, result) in enumerate(ENDGAMES):
        gid = f"mixed-end-{j}"
        games.append({"game_id": gid, "played_at": (t0 + timedelta(days=100 + j)).isoformat(), "time_control": "180",
                      "time_class": "blitz", "my_colour": colour, "my_rating": None, "opponent_rating": None,
                      "result": result, "termination": None, "eco": "C41", "opening_name": "C41 endgame",
                      "opponent": "x", "my_name": "fuzz"})
        fens = [(MIDDLEGAME, 30, None)] + line
        for ply, (fen, cp, mate) in enumerate(fens):
            stm = "white" if fen.split(" ")[1] == "w" else "black"
            extra_positions.append({"game_id": gid, "ply": ply, "fen": fen, "move_played": None, "side_to_move": stm,
                                    "clock_remaining": None})
            if cp is not None or mate is not None:
                extra_evals.setdefault(fen_key(fen), {"fen_key": fen_key(fen), "nodes": 1, "eval_cp": cp, "mate_in": mate,
                                                      "best_move": None, "pv": []})
    return {"base": 1, "games": games, "copy": copy, "extra_positions": extra_positions,
            "extra_evals": list(extra_evals.values())}


def fixtures() -> list[dict]:
    storage = json.loads((OUT / "storage.json").read_text(encoding="utf-8"))
    inputs = [
        ("testuser", "pgn", "testuser", {"base": 0, "games": storage[0]["games"]}),
        ("fuzz", "pgn", "fuzz", {"base": 1, "games": storage[1]["games"]}),
        ("mixed", "chesscom", "Mixed<&>'User\"", mixed(storage)),
        ("unanalysed", "lichess", "nobody", {"base": 0, "games": storage[0]["games"], "no_moves": True}),
    ]
    cases = []
    for name, source, username, inp in inputs:
        case = run(name, source, username, expand(storage, inp))
        case["input"] = inp
        cases.append(case)
    return cases


def pipeline() -> dict:
    """Raw files as ingest writes them, through normalise.build: a chess.com profile (two months, the games of
    normalise.json's chess.com cases for its most common player) and a lichess one (likewise, one .ndjson a month)."""
    dumped = json.loads((OUT / "normalise.json").read_text(encoding="utf-8"))
    out = {}
    for source in ("chesscom", "lichess"):
        cases = dumped[source]
        users = [c["username"] for c in cases]
        user = max(sorted(set(users)), key=users.count)
        gs = [c["g"] for c in cases if c["username"] == user]
        p = profiles.create(source, user)
        p.raw_dir.mkdir(parents=True, exist_ok=True)
        raw = {}
        if source == "chesscom":
            half = len(gs) // 2
            raw["2024-01.json"] = json.dumps({"games": gs[:half]})
            raw["2024-02.json"] = json.dumps({"games": gs[half:]})
        else:
            for g in sorted(gs, key=lambda g: g.get("createdAt", 0)):
                m = datetime.fromtimestamp(g.get("createdAt", 0) // 1000, timezone.utc).strftime("%Y-%m")
                raw[f"{m}.ndjson"] = raw.get(f"{m}.ndjson", "") + json.dumps(g, separators=(",", ":")) + "\n"
        for f, text in raw.items():
            (p.raw_dir / f).write_text(text, encoding="utf-8")
        stats = normalise.build(p)
        con = connect(p)
        out[source] = {"username": user, "id": p.id, "raw": raw, "stats": stats,
                       "games": rows_of(con, "SELECT * FROM games ORDER BY game_id"),
                       "positions": rows_of(con, "SELECT * FROM positions ORDER BY game_id, ply")}
        con.close()
        shutil.rmtree(p.dir)
    return out


def local() -> None:
    import duckdb

    out = OUT / "local"
    out.mkdir(parents=True, exist_ok=True)
    evdb = duckdb.connect(str(SOURCE / "evals.duckdb"), read_only=True)
    for src in sorted((SOURCE / "profiles").iterdir()):
        if not all((src / f).exists() for f in ("games.parquet", "positions.parquet", "moves.parquet", "meta.json")):
            continue
        m = json.loads((src / "meta.json").read_text(encoding="utf-8"))
        con = duckdb.connect()
        read = lambda f: rows_of(con, f"SELECT * FROM read_parquet('{src / f}')")  # noqa: E731
        rows = {"games": read("games.parquet"), "positions": read("positions.parquet"), "moves": read("moves.parquet")}
        con.close()
        keys = sorted({fen_key(r["fen"]) for r in rows["positions"]})
        evdb.execute("CREATE OR REPLACE TEMP TABLE want (fen_key TEXT)")
        evdb.executemany("INSERT INTO want VALUES (?)", [[k] for k in keys])
        rows["evals"] = rows_of(evdb, "SELECT e.* FROM evals e JOIN want USING (fen_key) ORDER BY fen_key")
        case = run(src.name, m["source"], m["username"], rows)
        case["input"] = {"rows": rows}
        path = out / f"aggregates-{case['id']}.json"
        path.write_text(json.dumps(case, separators=(",", ":"), default=plain), encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


def main() -> None:
    try:
        data = {"cases": fixtures(), "pipeline": pipeline()}
        path = OUT / "aggregates.json"
        path.write_text(json.dumps(data, separators=(",", ":"), default=plain, allow_nan=False), encoding="utf-8",
                        newline="\n")
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")
        if ARGS.local:
            local()
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    main()
