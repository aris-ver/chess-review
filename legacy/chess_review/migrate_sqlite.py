"""The one-time export of this app's data to the SQLite files of the JavaScript port (docs/js-port.md, steps 5 and 6).

    DATA/evals.duckdb                                   -> DATA/evals.sqlite          evals, evals_multipv
    DATA/puzzle_attempts[.reset-*].jsonl, puzzle_solved.jsonl, puzzle_daily.jsonl
                                                        -> DATA/progress.sqlite       puzzle_attempts, puzzle_solved, puzzle_daily
    DATA/profiles/<id>/games, positions, moves.parquet, puzzle_attempts[.reset-*].jsonl
                                                        -> DATA/profiles/<id>/games.sqlite

The tables and their DDL are js/server/db.js's, copied here because the bridge release ships without js/: a value
SQLite has no type for is stored as db.js encodes it (BOOLEAN 0/1, JSON compact text, TIMESTAMP isoformat), and
`PRAGMA user_version` is db.js's SCHEMA_VERSION, so the JS Store opens the files as its own. A profile's moves come
along but not their fingerprints (moves.fp.json): the JS fingerprints games its own way and classifies every game once.
An account set aside in DATA/.accounts/<who>/ (sync.switch) is a small data directory of its own and gets its own
progress.sqlite and profiles/<id>/games.sqlite there; the engine cache is only ever at the top.

The old files are only read, never changed. Everything is written in DATA/.sqlite-export/ first and moved into place
when complete, then DATA/sqlite-export.json says it is done, with what the files were made from. Running it again
does nothing while the old files are as they were; once the Python app has written to them since, it is made again,
unless the JS app has written to the SQLite files in between (then the JS's are newer and are kept).

On since the desktop bridge release (ENABLED; CHESS_REVIEW_SQLITE_EXPORT=1 forces it where ENABLED is off): serve.main
runs on_start(), and updater.py runs migrate() once more right before it applies the Electron build. In the browser,
web/py-worker.js runs migrate("/data", out) into Pyodide's memory file system
after loading the sqlite3 package and hands the files to js/web/migrate.js.

    python -m chess_review.migrate_sqlite [--data DIR] [--out DIR] [--force] [--dump FILE]
"""

import argparse
import json
import logging
import os
import re
import shutil
import sqlite3
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

import duckdb

from .config import DATA, sql_path
from .fen import fen_key

log = logging.getLogger("migrate_sqlite")

ENABLED = True                  # on from the bridge release (v0.7.0), the last Python one, which hands over to Electron
ENV = "CHESS_REVIEW_SQLITE_EXPORT"
MARKER = "sqlite-export.json"
STAGING = ".sqlite-export"
WORKSPACES = ".accounts"        # sync.WORKSPACES
FORMAT = 1                      # the marker's own version

EVALS = "evals.sqlite"
PROGRESS = "progress.sqlite"


def profile_db(pid: str) -> str:
    return f"profiles/{pid}/games.sqlite"


# ---------- js/server/db.js's schema ----------

SCHEMA_VERSION = 1

GAMES_SCHEMA = (("game_id", "TEXT"), ("played_at", "TIMESTAMP"), ("time_control", "TEXT"), ("time_class", "TEXT"),
                ("my_colour", "TEXT"), ("my_rating", "INTEGER"), ("opponent_rating", "INTEGER"), ("result", "TEXT"),
                ("termination", "TEXT"), ("eco", "TEXT"), ("opening_name", "TEXT"), ("opponent", "TEXT"),
                ("my_name", "TEXT"))
POSITIONS_SCHEMA = (("game_id", "TEXT"), ("ply", "INTEGER"), ("fen", "TEXT"), ("move_played", "TEXT"),
                    ("side_to_move", "TEXT"), ("clock_remaining", "INTEGER"), ("fen_key", "TEXT"))
