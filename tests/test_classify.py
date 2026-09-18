import chess
import pytest

from chess_review import book
from chess_review.classify import classify_game, label_for, move_accuracy
from chess_review.fen import fen_key

pytestmark = pytest.mark.skipif(not book.BOOK_DIR.exists(), reason="opening book not fetched")


def test_thresholds():
    assert label_for(25) == "blunder"
    assert label_for(20) == "mistake"       # boundary: >20 is blunder
    assert label_for(12) == "mistake"
    assert label_for(7) == "inaccuracy"
    assert label_for(3) == "good"
    assert label_for(1) == "excellent"


def test_accuracy_curve():
    assert move_accuracy(0) == pytest.approx(100.0, abs=0.001)
    assert 60 < move_accuracy(10) < 70
    assert move_accuracy(80) == pytest.approx(0.0, abs=0.01)


def test_book_positions():
    b = chess.Board()
    for mv in ("e4", "e5", "Nf3", "Nc6", "Bb5"):
        b.push_san(mv)
    assert book.is_book(fen_key(b.fen()))
    b.push_san("a6"); b.push_san("Ba4"); b.push_san("h5")   # 4...h5 is nobody's theory
    assert not book.is_book(fen_key(b.fen()))


def _pos(ply, fen_board, move, cp=None, mate=None, best=None, clk=None):
    return {"game_id": "g", "ply": ply, "fen": fen_board.fen(), "side_to_move": "white" if fen_board.turn else "black",
            "move_played": move, "clock_remaining": clk, "eval_cp": cp, "mate_in": mate, "best_move": best}


def test_classify_game_synthetic(monkeypatch):
    """1. e4 e5 2. Bc4 Nc6 3. Qh5 (engine says -60 for white) Nf6?? 4. Qxf7#  -- book stubbed out."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board()
    rows = []
    # evals are side-to-move POV: +30 for white at ply 0 is -30 for black at ply 1, etc.
    rows.append(_pos(0, b, "e2e4", cp=30, best="e2e4", clk=600)); b.push_uci("e2e4")
    rows.append(_pos(1, b, "e7e5", cp=-30, best="e7e5", clk=598)); b.push_uci("e7e5")
    rows.append(_pos(2, b, "f1c4", cp=30, best="g1f3", clk=590)); b.push_uci("f1c4")
    rows.append(_pos(3, b, "b8c6", cp=-30, best="b8c6", clk=590)); b.push_uci("b8c6")
    rows.append(_pos(4, b, "d1h5", cp=30, best="g1f3", clk=580)); b.push_uci("d1h5")
    rows.append(_pos(5, b, "g8f6", cp=60, best="g7g6", clk=500)); b.push_uci("g8f6")     # black to move, +60 for black
    rows.append(_pos(6, b, "h5f7", mate=1, best="h5f7", clk=570)); b.push_uci("h5f7")     # white mates in 1
    rows.append(_pos(7, b, None, mate=0))                                                 # black checkmated

    game = {"game_id": "g", "my_colour": "white", "time_control": "600+0"}
    out = classify_game(game, rows)
    assert [m["san"] for m in out] == ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"]
    assert out[0]["label"] == "best" and out[1]["label"] == "best"
    assert out[2]["label"] == "excellent"            # +30 -> +30, not the engine move
    assert out[4]["label"] == "inaccuracy"           # +30 -> -60 for white: 52.8% -> 44.5%
    assert out[4]["wp_loss"] == pytest.approx(8.3, abs=0.1)
    assert out[5]["label"] == "blunder"              # +60 for black -> mated: 55.5% -> 0%
    assert out[5]["wp_after"] == 0.0
    assert out[6]["label"] == "best" and out[6]["wp_before"] == 100.0 and out[6]["wp_after"] == 100.0
    assert [m["is_mine"] for m in out] == [True, False, True, False, True, False, True]
    # time_spent from base 600: w 0, b 2, w 10, b 8, w 10, b 90, w 10
    assert [m["time_spent"] for m in out] == [0, 2, 10, 8, 10, 90, 10]


def test_forced_beats_thresholds():
    b = chess.Board("6k1/8/8/8/8/8/5P1P/r5K1 w - - 0 1")   # rook check on the back rank; Kg2 is the only move
    assert b.legal_moves.count() == 1
    rows = [_pos(0, b, "g1g2", mate=-3, best="g1g2"), None]
    b2 = b.copy(); b2.push_uci("g1g2")
    rows[1] = _pos(1, b2, None, mate=3)
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows)
    assert out[0]["is_forced"] and out[0]["label"] == "forced"
    assert out[0]["time_spent"] is None


def test_miss_after_opponent_error(monkeypatch):
    """Opponent blunders, I fail to punish with a mistake-range loss -> miss, not mistake."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board()
    rows = []
    rows.append(_pos(0, b, "e2e4", cp=30, best="e2e4")); b.push_uci("e2e4")
    rows.append(_pos(1, b, "f7f6", cp=-30, best="e7e5")); b.push_uci("f7f6")      # black blunders: -30 -> -400
    rows.append(_pos(2, b, "a2a3", cp=400, best="d2d4")); b.push_uci("a2a3")      # white gives most of it back
    rows.append(_pos(3, b, None, cp=-150))                                       # +400 -> +150: 81% -> 63%
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows)
    assert out[1]["label"] == "blunder"
    assert out[2]["label"] == "miss"


