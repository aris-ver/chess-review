"""Parity dumps for the JavaScript port (docs/js-port.md): run the Python functions on fixed inputs and write the
inputs with their outputs to tests/parity/*.json, which the JS tests (js/**/*.test.js) replay field for field.

    python scripts/dump_parity.py            the committed dumps, from tests/fixtures, tests/golden, the puzzle
                                             library and seeded random games (needs bin/stockfish and data/book)
    python scripts/dump_parity.py --local    also every game in data/profiles, with its real evals, to
                                             tests/parity/local/ (gitignored: it is your own data)

Regenerate after any change to the ported modules' logic; the dumps are what the JS has to match.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import chess  # noqa: E402
import chess.engine  # noqa: E402
import duckdb  # noqa: E402

from chess_review import accuracy, book, classify, critical, explain, facts, fen, pov  # noqa: E402
from chess_review.analyse import evaluate, evaluate_multipv  # noqa: E402
from chess_review.config import STOCKFISH  # noqa: E402
from chess_review.normalise import parse_pgn_text  # noqa: E402

OUT = ROOT / "tests" / "parity"
FIXTURE = ROOT / "tests" / "fixtures" / "clocks.pgn"
GOLDEN = ROOT / "tests" / "golden" / "clocks.json"
PUZZLES = ROOT / "chess_review" / "puzzle_packs" / "lichess.parquet"
GOLDEN_NODES = 200_000      # as tests/test_golden.py
MULTIPV_NODES = 30_000
N_PUZZLES = 120
N_RANDOM_GAMES = 8
SEED = 20261023
GAME_FIELDS = ("game_id", "my_colour", "my_rating", "opponent_rating", "time_control", "opening_name")
ROW_FIELDS = ("game_id", "ply", "fen", "fen_key", "side_to_move", "move_played", "clock_remaining",
              "eval_cp", "mate_in", "best_move", "pv")


def write(name: str, data, out: Path = OUT) -> None:
    out.mkdir(parents=True, exist_ok=True)
    path = out / name
    path.write_text(json.dumps(data, separators=(",", ":"), default=str), encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


def col(c: bool) -> str:
    return "white" if c else "black"


# --- the small pure functions ---------------------------------------------------------------------------------

def pure() -> dict:
    cps = list(range(-3000, 3001, 37)) + [0, 1, -1, 10_000, -10_000]
    ks = [pov.LICHESS_K, 0.002, 0.007, classify.grade_k(1500)]
    evals = [(None, None), (35, None), (-410, None), (0, None), (None, 3), (None, -2), (None, 0), (1200, None)]
    sides = ("white", "black")
    tcs = [None, "", "600", "600+0", "180+2", "60+1", "1/86400", "abc", "10+x", "+5", "300+"]
    fens = [chess.STARTING_FEN, "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
            "8/8/8/3k4/8/8/4K3/8 b - - 99 140", "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3"]
    multipvs = [None, [], [{"rank": 1, "eval_cp": 40, "mate_in": None}],
                [{"rank": 2, "eval_cp": -300, "mate_in": None}, {"rank": 1, "eval_cp": 40, "mate_in": None}],
                [{"rank": 1, "eval_cp": None, "mate_in": 2}, {"rank": 2, "eval_cp": 500, "mate_in": None}],
                [{"rank": 1, "eval_cp": 100, "mate_in": None}, {"rank": 2, "eval_cp": 30, "mate_in": None},
                 {"rank": 3, "eval_cp": -20, "mate_in": None}],
                [{"rank": 1, "eval_cp": None, "mate_in": -3}, {"rank": 2, "eval_cp": None, "mate_in": -1}]]
    return {
        "fen_key": [[f, fen.fen_key(f)] for f in fens],
        "board_from_key": [[fen.fen_key(f), fen.board_from_key(fen.fen_key(f)).fen()] for f in fens],
        "win_pct": [[cp, k, pov.win_pct(cp, k)] for cp in cps for k in ks],
        "to_pov": [[cp, m, s, p, list(pov.to_pov(cp, m, s, p))] for cp, m in evals for s in sides for p in sides],
        "pov_win_pct": [[cp, m, s, p, k, pov.pov_win_pct(cp, m, s, p, k)]
                        for cp, m in evals[1:] for s in sides for p in sides for k in ks[:2]],
        "move_accuracy": [[x / 10, accuracy.move_accuracy(x / 10)] for x in range(0, 1001, 7)],
        "label_for": [[x / 4, classify.label_for(x / 4)] for x in range(0, 120)],
        "grade_k": [[r, classify.grade_k(r)] for r in [None, *range(0, 3600, 50), 999, 1001, 2999, 3001]],
        "increment": [[tc, classify._increment(tc)] for tc in tcs],
        "base": [[tc, classify._base(tc)] for tc in tcs],
        "mover_rating": [[g, m, classify.mover_rating(g, m)] for g in [{"my_colour": "white", "my_rating": 900, "opponent_rating": 1200}, {"my_colour": "black", "my_rating": 900}, {}] for m in sides],
        "only_move": [[mp, s, classify.only_move(mp, s)] for mp in multipvs for s in sides],
        "band": [[x / 2, critical.band(x / 2)] for x in range(0, 201)],
        "move_label": [[p, s, explain.move_label(p, s)] for p in (0, 1, 2, 9, 120) for s in ("e4", "Nxf7+")],
        "line": [[sans, p, explain._line(sans, p)] for sans in ([], ["e4"], ["Nc6", "Bxf7+", "Kxf7"]) for p in (0, 1, 27)],
        "clock": [[s, explain._clock(s)] for s in (0, 1, 2, 59, 60, 61, 125, 600, 3599, 3600, 7322)],
    }


# --- board geometry (python-chess behaviour the JS reproduces on chessops) -------------------------------------

def test_fens() -> list[str]:
    """Every FEN quoted in the Python tests that python-chess accepts."""
    out = []
    for path in sorted((ROOT / "tests").glob("test_*.py")):
        for m in re.finditer(r'"([1-8pnbrqkPNBRQK/]{15,} [wb] [KQkq-]+ [a-h1-8-]+ \d+ \d+)"', path.read_text(encoding="utf-8")):
            try:
                chess.Board(m.group(1))
            except ValueError:
                continue
            if m.group(1) not in out:
                out.append(m.group(1))
    return out


def puzzle_lines(n: int) -> list[tuple[str, list[str]]]:
    rows = duckdb.connect().execute(f"SELECT fen, moves FROM read_parquet('{PUZZLES.as_posix()}') ORDER BY id").fetchall()
    step = max(1, len(rows) // n)
    return [(f, m.split()) for f, m in rows[::step][:n]]


def geometry_case(board: chess.Board, line: list[str]) -> dict:
    """Everything facts/classify ask of a board, for one position; `line` is a sensible continuation from it
    (a puzzle's solution, a game's next moves), standing in for an engine line."""
    mover = board.turn
    legal = list(board.legal_moves)
    case = {
        "fen": board.fen(), "line": line,
        "legal": [m.uci() for m in legal], "san": [board.san(m) for m in legal],
        "check": board.is_check(), "checkmate": board.is_checkmate(), "game_over": board.is_game_over(),
        "castling": [m.uci() for m in board.generate_castling_moves()],
        "castling_rights": [board.has_castling_rights(chess.WHITE), board.has_castling_rights(chess.BLACK)],
        "pinned": [[sq, board.is_pinned(board.color_at(sq), sq)] for sq in chess.SquareSet(board.occupied)],
        "attack_targets": [[sq, facts.attack_targets(board, sq)] for sq in chess.SquareSet(board.occupied)],
        "attackers": [[sq, list(board.attackers(chess.WHITE, sq)), list(board.attackers(chess.BLACK, sq))] for sq in chess.SquareSet(board.occupied)],
        "material": [facts.material(board, chess.WHITE), facts.material(board, chess.BLACK)],
        "material_swing": [facts.material_swing(board, line, chess.WHITE), facts.material_swing(board, line[:3], chess.BLACK)],
        "motif": [list(facts.motif(board, m)) for m in legal],
        "moves": [],
    }
    for m in legal:
        after = board.copy(stack=False)
        after.push(m)
        mv = {"uci": m.uci(), "capture": board.is_capture(m), "see": facts.see(board, m) if board.is_capture(m) else None,
              "sacrifice": classify.is_sacrifice(board, m), "fen_after": after.fen(),
              "gives_check": board.gives_check(m),
              "hung": facts.hung_pieces(after, mover) if not after.is_game_over() else None}
        if not after.is_game_over():
            mv["threat"] = facts.threat_move(board, m, [])
            mv["idea"] = facts.idea_arrows(board, m, [])
        case["moves"].append(mv)
    # with the line as the engine's line after its first move
    if line and chess.Move.from_uci(line[0]) in board.legal_moves:
        played, reply = chess.Move.from_uci(line[0]), line[1:]
        after = board.copy(stack=False)
        after.push(played)
        case["with_line"] = {
            "threat": None if after.is_game_over() else facts.threat_move(board, played, reply),
            "idea": None if after.is_game_over() else facts.idea_arrows(board, played, reply),
            "gives_away": classify.gives_away(board, played, line, reply),
            "material_lost": classify.material_lost(board, played, line, reply),
            "sacrifice_holds": [classify.sacrifice_holds(after, reply, mover, m) for m in (None, -2, 3)],
            "sans": facts._sans(board, line, facts.REFUTATION_PLIES),
        }
    return case


EXTRA_LINES = [   # (fen, line) for corners the other positions miss
    # a double step answered by an en passant capture: idea_arrows flips the turn back to the mover, and on that
    # board python-chess (unlike chessops) won't let ...bxa6 capture "en passant" from the seventh rank
    ("r1bqk1nr/pp1pppbp/6p1/1P6/1p6/8/P1NPPPPP/1RBQKBNR b Kkq - 1 7", ["a7a5", "b5a6", "b7a6", "b1b4"]),
    ("rnbqkbnr/ppp1pppp/8/8/3p4/8/PPPPPPPP/RNBQKBNR w KQkq - 0 3", ["e2e4", "d4e3", "d2e3", "e7e5"]),
]


def geometry() -> list[dict]:
    cases = [geometry_case(chess.Board(f), []) for f in test_fens()]
    cases += [geometry_case(chess.Board(f), line) for f, line in EXTRA_LINES]
    for f, moves in puzzle_lines(N_PUZZLES):
        b = chess.Board(f)
        cases.append(geometry_case(b, moves))
        b.push_uci(moves[0])                            # the puzzle position itself, after the opponent's move
        cases.append(geometry_case(b, moves[1:]))
    game, positions = next(parse_pgn_text(FIXTURE.read_text(encoding="utf-8"), "testuser", "golden"))
    ucis = [p["move_played"] for p in positions if p["move_played"]]
    for i, p in enumerate(positions):
        cases.append(geometry_case(chess.Board(p["fen"]), ucis[i:i + 6]))
    return cases


# --- engine output -------------------------------------------------------------------------------------------

class Recorder(logging.Handler):
    """Collects what the engine prints between `go` and `bestmove`, from python-chess's debug log."""

    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines: list[str] = []
        self.on = False

    def emit(self, record):
        if not isinstance(record.args, tuple) or len(record.args) != 2:
            return
        line = str(record.args[1])
        if record.msg.endswith("<< %s") and line.startswith("go "):        # python-chess: << sent, >> received
            self.lines, self.on = [], True
        elif record.msg.endswith(">> %s") and self.on:
            self.lines.append(line)
            if line.startswith("bestmove"):
                self.on = False


