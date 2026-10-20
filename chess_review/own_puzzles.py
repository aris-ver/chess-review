"""Puzzles from your own games: the moves where you went wrong although one move clearly stood out, replayed as
puzzles and brought back on a schedule until you find them.

A position qualifies when it was your move, not forced and out of book, you lost at least MISTAKE win% with the
move you played, you were level or better before it (wp_before >= 50: "find the move", not "pick the least bad"),
and MultiPV says the engine's first choice was the only good one (classify.only_move). The puzzle starts one move
early, like a Lichess one: the opponent's move before yours is played first. The solution is the engine's move;
until later moves are checked as the only good ones too (phase 3), that one move is the whole puzzle, and the
engine's line after it is handed along (`follow`) for the board to show once the puzzle is over.

These stay out of the puzzle rating. Every finished showing is recorded in the profile's
puzzle_attempts.jsonl, and a puzzle you missed comes back after 1 day, then 3, then 7 days for as long as you keep
finding it; a miss at any point starts it over. Solved first time, or found at the 7-day review, it is learned
and stays away.
"""

import hashlib
import json
import logging
import random
import threading
import time
from pathlib import Path
from typing import Optional

import chess

from . import profiles
from .config import MISTAKE
from .db import connect
from .puzzles import line
from .site import slug

log = logging.getLogger("own_puzzles")

INTERVALS = [1, 3, 7]   # days until the next showing, after a miss and then each review found
DAY = 86400
FOLLOW_PLIES = 6        # the engine's line after the answer, for the board to show

CANDIDATES_SQL = f"""
    SELECT m.game_id, m.ply, m.side_to_move, m.san, m.best_move, m.best_san, m.label, m.wp_before, m.wp_after,
           prev.fen AS setup_fen, prev.move_played AS setup_move, e.pv,
           g.opponent, g.played_at, g.time_class, g.my_colour
    FROM moves m
    JOIN positions p ON p.game_id = m.game_id AND p.ply = m.ply
    JOIN positions prev ON prev.game_id = m.game_id AND prev.ply = m.ply - 1
    JOIN games g ON g.game_id = m.game_id
    LEFT JOIN evals e ON e.fen_key = p.fen_key
    WHERE m.is_mine AND NOT m.is_forced AND NOT m.in_book AND m.only_move
      AND m.wp_loss >= {MISTAKE} AND m.wp_before >= 50 AND m.best_move IS NOT NULL AND m.best_move <> m.move_played
    ORDER BY g.played_at DESC, m.ply
"""


def puzzle_id(game_id: str, ply: int) -> str:
    return "m" + hashlib.sha1(f"{game_id}:{ply}".encode()).hexdigest()[:10]


def is_own_id(pid: str) -> bool:
    return len(pid) == 11 and pid.startswith("m")


def _follow(fen_after_best: str, pv: Optional[list]) -> list[dict]:
    """The engine's line after the answer, as legal moves with SAN and FEN (cut where it stops being legal)."""
    out, board = [], chess.Board(fen_after_best)
    for uci in (pv or [])[1:1 + FOLLOW_PLIES]:
        try:
            mv = chess.Move.from_uci(uci)
        except ValueError:
            break
        if mv not in board.legal_moves:
            break
        san = board.san(mv)
        board.push(mv)
        out.append({"uci": uci, "san": san, "fen": board.fen()})
    return out


def _puzzle(profile: profiles.Profile, r: dict) -> Optional[dict]:
    try:
        board = chess.Board(r["setup_fen"])
        board.push(chess.Move.from_uci(r["setup_move"]))
        if chess.Move.from_uci(r["best_move"]) not in board.legal_moves:
            return None
    except ValueError:
        return None
    pid = puzzle_id(r["game_id"], r["ply"])
    p = line({"id": pid, "fen": r["setup_fen"], "moves": f"{r['setup_move']} {r['best_move']}", "rating": None, "themes": []})
    pv = r["pv"] if r["pv"] and r["pv"][0] == r["best_move"] else None
    played = r["played_at"]
    p.update({"source": "mine", "profile": profile.id, "themes": [],
              "follow": _follow(p["moves"][-1]["fen"], pv),
              "game": {"slug": slug(r["game_id"]), "ply": r["ply"], "opponent": r["opponent"],
                       "date": played.date().isoformat() if played else None, "time_class": r["time_class"],
                       "played_san": r["san"], "label": r["label"]}})
    return p


