"""Puzzle packs and the puzzle of the day.

A pack is a theme (or a few related ones) laid out as stages that go uphill: each stage is STAGE_SIZE puzzles from
one STEP-wide rating band, filled evenly from its SLICES slices so it climbs inside too, and numbered from the easiest.
A pack runs to MAX_STAGES at most and has fewer where good material is thin. Solving STAGE_PASS of a stage opens the
next one; stages at or below your puzzle rating are open from the start once that rating has something behind it
(OPEN_BY_RATING_AFTER puzzles), and so is a stage once you've solved enough of the pack's themes at the level of the
stage below it, wherever you solved them (credit) -- which also keeps progress made in an earlier layout of the packs.

The packs are picked by build() and frozen into puzzle_packs/packs.json by scripts/build_puzzle_packs.py, so
"Forks 3 · 17" is the same puzzle on every machine. They are picked from the whole Lichess puzzle database, not just
the library's sample; the script adds the puzzles it picks to the library (puzzles.json). What makes the cut:
    a puzzle is in one pack at most, and the more specific packs choose first (CLAIM);
    one puzzle per game, one per position;
    within a slice the best-liked, most-played ones first, with a bonus for a quiet first move or a sacrifice and a
    penalty for one-movers and free pieces where the pack isn't about them (score);
    in a stage, limits on how much may repeat: the same first or last move, a second motif, the piece that moves
    first, the phase, the opening, one-movers (the shares below).
The same file holds the daily list: the puzzle of day n is daily[(n - 1) % len], day 1 being DAILY_EPOCH, so everyone
on the same version gets the same puzzle on the same date -- what makes it something to talk about. Rebuilding the
packs keeps it, and no pack takes a puzzle from it.

The app half (progress, credit, the ladder, the daily record) is js/server/packs.js. A build tool, run by
scripts/build_puzzle_packs.py.
"""

import datetime as dt
import json
import math
import random
from pathlib import Path
from typing import Optional

PACKS = Path(__file__).resolve().parent.parent / "chess_review" / "puzzle_packs" / "packs.json"

STAGE_SIZE = 20
STAGE_PASS = 0.8                # 16 of 20 opens the next stage
MAX_STAGES = 10
STEP = 200                      # each stage this many rating points above the one before
SLICES = 4                      # ... filled evenly from its four 50-point slices
SPAN = (600, 2600)              # a pack's span unless it says otherwise
SLICE_DEPTH = 3                 # a stage is only made where each slice has this many times what it needs
OPEN_BY_RATING_AFTER = 20       # puzzles behind your rating before it opens the stages below it

# how much of a stage may share something
SAME_MOVE = 2                   # the same first or last move, e.g. Qxf2#
SAME_OPENING = 3
ONE_MOVE = 1 / 3                # one-move puzzles, where the pack isn't about them
MOTIF = 0.4                     # a second motif
PIECE = 0.5                     # the kind of piece that moves first
PHASE = 0.7                     # the phase, in packs that aren't about one
# tags that say how long, which phase, how big or whose game, not what to look for
GENERIC = {"short", "long", "veryLong", "oneMove", "opening", "middlegame", "endgame", "crushing", "advantage",
           "equality", "mate", "master", "masterVsMaster", "superGM"}
ONE_MOVE_THEMES = {"mateIn1", "hangingPiece"}   # packs where one move is the point

DAILY_EPOCH = dt.date(2026, 10, 20)
DAILY_MIN, DAILY_MAX = 1900, 2400
DAILY_MIN_PLIES = 6             # the setup and at least three moves of yours, the last of them answered
DAILY_POPULARITY = 90
DAILY_SEED = "chess-review daily"

