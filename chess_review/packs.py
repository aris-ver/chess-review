"""Puzzle packs and the puzzle of the day, both cut from the Lichess pack (puzzles.PACK).

A pack is a theme (or a few related ones) laid out as stages that go uphill: each stage is STAGE_SIZE puzzles from
one 100-point rating band (bands too thin to fill a stage are merged with the next), numbered from the easiest.
Solving STAGE_PASS of a stage opens the next one; stages at or below your puzzle rating are open from the start
once that rating has something behind it (OPEN_BY_RATING_AFTER puzzles).

The packs are frozen into puzzle_packs/packs.json by scripts/build_puzzle_packs.py, so "Forks 3 · 17" is the same
puzzle on every machine and after the parquet is rebuilt (rebuilding packs.json is what changes them). The same
file holds the daily list: the puzzle of day n is daily[(n - 1) % len], day 1 being DAILY_EPOCH, so everyone on the
same version gets the same puzzle on the same date -- what makes it something to talk about.

What you've done with a puzzle comes from two records:
    DATA/puzzle_attempts.jsonl  (puzzles.py) the first try at each puzzle: solved clean or not
    DATA/puzzle_solved.jsonl    one line per puzzle solved later on, after a miss or a hint: {id, ts}
A puzzle is "clean" when its first try was solved without a mistake or a hint, "solved" when it was solved since,
"missed" when it was tried and never solved. Puzzles tried in the library count toward the packs they are in.

    DATA/puzzle_daily.jsonl     one line per day played, the first showing only: {date, n, id, solved, clean, ms, marks}
"""

import datetime as dt
import json
import math
import random
import threading
import time
from pathlib import Path
from typing import Optional

from . import puzzles
from .config import DATA

PACKS = Path(__file__).parent / "puzzle_packs" / "packs.json"
SOLVED = DATA / "puzzle_solved.jsonl"
DAILY = DATA / "puzzle_daily.jsonl"

STAGE_SIZE = 30
STAGE_PASS = 0.8                # 24 of 30 opens the next stage
MIN_LAST_STAGE = 10             # a thinner top band than this is left out rather than make a stub stage
BAND = 100
OPEN_BY_RATING_AFTER = 20       # puzzles behind your rating before it opens the stages below it
DAILY_EPOCH = dt.date(2026, 10, 20)
DAILY_MIN, DAILY_MAX = 1900, 2400
DAILY_MIN_PLIES = 6             # the setup and at least three moves of yours, the last of them answered
DAILY_POPULARITY = 90
DAILY_SEED = "chess-review daily"

# (id, family, name, description, themes, highest rating)
DEFS = [
    ("mate-in-one", "Intro", "Mate in one", "The finishing blow, one move deep.", ["mateIn1"], 1500),
    ("hanging", "Intro", "Hanging pieces", "Something is left undefended. Take it.", ["hangingPiece"], 1600),
    ("first-forks", "Intro", "First forks", "One piece, two targets.", ["fork"], 1200),
    ("forks", "Motifs", "Forks", "One piece hits two at once.", ["fork"], None),
    ("pins", "Motifs", "Pins", "The piece in front can't move without losing the one behind.", ["pin"], None),
    ("skewers", "Motifs", "Skewers", "The big piece in front has to move and gives up the one behind.", ["skewer", "xRayAttack"], None),
    ("discovered", "Motifs", "Discovered attacks", "Move one piece, unleash another.", ["discoveredAttack", "discoveredCheck", "doubleCheck"], None),
    ("deflection", "Motifs", "Deflection and decoys", "Drag a defender away, or lure a piece onto the wrong square.", ["deflection", "attraction"], None),
    ("removing-defender", "Motifs", "Removing the defender", "Take away what holds it together.", ["capturingDefender", "clearance", "interference"], None),
    ("sacrifices", "Motifs", "Sacrifices", "Give something to get more.", ["sacrifice"], None),
    ("advanced-pawns", "Motifs", "Advanced pawns", "A pawn near the end of the board, and what it's worth.", ["advancedPawn", "promotion", "underPromotion"], None),
    ("quiet-moves", "Motifs", "Quiet moves", "No check, no capture, and still the strongest.", ["quietMove", "intermezzo"], None),
    ("trapped", "Motifs", "Trapped pieces", "A piece with nowhere to go.", ["trappedPiece"], None),
    ("defence", "Motifs", "Defence", "Find the move that holds.", ["defensiveMove"], None),
    ("mate-in-two", "Mates", "Mate in two", "Two moves to the end.", ["mateIn2"], None),
    ("mate-in-three", "Mates", "Mate in three", "Three moves to the end.", ["mateIn3"], None),
    ("long-mates", "Mates", "Long mates", "Four moves or more.", ["mateIn4", "mateIn5"], None),
    ("back-rank", "Mates", "Back rank", "The king boxed in by its own pawns.", ["backRankMate"], None),
    ("named-mates", "Mates", "Classic mating patterns", "Smothered, Anastasia, Boden, Arabian and the rest.",
     ["smotheredMate", "anastasiaMate", "arabianMate", "bodenMate", "doubleBishopMate", "dovetailMate", "epauletteMate",
      "hookMate", "operaMate", "pillsburysMate", "swallowstailMate", "triangleMate", "vukovicMate", "morphysMate",
      "cornerMate", "killBoxMate", "blindSwineMate", "balestraMate"], None),
    ("king-attack", "Mates", "King hunts", "The king is out in the open.", ["kingsideAttack", "queensideAttack", "exposedKing", "attackingF2F7"], None),
    ("pawn-endgames", "Endgames", "Pawn endgames", "Only kings and pawns, and every tempo counts.", ["pawnEndgame", "zugzwang"], None),
    ("rook-endgames", "Endgames", "Rook endgames", "The endgame you'll meet most.", ["rookEndgame"], None),
    ("minor-endgames", "Endgames", "Bishop and knight endgames", "The minor pieces at the end.", ["bishopEndgame", "knightEndgame"], None),
    ("queen-endgames", "Endgames", "Queen endgames", "Queens left on.", ["queenEndgame", "queenRookEndgame"], None),
    ("openings", "Mania", "Opening traps", "Punish it before move fifteen.", ["opening"], None),
    ("mixed", "Mania", "Everything", "Any theme, from 500 to the very top.", [], None),
]