class Replay:
    """An engine that answers analyse() from recorded output, parsed exactly as python-chess parses a live one."""

    def __init__(self, lines: list[str]):
        self.lines = lines

    def analyse(self, board, limit, multipv=None, game=None):
        result = chess.engine.AnalysisResult()
        for line in self.lines:
            token, rest = chess.engine._next_token(line)
            if token == "info":
                result.post(chess.engine._parse_uci_info(rest, board))
        return result.multipv if multipv is not None else result.info


SYNTHETIC_LINES = [   # (fen, lines): what a UCI engine may print that Stockfish rarely does
    (chess.STARTING_FEN, ["info string NNUE evaluation using nn-1.nnue", "info depth 1 seldepth 1 multipv 1 score cp 20 nodes 21 nps 10500 time 2 pv e2e4",
                          "info depth 1 seldepth 1 multipv 2 score cp 10 lowerbound nodes 40 pv d2d4 d7d5",
                          "info depth 2 currmove g1f3 currmovenumber 3", "info depth 2 multipv 3 score cp -5 upperbound nodes 60 pv g1f3",
                          "info depth 3 multipv 1 score cp 25 nodes 90 pv e2e4 e7e5 g1f3 b8c6", "info depth 3 multipv 2 nodes 95",
                          "bestmove e2e4 ponder e7e5"]),
    (chess.STARTING_FEN, ["info depth 5 multipv 2 score cp 15 nodes 100 pv d2d4 d7d5", "info depth 5 multipv 1 score cp 30 nodes 120 pv e2e4 e7e5 e1e2 e8e7 e2e9",
                          "info depth 5 multipv 1 score cp 31 nodes 130 pv e2e4 e7e5 e2e4", "info depth 6 multipv 3 score mate 5 wdl 900 90 10 nodes 140 pv c2c4",
                          "bestmove e2e4"]),
    ("r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
     ["info depth 1 multipv 1 score mate 1 nodes 30 pv h5f7", "info depth 1 multipv 2 score cp 50 nodes 31 pv c4f7 e8f7",
      "info depth 1 multipv 3 score cp abc nodes 32 pv d2d3", "info depth 2 multipv 3 score cp 20 nodes 40 pv d2d3 0000 b7b6",
      "info depth 2 multipv 2 score mate -0 nodes 41 pv b1c3 f6h5", "bestmove h5f7"]),
    ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
     ["info depth 9 multipv 1 score cp 0 nodes 999 pv e1g1 e8c8 a1a8 d8a8", "info depth 9 multipv 2 score cp -10 nodes 1000 pv e1h1 e8h8",
      "info depth 9 multipv 3 score cp -20 nodes 1001 pv e1c1 Pe2e4", "bestmove e1g1"]),
    ("8/P6k/8/8/8/8/8/K7 w - - 0 1",
     ["info depth 3 multipv 1 score cp 900 nodes 50 pv a7a8q h7g6 a8a6", "info depth 3 multipv 2 score cp 450 nodes 60 pv a7a8r h7g7",
      "info depth 3 multipv 3 score cp 0 nodes 70 pv a7a8", "info depth 3 nodes 71", "info", "bestmove a7a8q"]),
]