MOVES_SCHEMA = (("game_id", "TEXT"), ("ply", "INTEGER"), ("side_to_move", "TEXT"), ("is_mine", "BOOLEAN"),
                ("move_played", "TEXT"), ("san", "TEXT"), ("best_move", "TEXT"), ("best_san", "TEXT"),
                ("n_legal", "INTEGER"), ("is_forced", "BOOLEAN"), ("in_book", "BOOLEAN"), ("wp_before", "REAL"),
                ("wp_after", "REAL"), ("wp_loss", "REAL"), ("accuracy", "REAL"), ("label", "TEXT"),
                ("only_move", "BOOLEAN"), ("clock_remaining", "INTEGER"), ("time_spent", "INTEGER"))
EVALS_SCHEMA = (("fen_key", "TEXT"), ("nodes", "INTEGER"), ("eval_cp", "INTEGER"), ("mate_in", "INTEGER"),
                ("best_move", "TEXT"), ("pv", "JSON"))
EVALS_MULTIPV_SCHEMA = (("fen_key", "TEXT"), ("rank", "INTEGER"), ("move", "TEXT"), ("eval_cp", "INTEGER"),
                        ("mate_in", "INTEGER"), ("pv", "JSON"))
ATTEMPTS_SCHEMA = (("seq", "INTEGER"), ("archive", "TEXT"), ("id", "TEXT"), ("ts", "INTEGER"), ("solved", "BOOLEAN"),
                   ("ms", "INTEGER"), ("hinted", "BOOLEAN"), ("rating", "INTEGER"))
SOLVED_SCHEMA = (("seq", "INTEGER"), ("id", "TEXT"), ("ts", "INTEGER"))
DAILY_SCHEMA = (("seq", "INTEGER"), ("date", "TEXT"), ("n", "INTEGER"), ("id", "TEXT"), ("solved", "BOOLEAN"),
                ("clean", "BOOLEAN"), ("ms", "INTEGER"), ("marks", "JSON"))


def _table(name: str, schema, extra=()) -> str:
    cols = ["seq INTEGER PRIMARY KEY AUTOINCREMENT" if n == "seq" else f'"{n}" {t}' for n, t in schema]
    return f"CREATE TABLE IF NOT EXISTS {name} (\n  " + ",\n  ".join([*cols, *extra]) + "\n);"


EVALS_DDL = "\n".join([
    _table("evals", EVALS_SCHEMA, ["PRIMARY KEY (fen_key)"]),
    _table("evals_multipv", EVALS_MULTIPV_SCHEMA, ["PRIMARY KEY (fen_key, rank)"]),
])
PROGRESS_DDL = "\n".join([
    _table("puzzle_attempts", ATTEMPTS_SCHEMA),
    "CREATE INDEX IF NOT EXISTS puzzle_attempts_id ON puzzle_attempts (id);",
    _table("puzzle_solved", SOLVED_SCHEMA),
    _table("puzzle_daily", DAILY_SCHEMA),
])
PROFILE_DDL = "\n".join([
    _table("games", GAMES_SCHEMA, ["PRIMARY KEY (game_id)"]),
    _table("positions", POSITIONS_SCHEMA, ["PRIMARY KEY (game_id, ply)"]),
    "CREATE INDEX IF NOT EXISTS positions_fen_key ON positions (fen_key);",
    _table("moves", MOVES_SCHEMA, ["PRIMARY KEY (game_id, ply)"]),
    _table("move_fingerprints", (("game_id", "TEXT"), ("fp", "TEXT")), ["PRIMARY KEY (game_id)"]),
    _table("puzzle_attempts", ATTEMPTS_SCHEMA),
    "CREATE INDEX IF NOT EXISTS puzzle_attempts_id ON puzzle_attempts (id);",
])


def encode(v, sql_type: str):
    """A value as db.js's encode() stores it."""
    if v is None:
        return None
    if sql_type == "BOOLEAN":
        return 1 if v else 0
    if sql_type == "JSON":
        return json.dumps(list(v) if isinstance(v, tuple) else v, separators=(",", ":"), ensure_ascii=False)
    if isinstance(v, datetime):
        return v.isoformat()       # as db.write_parquet and js/core/normalise.js write played_at
    if isinstance(v, date):
        return v.isoformat()
    return v