class Pool:
    """Each profile's puzzles, rebuilt when its classified moves change (after an analysis or a refresh)."""

    def __init__(self):
        self._cache: dict[str, tuple[float, list[dict]]] = {}
        self._lock = threading.Lock()

    def puzzles(self, profile: profiles.Profile) -> list[dict]:
        try:
            stamp = profile.moves_parquet.stat().st_mtime
        except OSError:
            return []
        with self._lock:
            hit = self._cache.get(profile.id)
            if hit and hit[0] == stamp:
                return hit[1]
            con = connect(profile)
            try:
                rows = con.execute(CANDIDATES_SQL).fetch_arrow_table().to_pylist()
            finally:
                con.close()
            out = [p for p in (_puzzle(profile, r) for r in rows) if p]
            self._cache[profile.id] = (stamp, out)
            log.info("own puzzles for %s: %d", profile.id, len(out))
            return out

    def find(self, pid: str) -> Optional[dict]:
        for p in profiles.list_profiles():
            for z in self.puzzles(p):
                if z["id"] == pid:
                    return z
        return None


POOL = Pool()


# ---------- the record and the schedule ----------

_lock = threading.Lock()


def attempts_path(profile: profiles.Profile) -> Path:
    return profile.dir / "puzzle_attempts.jsonl"


def attempts(path: Path) -> list[dict]:
    out = []
    try:
        with path.open(encoding="utf-8") as f:
            for ln in f:
                try:
                    out.append(json.loads(ln))
                except ValueError:
                    continue
    except OSError:
        pass
    return out


def schedule(record: list[dict]) -> dict[str, dict]:
    """puzzle id -> {box, due, learned}: box is how many reviews in a row you've found it since the last miss."""
    out: dict[str, dict] = {}
    for a in sorted(record, key=lambda a: a["ts"]):
        s = out.get(a["id"])
        if not a["solved"]:
            out[a["id"]] = {"box": 0, "due": a["ts"] + INTERVALS[0] * DAY, "learned": False}
        elif s is None or s["learned"]:
            out[a["id"]] = {"box": None, "due": None, "learned": True}     # found first time: nothing to review
        elif s["box"] + 1 < len(INTERVALS):
            out[a["id"]] = {"box": s["box"] + 1, "due": a["ts"] + INTERVALS[s["box"] + 1] * DAY, "learned": False}
        else:
            out[a["id"]] = {"box": None, "due": None, "learned": True}
    return out


def stats(puzzles: list[dict], sched: dict[str, dict], now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    ids = {p["id"] for p in puzzles}
    seen = {k: v for k, v in sched.items() if k in ids}
    due = [v["due"] for v in seen.values() if not v["learned"] and v["due"] <= now]
    later = [v["due"] for v in seen.values() if not v["learned"] and v["due"] > now]
    return {"total": len(ids), "new": len(ids - seen.keys()), "due": len(due),
            "learning": len(later), "learned": sum(1 for v in seen.values() if v["learned"]),
            "next_due": min(later) if later else None}


def pick(puzzles: list[dict], sched: dict[str, dict], skip: Optional[str] = None, now: Optional[float] = None,
         rng: random.Random = random) -> Optional[dict]:
    """The review that has waited longest, else a puzzle you haven't seen yet (in no particular order)."""
    now = time.time() if now is None else now
    pool = [p for p in puzzles if p["id"] != skip]
    due = sorted((p for p in pool if p["id"] in sched and not sched[p["id"]]["learned"] and sched[p["id"]]["due"] <= now),
                 key=lambda p: sched[p["id"]]["due"])
    if due:
        return due[0]
    new = [p for p in pool if p["id"] not in sched]
    return rng.choice(new) if new else None


def next_puzzle(profile: profiles.Profile, skip: Optional[str] = None) -> tuple[Optional[dict], dict]:
    puzzles = POOL.puzzles(profile)
    sched = schedule(attempts(attempts_path(profile)))
    return pick(puzzles, sched, skip), stats(puzzles, sched)


def summary(profile: profiles.Profile) -> dict:
    puzzles = POOL.puzzles(profile)
    return stats(puzzles, schedule(attempts(attempts_path(profile))))


def record(profile: profiles.Profile, pid: str, solved: bool, ms: Optional[int] = None, hinted: bool = False) -> dict:
    """Append one finished showing; returns the profile's stats and this puzzle's place in the schedule."""
    path = attempts_path(profile)
    with _lock:
        a = {"id": pid, "ts": int(time.time()), "solved": bool(solved) and not hinted, "ms": ms, "hinted": bool(hinted)}
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(a) + "\n")
        sched = schedule(attempts(path))
    return {"stats": stats(POOL.puzzles(profile), sched), "review": sched.get(pid)}