SPECIAL_FENS = [
    "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",     # checkmated
    "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",                                    # stalemate
    "8/8/4k3/8/8/3NK3/8/8 w - - 0 1",                                    # insufficient material
    "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",                              # mate in one
    "6k1/8/8/8/8/8/5P1P/r5K1 w - - 0 1",                                 # one legal move
    "7k/8/8/8/8/8/8/K6q w - - 0 1",                                      # two legal moves (fewer than MultiPV)
    "r3k2r/p1pp1pb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",     # en passant
    "8/1P5k/8/8/8/8/6p1/K7 w - - 0 1",                                   # promotions
]


def engine_case(eng, board: chess.Board, multipv, nodes: int, rec: Recorder) -> dict:
    limit = chess.engine.Limit(nodes=nodes)
    if multipv:
        main, ranks = evaluate_multipv(board, eng, limit, multipv)
        lines = rec.lines if not board.is_game_over() else []
        assert (main, ranks) == evaluate_multipv(board, Replay(lines), limit, multipv), board.fen()
        return {"fen": board.fen(), "multipv": multipv, "lines": lines, "main": main, "ranks": ranks}
    main = evaluate(board, eng, limit)
    lines = rec.lines if not board.is_game_over() and not board.is_stalemate() and not board.is_insufficient_material() else []
    if lines:
        assert main == evaluate(board, Replay(lines), limit), board.fen()
    return {"fen": board.fen(), "multipv": None, "lines": lines, "main": main}


