"""Puzzle trainer: the Lichess pack shipped in puzzle_packs/ (scripts/build_puzzle_pack.py makes it), a record of
every first try at a puzzle, and a rating worked out from that record.

A Lichess puzzle starts one move early: `fen` is the position before the opponent's move, and the first UCI move
in `moves` is that move (the setup), played by the board before the solver's turn. Every other move after it
is the solver's, answered by the opponent's reply.

    DATA/puzzle_attempts.jsonl   one line per puzzle tried: {id, ts, solved, ms, hinted, rating}

Only the first try at a puzzle counts, the way Lichess does it: the page posts the result as soon as the solver
goes wrong, asks for a hint or the solution, or solves it, and solving it on a second try changes nothing. The
rating is Glicko-1, replayed from the record (a few thousand lines at most), so there is nothing else to keep
in step with it.

Resetting the rating moves the record aside as puzzle_attempts.reset-<when>.jsonl (rename it back to undo) and
the rating starts again at 1500. The puzzles tried before stay out of the deal.
"""

import json
import logging
import math
import random
import re
import threading
import time
from pathlib import Path
from typing import Optional

import chess

from .config import DATA
from .db import read_parquet

log = logging.getLogger("puzzles")
PACK = Path(__file__).parent / "puzzle_packs" / "lichess.parquet"
ATTEMPTS = DATA / "puzzle_attempts.jsonl"

START_RATING, START_RD = 1500.0, 350.0
MIN_RD = 60.0           # never fully settled, so the rating keeps following you
PUZZLE_RD = 75.0        # the pack keeps puzzles whose own rating deviation is at most 80
PROVISIONAL_RD = 110.0  # shown with a "?" above this, like Lichess
WINDOW = 150            # next puzzle: within this of your rating, widened when nothing is left there

_Q = math.log(10) / 400

# Lichess's own names where splitting the camelCase id doesn't give them
THEME_NAMES = {
    "mateIn1": "Mate in 1", "mateIn2": "Mate in 2", "mateIn3": "Mate in 3", "mateIn4": "Mate in 4", "mateIn5": "Mate in 5+",
    "oneMove": "One-move puzzle", "veryLong": "Very long puzzle", "short": "Short puzzle", "long": "Long puzzle",
    "attackingF2F7": "Attacking f2 or f7", "xRayAttack": "X-ray attack", "enPassant": "En passant",
    "superGM": "Super GM game", "masterVsMaster": "Master vs master", "master": "Master game",
    "crushing": "Crushing", "advantage": "Advantage", "equality": "Equality", "mate": "Checkmate",
    "hangingPiece": "Hanging piece", "underPromotion": "Underpromotion", "killBoxMate": "Kill box mate",
    "morphysMate": "Morphy's mate", "pillsburysMate": "Pillsbury's mate", "swallowstailMate": "Swallow's tail mate",
}


def theme_name(tag: str) -> str:
    if tag in THEME_NAMES:
        return THEME_NAMES[tag]
    words = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", tag).split()
    return " ".join([words[0].capitalize()] + [w.lower() for w in words[1:]]) if words else tag


class Pack:
    """The shipped puzzles, read once on first use (a few MB)."""

    def __init__(self, path: Path = PACK):
        self.path = path
        self._rows: Optional[list[dict]] = None
        self._by_id: dict[str, dict] = {}
        self._lock = threading.Lock()

    def rows(self) -> list[dict]:
        with self._lock:
            if self._rows is None:
                rows = self._read()
                for r in rows:
                    r["themes"] = r["themes"].split()
                self._rows, self._by_id = rows, {r["id"]: r for r in rows}
                log.info("puzzle pack: %d puzzles from %s", len(rows), self.path)
            return self._rows

    def _read(self) -> list[dict]:
        """The pack's rows as stored. The browser version reads them from JSON instead (web/py/chess_web/bridge.py),
        so the puzzles answer before DuckDB has loaded."""
        return read_parquet(self.path) if self.path.exists() else []

    def get(self, pid: str) -> Optional[dict]:
        self.rows()
        return self._by_id.get(pid)

    def themes(self) -> list[dict]:
        counts: dict[str, int] = {}
        for r in self.rows():
            for t in r["themes"]:
                counts[t] = counts.get(t, 0) + 1
        return sorted(({"id": t, "name": theme_name(t), "count": n} for t, n in counts.items()), key=lambda d: d["name"])


def _move(board: chess.Board, uci: str) -> dict:
    mv = chess.Move.from_uci(uci)
    san = board.san(mv)
    board.push(mv)
    return {"uci": uci, "san": san, "fen": board.fen()}


def line(p: dict) -> dict:
    """What the page plays: every move with its SAN and the FEN after it, and -- where the solution ends in mate --
    the other mates the solver's last move may give instead (Lichess accepts any mate there)."""
    board = chess.Board(p["fen"])
    ucis = p["moves"].split()
    moves = [_move(board, u) for u in ucis]
    mates = []
    if board.is_checkmate() and len(ucis) % 2 == 0:     # the solver moved last and it mates
        before = chess.Board(moves[-2]["fen"])
        for mv in before.legal_moves:
            if mv.uci() == ucis[-1]:
                continue
            before.push(mv)
            mate = before.is_checkmate()
            before.pop()
            if mate:
                mates.append(_move(before.copy(), mv.uci()))
    solver = "white" if chess.Board(moves[0]["fen"]).turn == chess.WHITE else "black"
    return {"id": p["id"], "source": "lichess", "fen": p["fen"], "rating": p["rating"], "colour": solver,
            "themes": [{"id": t, "name": theme_name(t)} for t in p["themes"]],
            "game_url": p.get("game_url") or None, "moves": moves, "mates": mates}