def test_great_needs_multipv(monkeypatch):
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board()
    rows = [_pos(0, b, "e2e4", cp=30, best="e2e4"), None]
    b2 = b.copy(); b2.push_uci("e2e4")
    rows[1] = _pos(1, b2, None, cp=-30)
    game = {"game_id": "g", "my_colour": "white", "time_control": None}
    assert classify_game(game, rows)[0]["label"] == "best"
    mpv = {fen_key(b.fen()): [{"rank": 1, "move": "e2e4", "eval_cp": 30, "mate_in": None},
                              {"rank": 2, "move": "d2d4", "eval_cp": -500, "mate_in": None}]}
    assert classify_game(game, rows, mpv)[0]["label"] == "great"


def test_brilliant_is_a_sound_sacrifice(monkeypatch):
    """Greek gift: Bxh7+ is the engine move, the bishop can be taken, position was roughly equal -> brilliant."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board("r1bq1rk1/ppp2ppp/2n1pn2/3p4/1bPP4/2NBPN2/PP3PPP/R2QK2R w KQ - 0 8")
    b = chess.Board("r1bq1rk1/pppn1ppp/4p3/3pP3/3P4/2NB4/PPP2PPP/R2QK1NR w KQ - 0 9")
    assert b.is_legal(chess.Move.from_uci("d3h7"))
    rows = [_pos(0, b, "d3h7", cp=80, best="d3h7"), None]
    b2 = b.copy(); b2.push_uci("d3h7")
    rows[1] = {**_pos(1, b2, None, cp=-90), "pv": ["g8h7", "d1h5", "h7g8", "g1f3", "f7f5", "f3g5"]}   # the bishop stays given
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows)
    assert out[0]["label"] == "brilliant"


def test_not_brilliant_when_the_line_wins_the_piece_back(monkeypatch):
    """...Bd4 offers the bishop to the c3 pawn, but cxd4 Nxd4 forks queen and bishop: a tactic that gets the
    material back, not a sacrifice."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board("r1bq1rk1/ppp2ppp/1bn5/P2np3/1P6/2PP1Q2/4B1PP/RNK4R b - - 0 12")
    assert b.is_legal(chess.Move.from_uci("b6d4"))
    rows = [_pos(0, b, "b6d4", cp=80, best="b6d4"), None]
    b2 = b.copy(); b2.push_uci("b6d4")
    rows[1] = {**_pos(1, b2, None, cp=-90), "pv": ["c3d4", "c6d4", "f3g3", "d4e2", "c1b1"]}   # cxd4 Nxd4 Qg3 Nxe2: a pawn up
    out = classify_game({"game_id": "g", "my_colour": "black", "time_control": None}, rows)
    assert out[0]["label"] == "best"
    rows[1]["pv"] = ["c3d4", "e5e4", "d3e4", "d5f4"]                                          # the bishop stays given: brilliant
    assert classify_game({"game_id": "g", "my_colour": "black", "time_control": None}, rows)[0]["label"] == "brilliant"


def test_material_floor_in_won_position(monkeypatch):
    """Hanging the queen at +9 barely moves win% but must still be a blunder."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board("3k4/4r3/8/8/8/8/3Q4/3K4 w - - 0 1")                    # black rook e7 eyes the e-file
    rows = [_pos(0, b, "d2e2", cp=2000, best="d2d5"), None]                  # +20 -> Qe2?? walks into Rxe2
    b2 = b.copy(); b2.push_uci("d2e2")
    rows[1] = _pos(1, b2, None, cp=-900)                                      # still +9 for white: win% 99.9 -> 96.6
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows)
    assert out[0]["wp_loss"] < 5 and out[0]["label"] == "blunder"
    # same tiny win% loss but nothing hangs -> the win%-only label stands
    rows[0]["move_played"] = "d2d3"
    b2 = b.copy(); b2.push_uci("d2d3"); rows[1] = _pos(1, b2, None, cp=-900)
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows)
    assert out[0]["label"] in ("excellent", "good")