def open_engine() -> tuple[chess.engine.SimpleEngine, Recorder]:
    rec = Recorder()
    log = logging.getLogger("chess.engine")
    log.setLevel(logging.DEBUG)
    log.addHandler(rec)
    eng = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH))
    eng.configure({"Threads": 1, "Hash": 16})
    return eng, rec


# --- games through classify, critical, facts and explain -------------------------------------------------------

def facts_dict(f: facts.MoveFacts) -> dict:
    return dataclasses.asdict(f)


def game_case(name: str, game: dict, rows: list[dict], multipv: dict[str, list[dict]]) -> dict:
    """classify_game and everything the review (site.build_game) and the golden test build on it."""
    game = {k: game.get(k) for k in GAME_FIELDS}
    rows = [{k: r.get(k) for k in ROW_FIELDS} for r in rows]
    for r in rows:
        r["pv"] = list(r["pv"] or [])
    multipv = {k: [dict(m, pv=list(m.get("pv") or [])) for m in v] for k, v in multipv.items()
               if any(k == r["fen_key"] for r in rows)}
    moves = classify.classify_game(game, rows, multipv)
    crit = critical.select(moves)
    by_ply = {m["ply"]: m for m in moves}
    keys = set()
    b = chess.Board(rows[0]["fen"])
    for r in rows[:-1]:
        b.push_uci(r["move_played"])
        keys.add(fen.fen_key(b.fen()))
    out = {"name": name, "game": game, "rows": rows, "multipv": multipv,
           "book": sorted(k for k in keys if book.is_book(k)),
           "moves": moves, "critical": crit, "facts": {}, "comments": {}, "explain": {},
           "accuracy": {s: accuracy.game_accuracy(moves, s) for s in ("white", "black")}}
    for m in moves:
        before, after = rows[m["ply"] - rows[0]["ply"]], rows[m["ply"] - rows[0]["ply"] + 1]
        if not m["label"]:
            continue
        f = facts.extract(m, chess.Board(before["fen"]), before, after, multipv.get(before["fen_key"]))
        out["facts"][m["ply"]] = facts_dict(f)
        out["comments"][m["ply"]] = explain.comment(f, game["opening_name"] if m["in_book"] else None)
    for c in crit:
        before, after = rows[c["ply"] - rows[0]["ply"]], rows[c["ply"] - rows[0]["ply"] + 1]
        f = facts.extract(by_ply[c["ply"]], chess.Board(before["fen"]), before, after)    # as the golden test does
        out["explain"][c["ply"]] = {"facts": facts_dict(f), "headline": explain.headline(f), "text": explain.explain(f),
                                    "move": explain.move_label(c["ply"], by_ply[c["ply"]]["san"])}
    return out