# ---------- the record and the rating ----------

_lock = threading.Lock()


def attempts(path: Path = None) -> list[dict]:
    path = path or ATTEMPTS
    out = []
    try:
        with path.open(encoding="utf-8") as f:
            for ln in f:
                try:
                    out.append(json.loads(ln))
                except ValueError:
                    continue        # a line cut short by a crash: skip it, keep the rest
    except OSError:
        pass
    return out


def glicko(r: float, rd: float, opp: float, score: float, opp_rd: float = PUZZLE_RD) -> tuple[float, float]:
    """One Glicko-1 rating period with a single game: the solver (r, rd) against a puzzle rated opp."""
    g = 1 / math.sqrt(1 + 3 * _Q * _Q * opp_rd * opp_rd / math.pi ** 2)
    e = 1 / (1 + 10 ** (-g * (r - opp) / 400))
    d2 = 1 / (_Q * _Q * g * g * e * (1 - e))
    denom = 1 / (rd * rd) + 1 / d2
    return r + _Q / denom * g * (score - e), max(MIN_RD, math.sqrt(1 / denom))


def stats(record: list[dict]) -> dict:
    r, rd = START_RATING, START_RD
    streak = best = solved = 0
    last_delta = None
    for a in record:
        before = r
        r, rd = glicko(r, rd, float(a["rating"]), 1.0 if a["solved"] else 0.0)
        last_delta = round(r) - round(before)
        if a["solved"]:
            solved += 1
            streak += 1
            best = max(best, streak)
        else:
            streak = 0
    return {"rating": round(r), "rd": round(rd), "provisional": rd > PROVISIONAL_RD, "played": len(record),
            "solved": solved, "streak": streak, "best_streak": best, "last_delta": last_delta}


def record(pid: str, puzzle_rating: int, solved: bool, ms: Optional[int] = None, hinted: bool = False,
           path: Path = None) -> Optional[dict]:
    """Append a first try; a second report for the same puzzle is ignored. Returns the new stats, or None when
    the puzzle had been tried already."""
    path = path or ATTEMPTS
    with _lock:
        rec = attempts(path)
        if any(a["id"] == pid for a in rec):
            return None
        a = {"id": pid, "ts": int(time.time()), "solved": bool(solved) and not hinted, "ms": ms, "hinted": bool(hinted),
             "rating": int(puzzle_rating)}
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(a) + "\n")
        return stats(rec + [a])


def archive(path: Path) -> Optional[Path]:
    """Move an attempts file aside as <name>.reset-<when>.jsonl next to it, so a reset can be undone by renaming it
    back. None when there was nothing to move."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = path.with_name(f"{path.stem}.reset-{stamp}{path.suffix}")
    n = 1
    while dest.exists():
        n += 1
        dest = path.with_name(f"{path.stem}.reset-{stamp}-{n}{path.suffix}")
    try:
        path.rename(dest)
    except FileNotFoundError:
        return None
    return dest


def reset(path: Path = None) -> Optional[Path]:
    """Start the rating over from 1500: the record is archived, not deleted (see archive())."""
    path = path or ATTEMPTS
    with _lock:
        return archive(path)


def tried(path: Path = None) -> set[str]:
    """Every puzzle tried, before a reset as well: those stay out of the deal, so a new rating isn't propped up by
    puzzles you remember the answer to."""
    path = path or ATTEMPTS
    ids = {a["id"] for a in attempts(path)}
    for old in path.parent.glob(f"{path.stem}.reset-*{path.suffix}"):
        ids |= {a["id"] for a in attempts(old)}
    return ids


def pick(rows: list[dict], rating: float, themes: Optional[set[str]] = None, exclude: Optional[set[str]] = None,
         rng: random.Random = random) -> Optional[dict]:
    """A random puzzle near `rating` carrying any of `themes` (all when empty), never one in `exclude`. The window
    widens until something fits, so a narrow theme near the top or bottom still finds the closest puzzles."""
    pool = [r for r in rows if (not themes or themes.intersection(r["themes"])) and not (exclude and r["id"] in exclude)]
    if not pool:
        return None
    window = WINDOW
    while True:
        near = [r for r in pool if abs(r["rating"] - rating) <= window]
        if near:
            return rng.choice(near)
        window += 100


PACK_INSTANCE = Pack()


def next_puzzle(themes: Optional[set[str]] = None, skip: Optional[str] = None) -> tuple[Optional[dict], dict]:
    rec = attempts()
    st = stats(rec)
    exclude = tried() | ({skip} if skip else set())
    p = pick(PACK_INSTANCE.rows(), st["rating"], themes, exclude)
    return (line(p) if p else None), st
