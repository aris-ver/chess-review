"""chess_review/migrate_sqlite: the export to the JS port's SQLite files. js/server/migrate.test.js opens the same
fixture's files with the JS Store (make_fixture is shared with it)."""

import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path

import duckdb

from chess_review import migrate_sqlite as M
from chess_review.analyse import SCHEMA as EVALS_DUCKDB
from chess_review.classify import MOVES_SCHEMA
from chess_review.db import write_parquet
from chess_review.normalise import GAMES_SCHEMA, POSITIONS_SCHEMA

STORAGE = Path(__file__).parent / "parity" / "storage.json"


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
    """A data directory as the Python app leaves it: the storage parity cases as two profiles over one evals.duckdb,
    puzzle progress with a reset and a line cut short, an own-puzzle record, and an account set aside in .accounts/."""
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


def _digest(folder: Path) -> dict:
    return {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(folder.rglob("*")) if p.is_file()}


def _all(path: Path, sql: str) -> list[tuple]:
    con = sqlite3.connect(path)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


def test_export_writes_db_js_layout_and_leaves_the_old_files(tmp_path):
    make_fixture(tmp_path)
    before = _digest(tmp_path)
    res = M.migrate(tmp_path)
    assert res["status"] == "done"
    after = _digest(tmp_path)
    assert {k: v for k, v in after.items() if k in before} == before        # the old files untouched
    new = sorted(set(after) - set(before))
    assert new == [".accounts/guest/profiles/pgn-fuzz/games.sqlite", ".accounts/guest/progress.sqlite",
                   "evals.sqlite", "profiles/pgn-fuzz/games.sqlite", "profiles/pgn-testuser/games.sqlite",
                   "progress.sqlite", M.MARKER]

    cases = json.loads(STORAGE.read_text(encoding="utf-8"))
    ev = tmp_path / "evals.sqlite"
    assert _all(ev, "PRAGMA user_version") == [(M.SCHEMA_VERSION,)]
    keys = {r["fen_key"] for c in cases for r in c["cache"]["evals"]}
    assert _all(ev, "SELECT count(*) FROM evals") == [(len(keys),)]
    start = _all(ev, "SELECT pv FROM evals WHERE fen_key = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'")
    assert json.loads(start[0][0]) == cases[0]["cache"]["evals"][0]["pv"]

    db = tmp_path / "profiles" / "pgn-fuzz" / "games.sqlite"
    assert _all(db, "SELECT count(*) FROM positions") == [(len(cases[1]["positions"]),)]
    assert [r[0] for r in _all(db, "SELECT fen_key FROM positions ORDER BY game_id, ply")] == cases[1]["fen_keys"]
    assert _all(db, "SELECT count(*) FROM moves") == [(len(cases[1]["moves"]),)]
    assert _all(db, "SELECT count(*) FROM move_fingerprints") == [(0,)]          # reclassified after the switch
    assert {type(v) for (v,) in _all(db, "SELECT is_mine FROM moves")} == {int}

    prog = tmp_path / "progress.sqlite"
    assert _all(prog, "SELECT seq, archive, id, solved, hinted, rating FROM puzzle_attempts ORDER BY seq") == [
        (1, "reset-20261001-120000", "p1", 1, 0, 1500), (2, "reset-20261001-120000", "p2", 0, 1, 1500),
        (3, "reset-20261001-120000-2", "p3", 0, 0, 1500), (4, None, "p4", 1, 0, 1720), (5, None, "p5", 0, 0, 1500)]
    assert _all(prog, "SELECT marks FROM puzzle_daily") == [('["e2e4","Ünïcode"]',)]
    assert _all(tmp_path / "profiles" / "pgn-testuser" / "games.sqlite",
                "SELECT id, rating, ms FROM puzzle_attempts") == [("own1", None, None)]
    assert _all(tmp_path / ".accounts" / "guest" / "progress.sqlite", "SELECT id FROM puzzle_attempts") == [("p9",)]

    marker = json.loads((tmp_path / M.MARKER).read_text(encoding="utf-8"))
    assert marker["files"]["progress.sqlite"]["puzzle_attempts"] == 5
    assert not (tmp_path / M.STAGING).exists()


