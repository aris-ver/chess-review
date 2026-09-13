import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("CHESS_REVIEW_DATA", ROOT / "data"))
RAW_DIR = DATA / "raw"          # verbatim chess.com monthly archives, {YYYY-MM}.json
PGN_DIR = DATA / "pgn"          # pasted PGNs, {content_hash}.pgn
EXPORT_DIR = DATA / "export"

GAMES_PARQUET = DATA / "games.parquet"
POSITIONS_PARQUET = DATA / "positions.parquet"
EVALS_DB = DATA / "evals.duckdb"        # incremental, resumable engine cache
EVALS_PARQUET = DATA / "evals.parquet"  # snapshot written at the end of each analyse run
MOVES_PARQUET = DATA / "moves.parquet"             # stage 4a: classified moves
CRITICAL_PARQUET = DATA / "critical.parquet"       # stage 4b: selected critical moments
META_JSON = DATA / "meta.json"                    # {"username": ...} written by normalise
SITE_DIR = DATA / "site"                           # stage 4c: static review site

STOCKFISH = Path(os.environ.get("STOCKFISH", ROOT / "bin" / "stockfish"))
DEFAULT_NODES = 1_000_000

# Win% loss thresholds (stage 4). Tune against known games.
BLUNDER = 20.0
MISTAKE = 10.0
INACCURACY = 5.0
GOOD = 5.0               # <= this loss and not the engine move: "good"
EXCELLENT = 2.0          # <= this: "excellent"
CP_MISTAKE = 300         # material floor: a move that hangs material AND drops the eval this much is at least a mistake
CP_BLUNDER = 800         # ... and this much is a blunder, however won the position already was
ONLY_MOVE_GAP = 15.0     # win% gap between MultiPV #1 and #2 -> "great" / "only move"
MULTIPV_N = 3
OPENING_SKIP_PLIES = 8   # ignore early moves unless already a blunder
CRITICAL_MAX = 5
DEFAULT_HASH_MB = 256           # per worker process; hash is cleared before every position
USER_AGENT = "chess-review/0.1 (personal offline game analysis tool)"  # cloudflare 403s anything mentioning python-requests


def sql_path(p) -> str:
    """Quote a path as a SQL string literal (DDL/COPY/ATTACH can't take bind parameters)."""
    return "'" + str(p).replace("\\", "/").replace("'", "''") + "'"