# (id, family, name, description, themes, (lowest, highest) rating or None for SPAN, themes it leaves out)
DEFS = [
    ("mate-in-one", "Intro", "Mate in one", "The finishing blow, one move deep.", ["mateIn1"], (500, 1500), []),
    ("hanging", "Intro", "Hanging pieces", "Something is left undefended. Take it.", ["hangingPiece"], (500, 1500), []),
    ("forks", "Motifs", "Forks", "One piece hits two at once.", ["fork"], None, []),
    ("pins", "Motifs", "Pins", "The piece in front can't move without losing the one behind.", ["pin"], None, []),
    ("skewers", "Motifs", "Skewers", "The big piece in front has to move and gives up the one behind.", ["skewer", "xRayAttack"], None, []),
    ("discovered", "Motifs", "Discovered attacks", "Move one piece, unleash another.", ["discoveredAttack", "discoveredCheck", "doubleCheck"], None, []),
    ("deflection", "Motifs", "Deflection and decoys", "Drag a defender away, or lure a piece onto the wrong square.", ["deflection", "attraction"], None, []),
    ("removing-defender", "Motifs", "Removing the defender", "Take away what holds it together.", ["capturingDefender", "clearance", "interference"], None, []),
    ("sacrifices", "Motifs", "Sacrifices", "Give something to get more.", ["sacrifice"], None, []),
    ("advanced-pawns", "Motifs", "Advanced pawns", "A pawn near the end of the board, and what it's worth.", ["advancedPawn", "promotion", "underPromotion"], None, []),
    ("quiet-moves", "Motifs", "Quiet moves", "No check, no capture, and still the strongest.", ["quietMove", "intermezzo"], None, []),
    ("trapped", "Motifs", "Trapped pieces", "A piece with nowhere to go.", ["trappedPiece"], None, []),
    ("defence", "Motifs", "Defence", "Find the move that holds.", ["defensiveMove"], None, []),
    ("mate-in-two", "Mates", "Mate in two", "Two moves to the end.", ["mateIn2"], None, []),
    ("mate-in-three", "Mates", "Mate in three", "Three moves to the end.", ["mateIn3"], None, []),
    ("long-mates", "Mates", "Long mates", "Four moves or more.", ["mateIn4", "mateIn5"], None, []),
    ("back-rank", "Mates", "Back rank", "The king boxed in by its own pawns.", ["backRankMate"], None, []),
    ("named-mates", "Mates", "Classic mating patterns", "Smothered, Anastasia, Boden, Arabian and the rest.",
     ["smotheredMate", "anastasiaMate", "arabianMate", "bodenMate", "doubleBishopMate", "dovetailMate", "epauletteMate",
      "hookMate", "operaMate", "pillsburysMate", "swallowstailMate", "triangleMate", "vukovicMate", "morphysMate",
      "cornerMate", "killBoxMate", "blindSwineMate", "balestraMate"], None, []),
    ("king-attack", "Mates", "King hunts", "The king is out in the open, and it's a hunt, not a quick mate.",
     ["kingsideAttack", "queensideAttack", "exposedKing", "attackingF2F7"], None, ["mateIn1", "mateIn2"]),
    ("pawn-endgames", "Endgames", "Pawn endgames", "Only kings and pawns, and every tempo counts.", ["pawnEndgame", "zugzwang"], None, []),
    ("rook-endgames", "Endgames", "Rook endgames", "The endgame you'll meet most.", ["rookEndgame"], None, []),
    ("minor-endgames", "Endgames", "Bishop and knight endgames", "The minor pieces at the end.", ["bishopEndgame", "knightEndgame"], None, []),
    ("queen-endgames", "Endgames", "Queen endgames", "Queens left on.", ["queenEndgame", "queenRookEndgame"], None, []),
    ("openings", "Mania", "Opening traps", "Punish it before move fifteen.", ["opening"], None, []),
]

# who chooses first: the packs whose theme is narrowest, so the broad ones (sacrifices, short mates, king hunts)
# don't take the puzzles that only fit somewhere narrow
CLAIM = ["named-mates", "back-rank", "trapped", "long-mates", "queen-endgames", "minor-endgames", "pawn-endgames",
         "rook-endgames", "skewers", "removing-defender", "quiet-moves", "defence", "discovered", "pins", "forks",
         "advanced-pawns", "deflection", "mate-in-one", "hanging", "mate-in-three", "mate-in-two", "openings",
         "king-attack", "sacrifices"]