def golden_view(case: dict) -> dict:
    """The reduction tests/golden/clocks.json stores, from a game case (as tests/test_golden.run_chain)."""
    out = {"moves": [{k: m[k] for k in ("ply", "san", "label", "best_san")} | {"wp_loss": None if m["wp_loss"] is None else round(m["wp_loss"], 1)}
                     for m in case["moves"]], "critical": []}
    for c in case["critical"]:
        e = case["explain"][c["ply"]]
        out["critical"].append({"ply": c["ply"], "rank": c["rank"], "crosses_boundary": c["crosses_boundary"],
                                "headline": e["headline"], "text": e["text"], "hung": [h["square"] for h in e["facts"]["hung_pieces"]],
                                "motif": e["facts"]["motif"], "missed_mate": e["facts"]["missed_mate"], "allowed_mate": e["facts"]["allowed_mate"]})
    return out


def random_line(rng: random.Random, board: chess.Board, n: int) -> list[str]:
    b = board.copy(stack=False)
    out = []
    for _ in range(n):
        legal = list(b.legal_moves)
        if not legal:
            break
        caps = [m for m in legal if b.is_capture(m)]
        m = rng.choice(caps if caps and rng.random() < 0.6 else legal)
        out.append(m.uci())
        b.push(m)
    return out