def build(rows: list[dict], defs: list = DEFS, stage_size: int = STAGE_SIZE) -> dict:
    """packs.json from the pack's rows ({id, rating, popularity, plays, themes: [..], moves}). Deterministic: the same
    rows always give the same packs. In each band the most popular puzzles go first."""
    packs, used = [], set()
    for pid, family, name, desc, themes, top in defs:
        want = set(themes)
        pool = [r for r in rows if (not want or want.intersection(r["themes"])) and (top is None or r["rating"] <= top)]
        bands: dict[int, list[dict]] = {}
        for r in pool:
            bands.setdefault(r["rating"] // BAND, []).append(r)
        stages, cur = [], []
        for b in sorted(bands):
            ranked = sorted(bands[b], key=lambda r: (-r["popularity"], -r["plays"], r["id"]))
            cur += ranked[:stage_size - len(cur)]
            if len(cur) == stage_size:
                stages.append(cur)
                cur = []
        if len(cur) >= MIN_LAST_STAGE:
            stages.append(cur)
        if not stages:
            continue
        out = []
        for n, st in enumerate(stages, 1):
            st = sorted(st, key=lambda r: (r["rating"], r["id"]))
            out.append({"n": n, "lo": st[0]["rating"], "hi": st[-1]["rating"], "ids": [r["id"] for r in st]})
            used.update(r["id"] for r in st)
        packs.append({"id": pid, "family": family, "name": name, "desc": desc, "themes": themes, "stages": out})
    daily = [r["id"] for r in rows if DAILY_MIN <= r["rating"] <= DAILY_MAX and r["popularity"] >= DAILY_POPULARITY
             and len(r["moves"].split()) >= DAILY_MIN_PLIES and r["id"] not in used]
    daily.sort()
    random.Random(DAILY_SEED).shuffle(daily)
    return {"version": 1, "stage_size": stage_size, "packs": packs, "daily": daily}


class Packs:
    """packs.json, read once on first use."""

    def __init__(self, path: Path = PACKS):
        self.path = path
        self._data: Optional[dict] = None
        self._lock = threading.Lock()

    def data(self) -> dict:
        with self._lock:
            if self._data is None:
                try:
                    self._data = json.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    self._data = {"packs": [], "daily": []}
            return self._data

    def get(self, pack_id: str) -> Optional[dict]:
        return next((p for p in self.data()["packs"] if p["id"] == pack_id), None)


INSTANCE = Packs()

_lock = threading.Lock()


def _lines(path: Path) -> list[dict]:
    return puzzles.attempts(path)       # the same forgiving jsonl reader


def first_tries(attempts_path: Path = None) -> dict[str, bool]:
    """id -> solved clean on the first try, from the attempts record and the ones archived by a rating reset."""
    path = attempts_path or puzzles.ATTEMPTS
    out: dict[str, bool] = {}
    for old in sorted(path.parent.glob(f"{path.stem}.reset-*{path.suffix}")) + [path]:
        for a in _lines(old):
            out.setdefault(a["id"], bool(a["solved"]))
    return out


def solved_later(path: Path = None) -> set[str]:
    return {a["id"] for a in _lines(path or SOLVED)}


def mark_solved(pid: str, path: Path = None) -> None:
    """A puzzle solved, after a miss or a hint (shown the solution doesn't count)."""
    path = path or SOLVED
    with _lock:
        if pid in solved_later(path):
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"id": pid, "ts": int(time.time())}) + "\n")


