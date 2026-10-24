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

# Win% loss thresholds (stage 4), on the grading curve. chess.com grades by the mover's rating: up to ~1000 a +5
# position is not yet won and a 0.5-pawn slip at equality is nothing, at 2800+ a 0.3-pawn slip is an inaccuracy and
# a +5 position is over. So the curve's steepness runs from GRADE_K_LOW (at GRADE_RATING_LOW and below) to
# GRADE_K_HIGH (at GRADE_RATING_HIGH and above), log-linearly between. Fitted on docs/chesscom-review: games at
# ~570, ~800, ~2800 and ~3300 (nothing yet between 1100 and 2800, so the middle is interpolated).
GRADE_K_LOW = 0.002      # flatter than Lichess's 0.00368
GRADE_RATING_LOW = 1000
GRADE_K_HIGH = 0.007
GRADE_RATING_HIGH = 3000
GRADE_DEFAULT_RATING = 1500   # a game with no ratings (a pasted PGN without Elo tags)
BLUNDER = 20.0
MISTAKE = 8.0
INACCURACY = 5.0
EXCELLENT = 1.5          # <= this: "excellent"
CP_MISTAKE = 300         # material floor: a move that hangs material AND drops the eval this much is at least a mistake
CP_BLUNDER = 800         # ... and this much is a blunder, however won the position already was
MATERIAL_MISTAKE = 300   # ... and a move whose engine line ends a piece down on the best move's is at least a mistake, whatever the eval says
LOSING_MATERIAL_CP = -400   # at or below this the mover is losing: material they give away is a mistake however flat the eval (chess.com)
MATE_FROM_LOST_CP = -650   # at or below this, allowing a mate is an inaccuracy (mate in 4+) or a mistake (1-3), not a blunder
ONLY_MOVE_GAP = 15.0     # win% gap between MultiPV #1 and #2 -> "great" / "only move"
MISS_BEFORE_MIN = 40.0   # "miss" needs a chance to miss: the mover had at least this win% before the move ...
MISS_AFTER_MIN = 10.0    # ... and didn't throw the game away with it (below this it is a blunder)
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