def game_of(r: dict) -> str:
    """The Lichess game a puzzle comes from: https://lichess.org/AbCdEfGh/black#34 -> AbCdEfGh."""
    return r.get("game_url", "").split("lichess.org/")[-1].split("/")[0].split("#")[0][:8] or r["id"]


def features(r: dict) -> dict:
    """What build() compares puzzles by, from the position and the moves."""
    import chess        # only building the packs needs it here
    b = chess.Board(r["fen"])
    mv = r["moves"].split()
    b.push_uci(mv[0])
    pos = " ".join(b.fen().split()[:4])
    key = chess.Move.from_uci(mv[1])
    piece = b.piece_at(key.from_square).symbol().upper()
    quiet = not b.is_capture(key) and not b.gives_check(key)
    sans = []
    for u in mv[1:]:
        m = chess.Move.from_uci(u)
        sans.append(b.san(m))
        b.push(m)
    phase = next((t for t in ("opening", "middlegame", "endgame") if t in r["themes"]), "")
    opening = (r.get("opening") or "").split(" ")[0]
    return {"pos": pos, "piece": piece, "quiet": quiet, "first": sans[0], "last": sans[-1], "phase": phase,
            "opening": opening, "one": len(mv) == 2}


def base_score(r: dict) -> float:
    return r["popularity"] + 3 * math.log10(max(r["plays"], 1))


def score(r: dict, f: dict, want: set) -> float:
    """How much we want a puzzle in a pack: liked and played, then an "aha" over a grab."""
    s = base_score(r)
    if f["quiet"]:
        s += 4
    if "sacrifice" in r["themes"]:
        s += 3
    if not want & ONE_MOVE_THEMES:
        if f["one"]:
            s -= 6
        if "hangingPiece" in r["themes"]:
            s -= 5
    return s


class _Stage:
    """A stage being filled, and what it already has too much of."""

    def __init__(self, want: set, family: str):
        self.want, self.rows, self.counts = want, [], {}
        self.one_ok = bool(want & ONE_MOVE_THEMES)
        self.phase_free = family in ("Endgames",) or "opening" in want

    def _n(self, k) -> int:
        return self.counts.get(k, 0)

    def keys(self, r: dict, f: dict) -> list:
        ks = [("first", f["first"]), ("last", f["last"]), ("piece", f["piece"])]
        ks += [("motif", t) for t in r["themes"] if t not in GENERIC and t not in self.want]
        if f["phase"]:
            ks.append(("phase", f["phase"]))
        if f["opening"]:
            ks.append(("opening", f["opening"]))
        if f["one"]:
            ks.append(("one", True))
        return ks

    def fits(self, r: dict, f: dict, strict: bool) -> bool:
        same = SAME_MOVE if strict else SAME_MOVE + 1
        if self._n(("first", f["first"])) >= same or self._n(("last", f["last"])) >= same:
            return False
        if not strict:
            return True
        cap = lambda share: max(1, int(STAGE_SIZE * share))  # noqa: E731
        if f["one"] and not self.one_ok and self._n(("one", True)) >= cap(ONE_MOVE):
            return False
        if self._n(("piece", f["piece"])) >= cap(PIECE):
            return False
        if f["phase"] and not self.phase_free and self._n(("phase", f["phase"])) >= cap(PHASE):
            return False
        if f["opening"] and self._n(("opening", f["opening"])) >= SAME_OPENING:
            return False
        return all(self._n(("motif", t)) < cap(MOTIF) for t in r["themes"] if t not in GENERIC and t not in self.want)

    def add(self, r: dict, f: dict) -> None:
        self.rows.append(r)
        for k in self.keys(r, f):
            self.counts[k] = self.counts.get(k, 0) + 1


