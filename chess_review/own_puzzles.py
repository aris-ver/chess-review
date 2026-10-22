"""Puzzles from your own games: the moves where you went wrong although one move clearly stood out, replayed as
puzzles and brought back on a schedule until you find them.

A position qualifies when it was your move, not forced and out of book, you lost at least MISTAKE win% with the
move you played, you were level or better before it (wp_before >= 50: "find the move", not "pick the least bad"),
and MultiPV says the engine's first choice was the only good one (classify.only_move). The puzzle starts one move
early, like a Lichess one: the opponent's move before yours is played first. The solution is the engine's move,
and then, the way lichess-puzzler does it, the engine's line for as long as each of your moves in it is the only
good one too: the opponent's replies come from MultiPV #1's line, and the solution stops at the first move of yours
where #2 is within ONLY_MOVE_GAP of #1, so it always ends on your move. Those searches run in the background
(extend(), a server job) and go into the shared engine cache; until a puzzle's line is settled it is a one-move
puzzle. The engine's line after the last move of the solution is handed along (`follow`) for the board to show
once the puzzle is over.

These stay out of the puzzle rating. Every finished showing is recorded in the profile's
puzzle_attempts.jsonl, and a puzzle you missed comes back after 1 day, then 3, then 7 days for as long as you keep
finding it; a miss at any point starts it over. Solved first time, or found at the 7-day review, it is learned
and stays away. Starting the schedule over (reset()) archives that file, and every puzzle is new again.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import threading
import time
from pathlib import Path
from typing import Callable, Iterable, Optional

import chess
import duckdb

from . import profiles
from .classify import only_move
from .config import MISTAKE
from .db import connect
from .fen import fen_key
from .puzzles import archive, line
from .site import slug

log = logging.getLogger("own_puzzles")

INTERVALS = [1, 3, 7]   # days until the next showing, after a miss and then each review found
DAY = 86400
FOLLOW_PLIES = 6        # the engine's line after the answer, for the board to show
MAX_SOLVER_MOVES = 8    # a solution stops here even while every move in it is still the only good one

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


# ---------- the line: as long as every move of yours is the only good one ----------

Lines = Callable[[str], Optional[list[dict]]]     # fen_key -> its MultiPV rows, None while not searched yet


def walk(board: chess.Board, first: str, lines_of: Lines) -> tuple[Optional[str], list[str], Optional[list[str]]]:
    """The solution from `board` (the solver to move; `first` is the game's best move there, already known to be
    the only good one): (waiting, solution, pv).

    Each solver move is MultiPV #1 of its position and the opponent's reply is the next move of #1's line. The
    solution grows by a reply and the solver's next move only when that move is the only good one too
    (classify.only_move), so it always ends on a solver move. `pv` is #1's line from the last solver move on.
    `waiting` is the first position on the way whose MultiPV isn't searched yet: the line can't be settled
    without it, and the puzzle stays the one move it was ([first], pv None)."""
    board = board.copy(stack=False)
    solver = "white" if board.turn == chess.WHITE else "black"
    solution: list[str] = []
    pv: Optional[list[str]] = None
    reply: Optional[str] = None
    while True:
        key = fen_key(board.fen())
        ranks = lines_of(key)
        if ranks is None:
            return key, [first], None
        ranks = sorted((r for r in ranks if r["rank"] > 0 and r["move"]), key=lambda r: r["rank"])   # rank 0: game over
        if not ranks:
            break
        top = ranks[0]
        if not solution and top["move"] != first:
            break       # the game's analysis named another move: keep the one-move puzzle as it was
        if solution and not only_move(ranks, solver):
            break
        try:
            mv = chess.Move.from_uci(top["move"])
        except ValueError:
            break
        if mv not in board.legal_moves:
            break
        if reply:
            solution.append(reply)
        solution.append(top["move"])
        pv = list(top["pv"] or [top["move"]])
        board.push(mv)
        if (len(solution) + 1) // 2 >= MAX_SOLVER_MOVES or board.is_game_over() or len(pv) < 2:
            break
        try:
            answer = chess.Move.from_uci(pv[1])
        except ValueError:
            break
        if answer not in board.legal_moves:
            break
        board.push(answer)
        if board.is_game_over():
            break
        reply = pv[1]
    return None, solution or [first], pv


def settle(starts: list[tuple[chess.Board, str]], fetch: Callable[[set[str]], dict[str, list[dict]]]) -> list[tuple]:
    """walk() for many puzzles at once, reading the cache a ply at a time for all of them (one query per round,
    not one per position). `fetch(keys)` returns the MultiPV rows of those keys that are in the cache."""
    known: dict[str, list[dict]] = {}
    asked: set[str] = set()
    while True:
        out = [walk(b, first, known.get) for b, first in starts]
        need = {w for w, _, _ in out if w is not None} - asked
        if not need:
            return out
        asked |= need
        known.update(fetch(need))


def cached_lines(con: duckdb.DuckDBPyConnection, keys: Iterable[str]) -> dict[str, list[dict]]:
    """MultiPV rows of `keys` from evals_multipv (a table on a write connection, a view on a read one)."""
    out: dict[str, list[dict]] = {}
    rows = con.execute("SELECT fen_key, rank, move, eval_cp, mate_in, pv FROM evals_multipv WHERE list_contains(?, fen_key)",
                       [list(keys)]).fetchall()
    for k, rank, move, cp, mate, pv in rows:
        out.setdefault(k, []).append({"rank": rank, "move": move, "eval_cp": cp, "mate_in": mate, "pv": pv or []})
    return out


def _start(r: dict) -> Optional[tuple[chess.Board, str]]:
    """The position the solver faces (after the opponent's setup move) and the game's best move there."""
    try:
        board = chess.Board(r["setup_fen"])
        board.push(chess.Move.from_uci(r["setup_move"]))
        if chess.Move.from_uci(r["best_move"]) not in board.legal_moves:
            return None
    except ValueError:
        return None
    return board, r["best_move"]


def _puzzle(profile: profiles.Profile, r: dict, walked: tuple) -> dict:
    waiting, solution, pv = walked
    if pv is None:      # not settled yet (or the cache disagrees with the game): the one-move puzzle
        pv = r["pv"] if r["pv"] and r["pv"][0] == r["best_move"] else None
    pid = puzzle_id(r["game_id"], r["ply"])
    p = line({"id": pid, "fen": r["setup_fen"], "moves": " ".join([r["setup_move"], *solution]), "rating": None, "themes": []})
    played = r["played_at"]
    p.update({"source": "mine", "profile": profile.id, "themes": [],
              "follow": _follow(p["moves"][-1]["fen"], pv),
              "game": {"slug": slug(r["game_id"]), "ply": r["ply"], "opponent": r["opponent"],
                       "date": played.date().isoformat() if played else None, "time_class": r["time_class"],
                       "played_san": r["san"], "label": r["label"]}})
    return p


def extend(con: duckdb.DuckDBPyConnection, search: Callable[[list[str]], None], should_stop: Callable[[], bool] = lambda: False,
           on_progress: Optional[Callable[[int, int], None]] = None) -> dict:
    """The background half: search every position the puzzles' lines are waiting on, a round (a ply) at a time,
    until each line is settled. `con` is a write connection to evals.duckdb with the profile's views on it, and
    `search(keys)` puts the MultiPV of those positions into it. Settled lines cost a few cache reads, nothing else."""
    rows = con.execute(CANDIDATES_SQL).fetch_arrow_table().to_pylist()
    starts = [s for s in map(_start, rows) if s]
    searched: set[str] = set()
    out = []
    while True:
        out = settle(starts, lambda keys: cached_lines(con, keys))
        need = sorted({w for w, _, _ in out if w is not None})
        if on_progress:
            on_progress(len(out) - sum(1 for w, _, _ in out if w is not None), len(out))
        if not need or should_stop() or searched.issuperset(need):    # (the last: a search that stored nothing)
            break
        search(need)
        searched.update(need)
    return {"puzzles": len(out), "searched": len(searched), "waiting": sum(1 for w, _, _ in out if w is not None),
            "lines": sum(1 for _, s, _ in out if len(s) > 1)}


class Pool:
    """Each profile's puzzles, rebuilt when its classified moves change (after an analysis or a refresh) or the
    background job has settled more lines (invalidate())."""

    def __init__(self):
        self._cache: dict[str, tuple[float, list[dict], int]] = {}
        self._lock = threading.Lock()

    def invalidate(self, profile_id: str) -> None:
        with self._lock:
            self._cache.pop(profile_id, None)

    def puzzles(self, profile: profiles.Profile) -> list[dict]:
        return self._load(profile)[1]

    def waiting(self, profile: profiles.Profile) -> int:
        """How many of the profile's puzzles are still one-move puzzles until the background job searches more."""
        return self._load(profile)[2]

    def _load(self, profile: profiles.Profile) -> tuple[float, list[dict], int]:
        try:
            stamp = profile.moves_parquet.stat().st_mtime
        except OSError:
            return 0.0, [], 0
        with self._lock:
            hit = self._cache.get(profile.id)
            if hit and hit[0] == stamp:
                return hit
            con = connect(profile)
            try:
                rows = con.execute(CANDIDATES_SQL).fetch_arrow_table().to_pylist()
                rows = [(r, s) for r, s in ((r, _start(r)) for r in rows) if s]
                walked = settle([s for _, s in rows], lambda keys: cached_lines(con, keys))
                # without the live cache (the engine job has it open) every line looks unsettled: don't keep that
                live = con.execute("SELECT count(*) FROM duckdb_databases() WHERE database_name = 'evdb'").fetchone()[0] > 0
            finally:
                con.close()
            out = [_puzzle(profile, r, w) for (r, _), w in zip(rows, walked)]
            entry = (stamp, out, sum(1 for w, _, _ in walked if w is not None))
            if live:
                self._cache[profile.id] = entry
            log.info("own puzzles for %s: %d, %d with a line, %d waiting", profile.id, len(out),
                     sum(1 for _, s, _ in walked if len(s) > 1), entry[2])
            return entry

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


def reset(profile: profiles.Profile) -> Optional[Path]:
    """Start the review schedule over: every puzzle is new again. The record is archived next to it, not deleted
    (puzzles.archive), so renaming it back undoes this."""
    with _lock:
        return archive(attempts_path(profile))


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