def _create(path: Path, ddl: str) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    for f in _with_journals(path):
        f.unlink(missing_ok=True)
    con = sqlite3.connect(path, isolation_level=None)
    con.execute("PRAGMA journal_mode = DELETE")
    con.execute("BEGIN")
    for stmt in ddl.split(";"):      # executescript would commit first; the file is written in one transaction
        if stmt.strip():
            con.execute(stmt)
    con.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    return con


def _insert(con: sqlite3.Connection, table: str, schema, rows: Iterable[dict]) -> int:
    cols = [(n, t) for n, t in schema if n != "seq"]
    names = ", ".join(f'"{n}"' for n, _ in cols)
    sql = f"INSERT OR IGNORE INTO {table} ({names}) VALUES ({', '.join('?' * len(cols))})"
    before = con.total_changes
    batch = []
    for r in rows:
        batch.append([encode(r.get(c), t) for c, t in cols])
        if len(batch) >= 5000:
            con.executemany(sql, batch)
            batch = []
    if batch:
        con.executemany(sql, batch)
    return con.total_changes - before      # a key twice (copied in by hand) is kept once


def _finish(con: sqlite3.Connection) -> None:
    con.execute("COMMIT")
    con.close()


def _with_journals(path: Path) -> list[Path]:
    return [path, *(path.with_name(path.name + s) for s in ("-wal", "-shm", "-journal"))]


# ---------- reading the old files ----------

def _rows(cur, size: int = 5000):
    names = [d[0] for d in cur.description]
    while True:
        chunk = cur.fetchmany(size)
        if not chunk:
            return
        for row in chunk:
            yield dict(zip(names, row))


def _parquet(path: Path, order: str):
    return _rows(duckdb.connect().execute(f"SELECT * FROM read_parquet({sql_path(path)}) ORDER BY {order}"))


def _jsonl(path: Path) -> list[dict]:
    """puzzles.attempts: a line cut short by a crash (or anything that isn't an object) is skipped."""
    out = []
    try:
        with path.open(encoding="utf-8") as f:
            for ln in f:
                try:
                    v = json.loads(ln)
                except ValueError:
                    continue
                if isinstance(v, dict):
                    out.append(v)
    except OSError:
        pass
    return out


_RESET = re.compile(r"^puzzle_attempts\.(reset-(\d{8}-\d{6})(?:-(\d+))?)\.jsonl$")


def _attempt_files(folder: Path) -> list[tuple[Optional[str], Path]]:
    """(archive, file) for every attempts file in folder: the resets oldest first (puzzles.archive names them), then
    the current one (archive None)."""
    resets = []
    for f in folder.glob("puzzle_attempts.reset-*.jsonl"):
        m = _RESET.match(f.name)
        if m:
            resets.append(((m.group(2), int(m.group(3) or 1)), m.group(1), f))
        else:       # renamed by hand: keep it, after the ones that follow the pattern
            resets.append((("~", 0), f.name[len("puzzle_attempts."):-len(".jsonl")], f))
    out = [(name, f) for _, name, f in sorted(resets, key=lambda t: (t[0], t[1]))]
    cur = folder / "puzzle_attempts.jsonl"
    if cur.exists():
        out.append((None, cur))
    return out


def _attempts(folder: Path) -> list[dict]:
    return [{**a, "archive": name} for name, f in _attempt_files(folder) for a in _jsonl(f)]


def _profile_ids(data: Path) -> list[str]:
    """profiles.list_profiles: the folders under profiles/ with a meta.json and a valid id."""
    root = data / "profiles"
    if not root.is_dir():
        return []
    return sorted(d.name for d in root.iterdir()
                  if d.is_dir() and (d / "meta.json").exists() and re.match(r"^[a-z0-9][a-z0-9_.-]{0,80}$", d.name)
                  and ".." not in d.name)