def daily_list(rows: list[dict], exclude=()) -> list[str]:
    """The puzzle of the day's list: hard enough, liked, long enough to be worth a day, shuffled once."""
    out = [r["id"] for r in rows if DAILY_MIN <= r["rating"] <= DAILY_MAX and r["popularity"] >= DAILY_POPULARITY
           and len(r["moves"].split()) >= DAILY_MIN_PLIES and r["id"] not in exclude]
    out.sort()
    random.Random(DAILY_SEED).shuffle(out)
    return out


def build(rows: list[dict], defs: list = DEFS, daily: Optional[list] = None, claim: list = CLAIM,
          stage_size: int = STAGE_SIZE) -> dict:
    """packs.json from candidate rows ({id, fen, moves, rating, popularity, plays, themes: [..], game_url, opening}).
    daily: the daily list to keep (None draws one from rows). Deterministic: the same rows give the same packs."""
    daily = daily_list(rows) if daily is None else list(daily)
    by_theme: dict[str, list[dict]] = {}
    for r in rows:
        for t in r["themes"]:
            by_theme.setdefault(t, []).append(r)
    taken, games, positions = set(daily), set(), set()
    feats: dict[str, dict] = {}
    per = stage_size // SLICES
    order = {pid: n for n, pid in enumerate(claim)}
    built = {}
    for pid, family, name, desc, themes, span, without in sorted(defs, key=lambda d: order.get(d[0], len(order))):
        want, drop = set(themes), set(without)
        lo, hi = span or SPAN
        pool = {r["id"]: r for t in themes for r in by_theme.get(t, ()) if lo <= r["rating"] < hi
                and not drop.intersection(r["themes"])}
        slices: dict[int, list[dict]] = {}
        for r in pool.values():
            slices.setdefault((r["rating"] - lo) // (STEP // SLICES), []).append(r)
        for s in slices.values():
            s.sort(key=lambda r: (-base_score(r), r["id"]))
        stages = []
        for k in range((hi - lo) // STEP):
            if len(stages) == MAX_STAGES:
                break
            parts = [[r for r in slices.get(k * SLICES + j, ()) if r["id"] not in taken] for j in range(SLICES)]
            if any(len(p) < per * SLICE_DEPTH for p in parts):
                continue
            st = _Stage(want, family)
            for part in parts:
                got = 0
                top = part[:per * 20]           # the best-liked of the slice, then the aha decides among them
                for r in top:
                    if r["id"] not in feats:
                        feats[r["id"]] = features(r)
                top.sort(key=lambda r: (-score(r, feats[r["id"]], want), r["id"]))
                for strict in (True, False):
                    for r in top:
                        f = feats[r["id"]]
                        if got == per:
                            break
                        if r["id"] in taken or game_of(r) in games or f["pos"] in positions or not st.fits(r, f, strict):
                            continue
                        st.add(r, f)
                        taken.add(r["id"])
                        games.add(game_of(r))
                        positions.add(f["pos"])
                        got += 1
            if len(st.rows) == stage_size:
                stages.append(st.rows)
            else:                               # couldn't fill it: give its puzzles back
                for r in st.rows:
                    taken.discard(r["id"])
                    games.discard(game_of(r))
                    positions.discard(feats[r["id"]]["pos"])
        if not stages:
            continue
        out = []
        for n, st in enumerate(stages, 1):
            st = sorted(st, key=lambda r: (r["rating"], r["id"]))
            out.append({"n": n, "lo": st[0]["rating"], "hi": st[-1]["rating"], "ids": [r["id"] for r in st]})
        built[pid] = {"id": pid, "family": family, "name": name, "desc": desc, "themes": themes, "without": without,
                      "stages": out}
    packs = [built[d[0]] for d in defs if d[0] in built]
    return {"version": 2, "stage_size": stage_size, "packs": packs, "daily": daily}
