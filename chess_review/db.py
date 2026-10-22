"""Read-side DuckDB connection with views over the on-disk parquet/duckdb files."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

import duckdb

from .config import EVALS_DB, EVALS_PARQUET, sql_path
from .profiles import Profile

log = logging.getLogger("db")


def base_views(con: duckdb.DuckDBPyConnection, profile: Profile) -> None:
    """games/positions (+ moves when built) as views over the profile's parquet files, on any connection."""
    con.execute(f"CREATE OR REPLACE VIEW games AS SELECT * FROM read_parquet({sql_path(profile.games_parquet)})")
    con.execute(f"""
        CREATE OR REPLACE VIEW positions AS
        SELECT *, array_to_string(list_slice(string_split(fen, ' '), 1, 4), ' ') AS fen_key
        FROM read_parquet({sql_path(profile.positions_parquet)})
    """)
    if profile.moves_parquet.exists():
        con.execute(f"CREATE OR REPLACE VIEW moves AS SELECT * FROM read_parquet({sql_path(profile.moves_parquet)})")


def evals_views(con: duckdb.DuckDBPyConnection) -> None:
    """evals/evals_multipv as views over the shared engine cache (no profile: keyed by position, not by player)."""
    # The live cache is preferred; while `analyse` holds its write lock, fall
    # back to the parquet snapshot it exports at the end of every run.
    attached = False
    if EVALS_DB.exists():
        try:
            con.execute(f"ATTACH {sql_path(EVALS_DB)} AS evdb (READ_ONLY)")
            con.execute("CREATE OR REPLACE VIEW evals AS SELECT * FROM evdb.evals")
            con.execute("CREATE OR REPLACE VIEW evals_multipv AS SELECT * FROM evdb.evals_multipv")
            attached = True
        except duckdb.Error as e:
            log.warning("evals.duckdb locked (%s), using evals.parquet snapshot", str(e).splitlines()[0])
    if not attached:
        if EVALS_PARQUET.exists():
            con.execute(f"CREATE OR REPLACE VIEW evals AS SELECT * FROM read_parquet({sql_path(EVALS_PARQUET)})")
        else:   # nothing analysed yet (fresh install): every position simply has no eval
            con.execute("CREATE OR REPLACE VIEW evals AS SELECT NULL::TEXT fen_key, NULL::INT nodes, NULL::INT eval_cp, NULL::INT mate_in, NULL::TEXT best_move, NULL::TEXT[] pv WHERE false")
        con.execute('CREATE OR REPLACE VIEW evals_multipv AS SELECT NULL::TEXT fen_key, NULL::INT rank, NULL::TEXT "move", NULL::INT eval_cp, NULL::INT mate_in, NULL::TEXT[] pv WHERE false')


def dicts(cur) -> list[dict]:
    """A query's rows as dicts, column name -> value: con.execute(...) in, what the rest of the code works on out."""
    names = [d[0] for d in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def read_parquet(path: Path) -> list[dict]:
    return dicts(duckdb.connect().execute(f"SELECT * FROM read_parquet({sql_path(path)})"))


def write_parquet(rows: list[dict], schema: tuple[tuple[str, str], ...], path: Path) -> None:
    """rows as a parquet file with schema's columns, (name, SQL type) in order; a key a row lacks is NULL, one the
    schema lacks is dropped. The rows go to DuckDB as one JSON array in a file next to path: binding them as
    parameters, row by row or as lists, takes minutes for a profile's positions, the JSON a second."""
    columns = "{" + ", ".join(f"'{name}': '{sql_type}'" for name, sql_type in schema) + "}"
    encoder = json.JSONEncoder(default=datetime.isoformat, ensure_ascii=False, check_circular=False)
    fd, tmp = tempfile.mkstemp(suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(encoder.encode(rows))
        duckdb.connect().execute(f"""
            COPY (SELECT * FROM read_json({sql_path(tmp)}, format = 'array', columns = {columns}))
            TO {sql_path(path)} (FORMAT parquet)
        """)
    finally:
        os.unlink(tmp)


def connect(profile: Optional[Profile] = None) -> duckdb.DuckDBPyConnection:
    """evals views always; games/positions/moves views too when a profile is given."""
    con = duckdb.connect()
    if profile is not None:
        base_views(con, profile)
    evals_views(con)
    return con
