"""Stored evals are side-to-move POV. A position winning for white must be
positive with white to move and negative with black to move; to_white_pov must
make both positive."""

import chess
import chess.engine
import pytest

from chess_review.analyse import evaluate
from chess_review.config import STOCKFISH
from chess_review.pov import pov_win_pct, to_white_pov, win_pct

pytestmark = pytest.mark.skipif(not STOCKFISH.exists(), reason="stockfish binary missing")

# White up a full rook, no immediate tactics.
WHITE_UP_ROOK = "4k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R {stm} KQk - 0 1"


@pytest.fixture(scope="module")
def engine():
    eng = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH))
    eng.configure({"Threads": 1, "Hash": 16})
    yield eng
    eng.quit()


@pytest.mark.parametrize("stm,sign", [("w", 1), ("b", -1)])
def test_side_to_move_pov(engine, stm, sign):
    limit = chess.engine.Limit(nodes=200_000)
    r = evaluate(chess.Board(WHITE_UP_ROOK.format(stm=stm)), engine, limit)
    assert r["mate_in"] is None
    assert sign * r["eval_cp"] > 300
    cp, _ = to_white_pov(r["eval_cp"], r["mate_in"], "white" if stm == "w" else "black")
    assert cp > 300


def test_fixed_nodes_is_reproducible(engine):
    limit = chess.engine.Limit(nodes=100_000)
    board = chess.Board("r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4")
    a = evaluate(board, engine, limit)
    b = evaluate(board, engine, limit)
    assert (a["eval_cp"], a["mate_in"], a["best_move"]) == (b["eval_cp"], b["mate_in"], b["best_move"])


def test_terminal_positions_bypass_engine(engine):
    limit = chess.engine.Limit(nodes=1)
    mated = chess.Board("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")  # fool's mate
    r = evaluate(mated, engine, limit)
    assert r["mate_in"] == 0 and r["eval_cp"] is None
    assert pov_win_pct(r["eval_cp"], r["mate_in"], "white", "white") == 0.0
    assert pov_win_pct(r["eval_cp"], r["mate_in"], "white", "black") == 100.0


def test_win_pct_shape():
    assert win_pct(0) == 50
    assert abs(win_pct(100) + win_pct(-100) - 100) < 1e-9
    assert win_pct(1000) > 95
    assert pov_win_pct(-300, None, "black", "white") == win_pct(300)
    assert pov_win_pct(None, 3, "black", "white") == 0.0