def test_running_twice_does_nothing_until_python_writes_again(tmp_path):
    make_fixture(tmp_path)
    M.migrate(tmp_path)
    stamp = _digest(tmp_path)
    assert M.migrate(tmp_path)["status"] == "skipped"
    assert _digest(tmp_path) == stamp

    # the bridge kept running: a new puzzle tried, so the export is made again
    with (tmp_path / "puzzle_solved.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"id": "p5", "ts": 1760000300}) + "\n")
    assert M.migrate(tmp_path)["status"] == "done"
    assert _all(tmp_path / "progress.sqlite", "SELECT id FROM puzzle_solved ORDER BY seq") == [("p2",), ("p5",)]


def test_files_the_js_app_has_written_are_kept(tmp_path):
    make_fixture(tmp_path)
    M.migrate(tmp_path)
    marker = (tmp_path / M.MARKER).stat().st_mtime_ns
    con = sqlite3.connect(tmp_path / "progress.sqlite")
    con.execute("INSERT INTO puzzle_solved (id, ts) VALUES ('js', 2)")
    con.commit()
    con.close()
    os.utime(tmp_path / "progress.sqlite", ns=(marker + 10**9, marker + 10**9))
    (tmp_path / "puzzle_solved.jsonl").write_text("", encoding="utf-8")        # and Python wrote again (a downgrade)
    res = M.migrate(tmp_path)
    assert res == {"status": "skipped", "reason": "sqlite in use", "files": ["progress.sqlite"]}
    assert _all(tmp_path / "progress.sqlite", "SELECT id FROM puzzle_solved") == [("p2",), ("js",)]
    assert M.migrate(tmp_path, force=True)["status"] == "done"
    assert _all(tmp_path / "progress.sqlite", "SELECT id FROM puzzle_solved") == []


def test_into_another_folder_and_from_nothing(tmp_path):
    data, out = tmp_path / "data", tmp_path / "out"
    data.mkdir()
    res = M.migrate(data, out)                     # a fresh install: empty files, still the schema
    assert res["files"] == {"evals.sqlite": {"evals": 0, "evals_multipv": 0},
                            "progress.sqlite": {"puzzle_attempts": 0, "puzzle_solved": 0, "puzzle_daily": 0}}
    assert list(data.iterdir()) == []
    assert _all(out / "evals.sqlite", "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") == [
        ("evals",), ("evals_multipv",)]


def test_a_half_done_export_is_done_again(tmp_path, monkeypatch):
    make_fixture(tmp_path)
    real = M._export_profile
    calls = []

    def boom(folder, dst):
        calls.append(folder)
        if len(calls) == 2:
            raise RuntimeError("power cut")
        return real(folder, dst)
    monkeypatch.setattr(M, "_export_profile", boom)
    try:
        M.migrate(tmp_path)
    except RuntimeError:
        pass
    assert not (tmp_path / M.MARKER).exists() and not (tmp_path / "evals.sqlite").exists()
    monkeypatch.setattr(M, "_export_profile", real)
    assert M.migrate(tmp_path)["status"] == "done"
    assert not (tmp_path / M.STAGING).exists()


def test_on_in_the_bridge_release(tmp_path, monkeypatch):
    monkeypatch.delenv(M.ENV, raising=False)
    assert M.ENABLED is True and M.on_start(tmp_path)["status"] == "done"


def test_the_switch(tmp_path, monkeypatch):
    monkeypatch.delenv(M.ENV, raising=False)
    monkeypatch.setattr(M, "ENABLED", False)
    assert M.on_start(tmp_path) is None and list(tmp_path.iterdir()) == []
    monkeypatch.setenv(M.ENV, "1")
    assert M.on_start(tmp_path)["status"] == "done"


def test_dump_matches_the_files(tmp_path):
    make_fixture(tmp_path)
    M.migrate(tmp_path)
    d = M.dump(tmp_path)
    marker = json.loads((tmp_path / M.MARKER).read_text(encoding="utf-8"))
    assert {n: {t: v["count"] for t, v in tables.items()} for n, tables in d.items()} == marker["files"]


if __name__ == "__main__":      # js/server/migrate.test.js: python tests/test_migrate_sqlite.py <dir>
    make_fixture(sys.argv[1])