def _workspaces(data: Path) -> list[Path]:
    root = data / WORKSPACES
    return sorted(d for d in root.iterdir() if d.is_dir()) if root.is_dir() else []


def _open_evals(data: Path) -> Optional[duckdb.DuckDBPyConnection]:
    """evals.duckdb read-only, or None when there is none. A lock held by a running analysis is an error: the
    parquet snapshot has no evals_multipv, so the export waits for the next start rather than lose them."""
    path = data / "evals.duckdb"
    if not path.exists():
        return None
    con = duckdb.connect()
    con.execute(f"ATTACH {sql_path(path)} AS ev (READ_ONLY)")
    return con


def _has_table(con, name: str) -> bool:
    return bool(con.execute("SELECT count(*) FROM duckdb_tables() WHERE database_name = 'ev' AND table_name = ?",
                            [name]).fetchone()[0])


# ---------- the export ----------

def _sources(data: Path) -> dict[str, list[int]]:
    """What the export is made from, relative path -> [size, mtime_ns]: when any of it changes, the export is stale."""
    files = [data / "evals.duckdb", data / "evals.duckdb.wal"]
    homes = [data, *_workspaces(data)]
    for home in homes:
        files += sorted(home.glob("puzzle_attempts*.jsonl")) + [home / "puzzle_solved.jsonl", home / "puzzle_daily.jsonl"]
        for pid in _profile_ids(home):
            d = home / "profiles" / pid
            files += [d / "games.parquet", d / "positions.parquet", d / "moves.parquet", d / "meta.json"]
            files += sorted(d.glob("puzzle_attempts*.jsonl"))
    out = {}
    for f in files:
        try:
            st = f.stat()
        except OSError:
            continue
        out[f.relative_to(data).as_posix()] = [st.st_size, st.st_mtime_ns]
    return out


def _targets(out: Path, data: Path) -> list[str]:
    names = [EVALS, PROGRESS, *(profile_db(p) for p in _profile_ids(data))]
    for ws in _workspaces(data):
        rel = ws.relative_to(data).as_posix()
        names += [f"{rel}/{PROGRESS}", *(f"{rel}/{profile_db(p)}" for p in _profile_ids(ws))]
    return names


def _export_evals(data: Path, dst: Path) -> dict:
    counts = {"evals": 0, "evals_multipv": 0}
    con = _create(dst, EVALS_DDL)
    try:
        src = _open_evals(data)
        if src is not None:
            for table, schema in (("evals", EVALS_SCHEMA), ("evals_multipv", EVALS_MULTIPV_SCHEMA)):
                if _has_table(src, table):
                    cols = ", ".join(f'"{n}"' for n, _ in schema)
                    counts[table] = _insert(con, table, schema, _rows(src.execute(f"SELECT {cols} FROM ev.{table}")))
            src.close()
        _finish(con)
    except BaseException:
        con.close()
        raise
    return counts


def _export_progress(home: Path, dst: Path) -> dict:
    con = _create(dst, PROGRESS_DDL)
    try:
        counts = {
            "puzzle_attempts": _insert(con, "puzzle_attempts", ATTEMPTS_SCHEMA, _attempts(home)),
            "puzzle_solved": _insert(con, "puzzle_solved", SOLVED_SCHEMA, _jsonl(home / "puzzle_solved.jsonl")),
            "puzzle_daily": _insert(con, "puzzle_daily", DAILY_SCHEMA, _jsonl(home / "puzzle_daily.jsonl")),
        }
        _finish(con)
    except BaseException:
        con.close()
        raise
    return counts


def _positions(path: Path):
    for r in _parquet(path, "game_id, ply"):
        r["fen_key"] = fen_key(r["fen"]) if r.get("fen") else None
        yield r


