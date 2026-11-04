"""A data directory as the Python app left it, for js/server/migrate.test.js: the storage parity cases
(tests/parity/storage.json) as two profiles over one evals.duckdb, puzzle progress with a reset and a line cut short,
an own-puzzle record, and an account set aside in .accounts/. The schemas are the Python app's, frozen here.

    python legacy/make_fixture.py <dir>        (needs duckdb)
"""

import json
import os
import sys
import tempfile
from pathlib import Path

import duckdb

STORAGE = Path(__file__).resolve().parent.parent / "tests" / "parity" / "storage.json"

EVALS_DUCKDB = """
CREATE TABLE IF NOT EXISTS evals (
    fen_key   TEXT PRIMARY KEY,
    nodes     INTEGER,
    eval_cp   INTEGER,
    mate_in   INTEGER,
    best_move TEXT,
    pv        TEXT[]
);
CREATE TABLE IF NOT EXISTS evals_multipv (
    fen_key   TEXT,
    rank      INTEGER,
    move      TEXT,
    eval_cp   INTEGER,
    mate_in   INTEGER,
    pv        TEXT[],
    PRIMARY KEY (fen_key, rank)
);
"""
MOVES_SCHEMA = (("game_id", "VARCHAR"), ("ply", "INTEGER"), ("side_to_move", "VARCHAR"), ("is_mine", "BOOLEAN"),
                ("move_played", "VARCHAR"), ("san", "VARCHAR"), ("best_move", "VARCHAR"), ("best_san", "VARCHAR"),
                ("n_legal", "INTEGER"), ("is_forced", "BOOLEAN"), ("in_book", "BOOLEAN"), ("wp_before", "DOUBLE"),
                ("wp_after", "DOUBLE"), ("wp_loss", "DOUBLE"), ("accuracy", "DOUBLE"), ("label", "VARCHAR"),
                ("only_move", "BOOLEAN"), ("clock_remaining", "INTEGER"), ("time_spent", "INTEGER"))
GAMES_SCHEMA = (("game_id", "VARCHAR"), ("played_at", "TIMESTAMP"), ("time_control", "VARCHAR"),
                ("time_class", "VARCHAR"), ("my_colour", "VARCHAR"), ("my_rating", "INTEGER"),
                ("opponent_rating", "INTEGER"), ("result", "VARCHAR"), ("termination", "VARCHAR"), ("eco", "VARCHAR"),
                ("opening_name", "VARCHAR"), ("opponent", "VARCHAR"), ("my_name", "VARCHAR"))
POSITIONS_SCHEMA = (("game_id", "VARCHAR"), ("ply", "INTEGER"), ("fen", "VARCHAR"), ("move_played", "VARCHAR"),
                    ("side_to_move", "VARCHAR"), ("clock_remaining", "INTEGER"))


def sql_path(p) -> str:
    return "'" + str(p).replace("\\", "/").replace("'", "''") + "'"


def write_parquet(rows: list[dict], schema: tuple, path: Path) -> None:
    """rows as a parquet file with schema's columns, as the Python app's db.write_parquet wrote them."""
    columns = "{" + ", ".join(f"'{name}': '{sql_type}'" for name, sql_type in schema) + "}"
    fd, tmp = tempfile.mkstemp(suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(rows, ensure_ascii=False))
        duckdb.connect().execute(f"""
            COPY (SELECT * FROM read_json({sql_path(tmp)}, format = 'array', columns = {columns}))
            TO {sql_path(path)} (FORMAT parquet)
        """)
    finally:
        os.unlink(tmp)


def _jsonl(path: Path, rows: list, tail: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows) + tail, encoding="utf-8")


def _profile(folder: Path, case: dict) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "meta.json").write_text(json.dumps({"source": case["source"], "username": case["username"],
                                                  "created": "2026-01-01T00:00:00+00:00"}), encoding="utf-8")
    write_parquet(case["games"], GAMES_SCHEMA, folder / "games.parquet")
    write_parquet(case["positions"], POSITIONS_SCHEMA, folder / "positions.parquet")
    write_parquet(case["moves"], MOVES_SCHEMA, folder / "moves.parquet")
    (folder / "moves.fp.json").write_text(json.dumps({g["game_id"]: "x" for g in case["games"]}), encoding="utf-8")


def make_fixture(data) -> None:
    data = Path(data)
    cases = json.loads(STORAGE.read_text(encoding="utf-8"))
    for c in cases:
        _profile(data / "profiles" / c["name"], c)
    con = duckdb.connect(str(data / "evals.duckdb"))
    con.execute(EVALS_DUCKDB)
    for c in cases:
        con.executemany("INSERT OR IGNORE INTO evals VALUES (?, ?, ?, ?, ?, ?)",
                        [[r["fen_key"], r["nodes"], r["eval_cp"], r["mate_in"], r["best_move"], r["pv"]] for r in c["cache"]["evals"]])
        con.executemany("INSERT OR IGNORE INTO evals_multipv VALUES (?, ?, ?, ?, ?, ?)",
                        [[r["fen_key"], r["rank"], r["move"], r["eval_cp"], r["mate_in"], r["pv"]] for r in c["cache"]["multipv"]])
    con.close()
    attempt = lambda i, solved, rating=1500: {"id": f"p{i}", "ts": 1760000000 + i, "solved": solved, "ms": 1000 * i,
                                              "hinted": not solved and i % 2 == 0, "rating": rating}
    _jsonl(data / "puzzle_attempts.reset-20261001-120000.jsonl", [attempt(1, True), attempt(2, False)])
    _jsonl(data / "puzzle_attempts.reset-20261001-120000-2.jsonl", [attempt(3, False)])
    _jsonl(data / "puzzle_attempts.jsonl", [attempt(4, True, 1720), attempt(5, False)], tail='{"id": "p6", "ts"')
    _jsonl(data / "puzzle_solved.jsonl", [{"id": "p2", "ts": 1760000100}])
    _jsonl(data / "puzzle_daily.jsonl", [{"date": "2026-10-20", "n": 12, "id": "d1", "solved": True, "clean": False,
                                          "ms": 5400, "marks": ["e2e4", "Ünïcode"]}])
    own = data / "profiles" / cases[0]["name"]
    _jsonl(own / "puzzle_attempts.jsonl", [{"id": "own1", "ts": 1760000200, "solved": True, "ms": None, "hinted": False}])
    away = data / ".accounts" / "guest"
    _profile(away / "profiles" / cases[1]["name"], cases[1])
    _jsonl(away / "puzzle_attempts.jsonl", [attempt(9, True)])


if __name__ == "__main__":
    make_fixture(sys.argv[1])