def random_eval(rng: random.Random) -> tuple:
    x = rng.random()
    if x < 0.04:
        return None, None
    if x < 0.16:
        return None, rng.choice([-12, -5, -3, -2, -1, 1, 1, 2, 3, 4, 9])
    return int(rng.gauss(0, 500)), None


def fuzz_rows(rng: random.Random, start: chess.Board, ucis: list[str], game_id: str) -> tuple[list[dict], dict]:
    """Positions along a move list with made-up but legal engine output, to reach every branch of classify/facts."""
    b = start.copy(stack=False)
    rows, multipv = [], {}
    clock = rng.choice([None, 600, 180, 60])
    for ply, u in enumerate([*ucis, None]):
        cp, mate = random_eval(rng)
        if b.is_checkmate():
            cp, mate = None, 0
        legal = list(b.legal_moves)
        best = None
        if legal:
            best = u if (u and rng.random() < 0.4) else rng.choice(legal).uci()
        pv = [best] + random_line(rng, _after(b, best), rng.randint(0, 8)) if best else []
        if pv and rng.random() < 0.05:
            pv.append("a1a2")                                       # an illegal tail: lines stop at it
        key = fen.fen_key(b.fen())
        if legal and rng.random() < 0.7:
            picks = rng.sample(legal, min(len(legal), rng.randint(1, 3)))
            ranks = []
            for i, m in enumerate(picks, start=1):
                rcp, rmate = random_eval(rng)
                if rcp is None and rmate is None:       # a MultiPV line always has a score
                    rcp = 0
                ranks.append({"fen_key": key, "rank": i, "move": m.uci(), "eval_cp": rcp, "mate_in": rmate,
                              "pv": [m.uci()] + random_line(rng, _after(b, m.uci()), rng.randint(0, 4))})
            rng.shuffle(ranks)
            multipv[key] = ranks
        if clock is not None and rng.random() < 0.9:
            clock = max(0, clock - rng.randint(0, 40) + rng.randint(0, 5))
        rows.append({"game_id": game_id, "ply": ply, "fen": b.fen(), "fen_key": key, "side_to_move": col(b.turn),
                     "move_played": u, "clock_remaining": None if clock is None or rng.random() < 0.05 else clock,
                     "eval_cp": cp, "mate_in": mate, "best_move": best, "pv": pv})
        if u:
            b.push_uci(u)
    return rows, multipv


def _after(board: chess.Board, u: str) -> chess.Board:
    b = board.copy(stack=False)
    b.push_uci(u)
    return b


def random_game(rng: random.Random, plies: int) -> list[str]:
    b = chess.Board()
    out = []
    for _ in range(plies):
        legal = list(b.legal_moves)
        if not legal or b.is_game_over():
            break
        caps = [m for m in legal if b.is_capture(m) or b.gives_check(m)]
        m = rng.choice(caps if caps and rng.random() < 0.4 else legal)
        out.append(m.uci())
        b.push(m)
    return out


def random_game_row(rng: random.Random, gid: str) -> dict:
    return {"game_id": gid, "my_colour": rng.choice(["white", "black"]),
            "my_rating": rng.choice([None, 450, 900, 1300, 1800, 2400, 3100]),
            "opponent_rating": rng.choice([None, 700, 1500, 2900]),
            "time_control": rng.choice([None, "600", "180+2", "60+1", "1/86400", "300+0"]),
            "opening_name": rng.choice([None, "Italian Game"])}