def _export_profile(folder: Path, dst: Path) -> dict:
    con = _create(dst, PROFILE_DDL)
    try:
        counts = {}
        for table, schema, rows, order in (("games", GAMES_SCHEMA, None, "game_id"),
                                           ("positions", POSITIONS_SCHEMA, _positions, None),
                                           ("moves", MOVES_SCHEMA, None, "game_id, ply")):
            path = folder / f"{table}.parquet"
            counts[table] = _insert(con, table, schema, rows(path) if rows else _parquet(path, order)) if path.exists() else 0
        counts["puzzle_attempts"] = _insert(con, "puzzle_attempts", ATTEMPTS_SCHEMA, _attempts(folder))
        _finish(con)
    except BaseException:
        con.close()
        raise
    return counts


def _read_marker(out: Path) -> Optional[dict]:
    try:
        return json.loads((out / MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _touched_since(out: Path, names: list[str], marker_path: Path) -> list[str]:
    """The SQLite files written after the marker: the JS app has been using them."""
    try:
        when = marker_path.stat().st_mtime_ns
    except OSError:
        return []
    hit = []
    for name in names:
        for f in _with_journals(out / name):
            try:
                if f.stat().st_mtime_ns > when or (f != out / name and f.stat().st_size > 0):
                    hit.append(name)
                    break
            except OSError:
                continue
    return hit


def migrate(data: Path = DATA, out: Optional[Path] = None, force: bool = False) -> dict:
    """Write the SQLite files for data's contents into out (default: data itself, beside the old files).

    {"status": "done", "files": {name: counts}, ...}, or {"status": "skipped", "reason": ...} when the files are there
    already and current (or the JS app's newer ones are). force: write them again in any case."""
    data, out = Path(data), Path(out) if out is not None else Path(data)
    marker_path = out / MARKER
    sources = _sources(data)
    marker = _read_marker(out)
    names = _targets(out, data)
    if marker is not None and not force:
        if marker.get("sources") == sources:
            return {"status": "skipped", "reason": "done already", "at": marker.get("at")}
        used = _touched_since(out, [n for n in marker.get("files", {})], marker_path)
        if used:
            log.warning("the SQLite files changed since the export (%s): kept, not exported again", ", ".join(used))
            return {"status": "skipped", "reason": "sqlite in use", "files": used}

    t0 = time.monotonic()
    staging = out / STAGING
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    files = {EVALS: _export_evals(data, staging / EVALS), PROGRESS: _export_progress(data, staging / PROGRESS)}
    for pid in _profile_ids(data):
        files[profile_db(pid)] = _export_profile(data / "profiles" / pid, staging / profile_db(pid))
    for ws in _workspaces(data):
        rel = ws.relative_to(data).as_posix()
        files[f"{rel}/{PROGRESS}"] = _export_progress(ws, staging / rel / PROGRESS)
        for pid in _profile_ids(ws):
            files[f"{rel}/{profile_db(pid)}"] = _export_profile(ws / "profiles" / pid, staging / rel / profile_db(pid))

    marker_path.unlink(missing_ok=True)      # from here until the new marker the files are half-moved: not done
    for name in files:
        dst = out / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        for f in _with_journals(dst):
            f.unlink(missing_ok=True)
        os.replace(staging / name, dst)
    shutil.rmtree(staging, ignore_errors=True)
    done = {"format": FORMAT, "schema_version": SCHEMA_VERSION,
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "seconds": round(time.monotonic() - t0, 1), "files": files, "sources": sources}
    tmp = marker_path.with_name(MARKER + ".tmp")
    tmp.write_text(json.dumps(done, indent=1), encoding="utf-8")
    os.replace(tmp, marker_path)
    log.info("exported to SQLite in %.1f s: %s", done["seconds"],
             ", ".join(f"{n} ({sum(c.values())} rows)" for n, c in files.items()))
    return {"status": "done", **done}


def enabled() -> bool:
    return ENABLED or os.environ.get(ENV) == "1"


def on_start(data: Path = DATA) -> Optional[dict]:
    """serve.main's hook: the export when it is switched on, never an error that stops the app."""
    if not enabled():
        return None
    try:
        return migrate(data)
    except Exception:  # noqa: BLE001
        log.exception("export to SQLite failed; it is tried again at the next start")
        return {"status": "failed"}


# ---------- what Python reads, for checking the export ----------

def dump(data: Path, sample: int = 25) -> dict:
    """Row counts and evenly spread sample rows of every table, as Python reads them from DuckDB, parquet and jsonl,
    in the form the JS Store gives them back (booleans, lists, isoformat text): what js/server/migrate.test.js
    compares the SQLite files with."""
    def pick(rows: list) -> list:
        if len(rows) <= sample:
            return rows
        step = len(rows) / sample
        return [rows[int(i * step)] for i in range(sample)]

    def shape(rows: Iterable[dict], schema) -> list[dict]:
        out = []
        for r in rows:
            o = {}
            for n, t in schema:
                if n == "seq":
                    continue
                v = r.get(n)
                if t == "JSON" and v is not None:
                    v = json.loads(encode(v, t))
                elif t == "BOOLEAN" and v is not None:
                    v = bool(v)
                else:
                    v = encode(v, t)
                o[n] = v
            out.append(o)
        return out

    def table(rows: list[dict], schema) -> dict:
        return {"count": len(rows), "sample": shape(pick(rows), schema)}

    data = Path(data)
    out = {}
    src = _open_evals(data)
    ev = {}
    for name, schema, order in (("evals", EVALS_SCHEMA, "fen_key"), ("evals_multipv", EVALS_MULTIPV_SCHEMA, "fen_key, rank")):
        rows = list(_rows(src.execute(f"SELECT * FROM ev.{name} ORDER BY {order}"))) if src and _has_table(src, name) else []
        ev[name] = table(rows, schema)
    out[EVALS] = ev

    def progress(home: Path) -> dict:
        return {"puzzle_attempts": table(_attempts(home), ATTEMPTS_SCHEMA),
                "puzzle_solved": table(_jsonl(home / "puzzle_solved.jsonl"), SOLVED_SCHEMA),
                "puzzle_daily": table(_jsonl(home / "puzzle_daily.jsonl"), DAILY_SCHEMA)}

    def profile(folder: Path) -> dict:
        t = {}
        for name, schema, order in (("games", GAMES_SCHEMA, "game_id"), ("positions", POSITIONS_SCHEMA, "game_id, ply"),
                                    ("moves", MOVES_SCHEMA, "game_id, ply")):
            path = folder / f"{name}.parquet"
            rows = list(_positions(path) if name == "positions" else _parquet(path, order)) if path.exists() else []
            t[name] = table(rows, schema)
        t["puzzle_attempts"] = table(_attempts(folder), ATTEMPTS_SCHEMA)
        return t

    out[PROGRESS] = progress(data)
    for pid in _profile_ids(data):
        out[profile_db(pid)] = profile(data / "profiles" / pid)
    for ws in _workspaces(data):
        rel = ws.relative_to(data).as_posix()
        out[f"{rel}/{PROGRESS}"] = progress(ws)
        for pid in _profile_ids(ws):
            out[f"{rel}/{profile_db(pid)}"] = profile(ws / "profiles" / pid)
    return out


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="migrate_sqlite", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", type=Path, default=DATA, help="the data directory to read (default: the app's)")
    p.add_argument("--out", type=Path, default=None, help="where the SQLite files go (default: --data)")
    p.add_argument("--force", action="store_true", help="export again even when done already")
    p.add_argument("--dump", type=Path, default=None, help="also write Python's view of the data as JSON here")
    args = p.parse_args(argv)
    res = migrate(args.data, args.out, args.force)
    print(json.dumps({k: v for k, v in res.items() if k != "sources"}, indent=1))
    if args.dump:
        args.dump.write_text(json.dumps(dump(args.data), ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
