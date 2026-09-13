"""Golden-file test: the fixture game through the whole classification chain with a
real engine at a fixed node count. Regenerate with UPDATE_GOLDEN=1 after an
intentional change to thresholds, fact extraction or wording."""

import json
import os
from pathlib import Path

import chess
import chess.engine
import pytest

from chess_review import book, explain
from chess_review.analyse import evaluate
from chess_review.classify import classify_game
from chess_review.config import STOCKFISH
from chess_review.critical import select
from chess_review.facts import extract
from chess_review.fen import fen_key
from chess_review.normalise import parse_pgn_text

FIXTURE = Path(__file__).parent / "fixtures" / "clocks.pgn"
GOLDEN = Path(__file__).parent / "golden" / "clocks.json"
NODES = 200_000

pytestmark = pytest.mark.skipif(not STOCKFISH.exists() or not book.BOOK_DIR.exists(), reason="stockfish or book missing")


def run_chain() -> dict:
    game_row, positions = next(parse_pgn_text(FIXTURE.read_text(), "testuser", "golden"))
    eng = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH))
    eng.configure({"Threads": 1, "Hash": 16})
    limit = chess.engine.Limit(nodes=NODES)
    evals = {}
    try:
        for p in positions:
            key = fen_key(p["fen"])
            if key not in evals:
                evals[key] = evaluate(chess.Board(p["fen"]), eng, limit)
    finally:
        eng.quit()
    rows = [{**p, "fen_key": fen_key(p["fen"]), **evals[fen_key(p["fen"])]} for p in positions]
    moves = classify_game(game_row, rows)
    crit = select(moves)
    out = {"moves": [{k: m[k] for k in ("ply", "san", "label", "best_san")} | {"wp_loss": None if m["wp_loss"] is None else round(m["wp_loss"], 1)} for m in moves],
           "critical": []}
    by_ply = {m["ply"]: m for m in moves}
    for c in crit:
        before, after = rows[c["ply"]], rows[c["ply"] + 1]
        f = extract(by_ply[c["ply"]], chess.Board(before["fen"]), before, after)
        out["critical"].append({"ply": c["ply"], "rank": c["rank"], "crosses_boundary": c["crosses_boundary"],
                                "headline": explain.headline(f), "text": explain.explain(f),
                                "hung": [h["square"] for h in f.hung_pieces], "motif": f.motif,
                                "missed_mate": f.missed_mate, "allowed_mate": f.allowed_mate})
    return out


def test_golden_game():
    got = run_chain()
    if os.environ.get("UPDATE_GOLDEN"):
        GOLDEN.parent.mkdir(exist_ok=True)
        GOLDEN.write_text(json.dumps(got, indent=1), encoding="utf-8")
    expected = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert got == expected