def state_of(pid: str, first: dict[str, bool], later: set[str]) -> str:
    if first.get(pid):
        return "clean"
    if pid in later:
        return "solved"
    return "missed" if pid in first else "new"


def need(stage: dict) -> int:
    return math.ceil(len(stage["ids"]) * STAGE_PASS)


def ladder(pack: dict, first: dict[str, bool], later: set[str], stats: dict, pack_rows=None) -> dict:
    """A pack with every puzzle's state, and which stages are open."""
    by_rating = pack_rows or {}
    rated = stats.get("played", 0) >= OPEN_BY_RATING_AFTER
    stages, prev_ok = [], True
    for st in pack["stages"]:
        cells = [{"id": i, "state": state_of(i, first, later), "rating": by_rating.get(i)} for i in st["ids"]]
        solved = sum(c["state"] in ("clean", "solved") for c in cells)
        clean = sum(c["state"] == "clean" for c in cells)
        is_open = prev_ok or (rated and st["lo"] <= stats.get("rating", 0))
        stages.append({"n": st["n"], "lo": st["lo"], "hi": st["hi"], "open": is_open, "solved": solved, "clean": clean,
                       "need": need(st), "size": len(cells), "puzzles": cells})
        prev_ok = solved >= need(st)
    total = sum(s["size"] for s in stages)
    solved = sum(s["solved"] for s in stages)
    clean = sum(s["clean"] for s in stages)
    current = next((s["n"] for s in stages if s["open"] and s["solved"] < s["size"]), None)
    return {"id": pack["id"], "family": pack["family"], "name": pack["name"], "desc": pack["desc"], "stages": stages,
            "total": total, "solved": solved, "clean": clean, "current": current,
            "done": solved == total, "perfect": clean == total}


def shelf(stats: dict, attempts_path: Path = None, solved_path: Path = None) -> list[dict]:
    """Every pack's progress, without the puzzles."""
    first, later = first_tries(attempts_path), solved_later(solved_path)
    out = []
    for p in INSTANCE.data()["packs"]:
        lad = ladder(p, first, later, stats)
        stages = lad.pop("stages")
        lad["current_lo"] = next((s["lo"] for s in stages if s["n"] == lad["current"]), stages[-1]["lo"])   # how hard it is where you are
        lad["n_stages"] = len(p["stages"])
        lad["lo"], lad["hi"] = p["stages"][0]["lo"], p["stages"][-1]["hi"]
        out.append(lad)
    return out


def where(pid: str) -> list[dict]:
    """The packs a puzzle is in: [{pack, name, stage, n}] (n counts from 1)."""
    out = []
    for p in INSTANCE.data()["packs"]:
        for st in p["stages"]:
            if pid in st["ids"]:
                out.append({"pack": p["id"], "name": p["name"], "stage": st["n"], "n": st["ids"].index(pid) + 1})
    return out


# ---------- the puzzle of the day ----------

def day_number(day: dt.date) -> int:
    return (day - DAILY_EPOCH).days + 1


def daily_id(day: dt.date) -> Optional[str]:
    ids = INSTANCE.data()["daily"]
    return ids[(day_number(day) - 1) % len(ids)] if ids else None


def daily_record(path: Path = None) -> list[dict]:
    return _lines(path or DAILY)


def streaks(rec: list[dict], today: dt.date) -> tuple[int, int]:
    """(current, best): days in a row with the daily solved. Today unsolved yet doesn't break it."""
    days = sorted({dt.date.fromisoformat(r["date"]) for r in rec if r.get("solved")})
    best = run = 0
    prev = None
    for d in days:
        run = run + 1 if prev and (d - prev).days == 1 else 1
        best = max(best, run)
        prev = d
    current = run if prev and (today - prev).days <= 1 else 0
    return current, best


def daily(today: dt.date, path: Path = None) -> dict:
    rec = daily_record(path)
    mine = next((r for r in rec if r["date"] == today.isoformat()), None)
    cur, best = streaks(rec, today)
    return {"date": today.isoformat(), "n": day_number(today), "id": daily_id(today), "result": mine,
            "streak": cur, "best_streak": best}


def record_daily(today: dt.date, pid: str, solved: bool, clean: bool, ms: Optional[int], marks: list,
                 path: Path = None) -> dict:
    """The day's first showing, once: a second report for the same date is ignored."""
    path = path or DAILY
    with _lock:
        rec = daily_record(path)
        if not any(r["date"] == today.isoformat() for r in rec) and pid == daily_id(today):
            r = {"date": today.isoformat(), "n": day_number(today), "id": pid, "solved": bool(solved),
                 "clean": bool(solved and clean), "ms": ms, "marks": [str(m) for m in marks][:20]}
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(r) + "\n")
    return daily(today, path)
