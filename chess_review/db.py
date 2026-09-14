"""Read-side DuckDB connection with views over the on-disk parquet/duckdb files."""

import logging

import duckdb

from .config import (
    EVALS_DB,
    EVALS_PARQUET,
    GAMES_PARQUET,
    MOVES_PARQUET,
    POSITIONS_PARQUET,
    sql_path,
)

log = logging.getLogger("db")


def base_views(con: duckdb.DuckDBPyConnection) -> None:
    """games/positions (+ moves when built) as views over the parquet files, on any connection."""
    con.execute(f"CREATE OR REPLACE VIEW games AS SELECT * FROM read_parquet({sql_path(GAMES_PARQUET)})")
    con.execute(f"""
        CREATE OR REPLACE VIEW positions AS
        SELECT *, array_to_string(list_slice(string_split(fen, ' '), 1, 4), ' ') AS fen_key
        FROM read_parquet({sql_path(POSITIONS_PARQUET)})
    """)
    if MOVES_PARQUET.exists():
        con.execute(f"CREATE OR REPLACE VIEW moves AS SELECT * FROM read_parquet({sql_path(MOVES_PARQUET)})")


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    base_views(con)

    # The live cache is preferred; while `analyse` holds its write lock, fall
    # back to the parquet snapshot it exports at the end of every run.
    attached = False
    if EVALS_DB.exists():
        try:
            con.execute(f"ATTACH {sql_path(EVALS_DB)} AS evdb (READ_ONLY)")
            con.execute("CREATE VIEW evals AS SELECT * FROM evdb.evals")
            con.execute("CREATE VIEW evals_multipv AS SELECT * FROM evdb.evals_multipv")
            attached = True
        except duckdb.Error as e:
            log.warning("evals.duckdb locked (%s), using evals.parquet snapshot", str(e).splitlines()[0])
    if not attached and EVALS_PARQUET.exists():
        con.execute(f"CREATE VIEW evals AS SELECT * FROM read_parquet({sql_path(EVALS_PARQUET)})")
        con.execute("CREATE VIEW evals_multipv AS SELECT NULL::TEXT fen_key, NULL::INT rank, NULL::TEXT move, NULL::INT eval_cp, NULL::INT mate_in, NULL::TEXT[] pv WHERE false")
    return con
