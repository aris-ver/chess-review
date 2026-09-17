import os
import subprocess
import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
# Bundled read-only assets (static/, bin/): the PyInstaller extraction dir in --onefile mode,
# else the folder the exe sits in (--onedir) or the source checkout when run from Python directly.
BUNDLE_ROOT = Path(getattr(sys, "_MEIPASS", "")) if FROZEN and hasattr(sys, "_MEIPASS") else (
    Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent.parent)
ROOT = Path(__file__).resolve().parent.parent

if os.environ.get("CHESS_REVIEW_DATA"):
    DATA = Path(os.environ["CHESS_REVIEW_DATA"])
elif FROZEN:
    # A packaged exe's own folder may be read-only (Program Files) or a temp extraction dir,
    # so per-user data goes under the OS's standard per-user data location instead.
    if sys.platform == "win32":
        DATA = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "chess-review"
    else:
        DATA = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "chess-review"
else:
    DATA = ROOT / "data"
# Shared across profiles. Per-player paths (raw archives, games/positions/moves parquet, review JSON)
# live under data/profiles/<id>/ and come from profiles.Profile.
EVALS_DB = DATA / "evals.duckdb"        # incremental, resumable engine cache, keyed by position
EVALS_PARQUET = DATA / "evals.parquet"  # snapshot written at the end of each analyse run
SITE_DIR = DATA / "site"                # the static app: index.html, assets, sounds

_STOCKFISH_NAME = "stockfish.exe" if sys.platform == "win32" else "stockfish"
STOCKFISH = Path(os.environ.get("STOCKFISH", BUNDLE_ROOT / "bin" / _STOCKFISH_NAME))
# Extra Popen kwargs for engine processes: without this a console-less (windowed) exe gets a
# black cmd window popping up for every Stockfish it starts.
ENGINE_POPEN = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
DEFAULT_NODES = 1_000_000

# Win% loss thresholds (stage 4). Tune against known games.
BLUNDER = 20.0
MISTAKE = 10.0
INACCURACY = 5.0
EXCELLENT = 2.0          # <= this: "excellent"
CP_MISTAKE = 300         # material floor: a move that hangs material AND drops the eval this much is at least a mistake
CP_BLUNDER = 800         # ... and this much is a blunder, however won the position already was
ONLY_MOVE_GAP = 15.0     # win% gap between MultiPV #1 and #2 -> "great" / "only move"
MULTIPV_N = 3
OPENING_SKIP_PLIES = 8   # ignore early moves unless already a blunder
CRITICAL_MAX = 5
DEFAULT_HASH_MB = 64            # per worker; cleared before every 1M-node search, so bigger buys nothing
ENGINE_IDLE_SECONDS = 600       # server shuts engines down after this long without work (they restart in ~1 s)
USER_AGENT = "chess-review/0.1 (personal offline game analysis tool)"  # cloudflare 403s anything mentioning python-requests
GITHUB_REPO = "aris-ver/chess-review"   # where the Windows build looks for new releases (updater.py)


def sql_path(p) -> str:
    """Quote a path as a SQL string literal (DDL/COPY/ATTACH can't take bind parameters)."""
    return "'" + str(p).replace("\\", "/").replace("'", "''") + "'"