def games(eng, rec) -> tuple[list[dict], list[dict]]:
    """The game cases, and the engine searches they were made from."""
    game, positions = next(parse_pgn_text(FIXTURE.read_text(encoding="utf-8"), "testuser", "golden"))
    searches = []
    # 1. the golden chain: single-PV at GOLDEN_NODES, no MultiPV, exactly as tests/test_golden.py
    evals = {}
    for p in positions:
        key = fen.fen_key(p["fen"])
        if key not in evals:
            case = engine_case(eng, chess.Board(p["fen"]), None, GOLDEN_NODES, rec)
            evals[key] = case["main"]
            searches.append(case)
    rows = [{**p, "fen_key": fen.fen_key(p["fen"]), **evals[fen.fen_key(p["fen"])]} for p in positions]
    golden = game_case("golden", game, rows, {})
    expected = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert golden_view(golden) == expected, "the golden chain no longer matches tests/golden/clocks.json"
    cases = [golden]
    # 2. the same game with MultiPV, as the app analyses it
    evals, multipv = {}, {}
    for p in positions:
        key = fen.fen_key(p["fen"])
        if key not in evals:
            case = engine_case(eng, chess.Board(p["fen"]), 3, MULTIPV_NODES, rec)
            evals[key] = case["main"]
            multipv[key] = [{"fen_key": key, **r} for r in case["ranks"]]
            searches.append(case)
    rows = [{**p, "fen_key": fen.fen_key(p["fen"]), **evals[fen.fen_key(p["fen"])]} for p in positions]
    cases.append(game_case("golden-multipv", game, rows, multipv))
    # 3. made-up evals over the golden game and over random games, for the branches real games rarely reach
    rng = random.Random(SEED)
    ucis = [p["move_played"] for p in positions if p["move_played"]]
    for i in range(4):
        g = random_game_row(rng, f"fuzz-golden-{i}")
        rows, mpv = fuzz_rows(rng, chess.Board(), ucis, g["game_id"])
        cases.append(game_case(g["game_id"], g, rows, mpv))
    for i in range(N_RANDOM_GAMES):
        g = random_game_row(rng, f"fuzz-random-{i}")
        rows, mpv = fuzz_rows(rng, chess.Board(), random_game(rng, rng.randint(30, 160)), g["game_id"])
        cases.append(game_case(g["game_id"], g, rows, mpv))
    return cases, searches


def engine(eng, rec) -> list[dict]:
    cases = []
    for f in SPECIAL_FENS:
        for mpv in (None, 3):
            cases.append(engine_case(eng, chess.Board(f), mpv, MULTIPV_NODES, rec))
    for f, lines in SYNTHETIC_LINES:
        b = chess.Board(f)
        limit = chess.engine.Limit(nodes=1)
        main, ranks = evaluate_multipv(b, Replay(lines), limit, 3)
        cases.append({"fen": f, "multipv": 3, "lines": lines, "main": main, "ranks": ranks})
        cases.append({"fen": f, "multipv": None, "lines": lines, "main": evaluate(b, Replay(lines), limit)})
    return cases


# --- local data ----------------------------------------------------------------------------------------------

def local() -> None:
    from chess_review import profiles
    from chess_review.classify import load_multipv
    from chess_review.db import connect, dicts
    from chess_review.site import POSITIONS_SQL

    out = OUT / "local"
    out.mkdir(parents=True, exist_ok=True)
    # the opening book as the web build ships it (scripts/build_web.py), for js/core/book.js to load
    (out / "book_keys.txt").write_text("\n".join(sorted(book.load())), encoding="utf-8", newline="\n")
    for profile in profiles.list_profiles():
        if not profile.positions_parquet.exists():
            continue
        con = connect(profile)
        gs = {g["game_id"]: g for g in dicts(con.execute("SELECT * FROM games"))}
        rows = dicts(con.execute(POSITIONS_SQL.format(where="")))
        multipv = load_multipv(con)
        by_game: dict[str, list[dict]] = {}
        for r in rows:
            by_game.setdefault(r["game_id"], []).append(r)
        cases = [game_case(gid, gs[gid], grows, multipv) for gid, grows in by_game.items()]
        write(f"games-{profile.id}.json", cases, out)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--local", action="store_true", help="also dump every game in data/profiles to tests/parity/local/")
    args = p.parse_args(argv)
    if not STOCKFISH.exists() or not book.BOOK_DIR.exists():
        sys.exit("needs bin/stockfish and data/book (scripts/fetch_book.sh)")
    write("pure.json", pure())
    write("geometry.json", geometry())
    eng, rec = open_engine()
    try:
        game_cases, searches = games(eng, rec)
        write("games.json", game_cases)
        write("engine.json", engine(eng, rec) + searches)
    finally:
        eng.quit()
    if args.local:
        local()


if __name__ == "__main__":
    main()
