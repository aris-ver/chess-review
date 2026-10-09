import chess
import pytest

from chess_review import book
from chess_review.classify import classify_game, grade_k, label_for, move_accuracy
from chess_review.config import GRADE_DEFAULT_RATING, GRADE_K_HIGH, GRADE_K_LOW, GRADE_RATING_HIGH, GRADE_RATING_LOW
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

    game = {"game_id": "g", "my_colour": "white", "time_control": "600+0", "my_rating": 800, "opponent_rating": 800}
    out = classify_game(game, rows)
    assert [m["san"] for m in out] == ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"]
    assert out[0]["label"] == "best" and out[1]["label"] == "best"
    assert out[2]["label"] == "best"                 # +30 -> +30: not the engine move, but it loses nothing
    assert out[4]["label"] == "good"                 # +30 -> -60 for white: 51.5% -> 47.0% on the grading curve
    assert out[4]["wp_loss"] == pytest.approx(8.3, abs=0.1)     # wp_* stay on the Lichess curve: 52.8% -> 44.5%
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
    rows.append(_pos(1, b, "f7f6", cp=-30, best="e7e5")); b.push_uci("f7f6")      # black blunders: -30 -> -600
    rows.append(_pos(2, b, "a2a3", cp=600, best="d2d4")); b.push_uci("a2a3")      # white gives most of it back
    rows.append(_pos(3, b, None, cp=-150))                                       # +600 -> +150: 77% -> 57% graded
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows)
    assert out[1]["label"] == "blunder"
    assert out[2]["label"] == "miss"


def _after_black_error(white_before: int, white_after: int) -> list[dict]:
    """1. e4 f6?? (black's error), 2. a3: white's eval before 2. a3 and after it, white POV."""
    b = chess.Board()
    rows = []
    rows.append(_pos(0, b, "e2e4", cp=30, best="e2e4")); b.push_uci("e2e4")
    rows.append(_pos(1, b, "f7f6", cp=-30, best="e7e5")); b.push_uci("f7f6")
    rows.append(_pos(2, b, "a2a3", cp=white_before, best="d2d4")); b.push_uci("a2a3")
    rows.append(_pos(3, b, None, cp=-white_after))
    return rows


@pytest.mark.parametrize("before, after, label", [
    (400, -60, "miss"),         # 81% -> 44%: the whole gift handed back and a bit more -- still a miss, as on chess.com
    (400, -900, "blunder"),     # 81% -> 3%: the move throws the game away, that is a blunder whatever came before
])
def test_miss_is_a_chance_not_punished(monkeypatch, before, after, label):
    monkeypatch.setattr(book, "is_book", lambda key: False)
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, _after_black_error(before, after))
    assert out[2]["label"] == label


def test_no_miss_without_a_chance(monkeypatch):
    """Black's error only took white from lost to bad (-800 -> -300, 25%): white had no win to miss."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board()
    rows = []
    rows.append(_pos(0, b, "e2e4", cp=-800, best="e2e4")); b.push_uci("e2e4")
    rows.append(_pos(1, b, "f7f6", cp=800, best="e7e5")); b.push_uci("f7f6")      # black: 95% -> 75%
    rows.append(_pos(2, b, "a2a3", cp=-300, best="d2d4")); b.push_uci("a2a3")
    rows.append(_pos(3, b, None, cp=500))                                        # white: 25% -> 14%
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows)
    assert out[1]["wp_loss"] > 10
    assert out[2]["label"] == "mistake"


def test_recapture_is_not_great(monkeypatch):
    """1. e4 d5 2. exd5 Qxd5: the only good move, but taking back is no find -> best."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board()
    rows = []
    for ply, uci, cp in ((0, "e2e4", 30), (1, "d7d5", -30), (2, "e4d5", 30), (3, "d8d5", -30)):
        rows.append(_pos(ply, b, uci, cp=cp, best=uci))
        if ply == 3:
            mpv = {fen_key(b.fen()): [{"rank": 1, "move": "d8d5", "eval_cp": -30, "mate_in": None},
                                      {"rank": 2, "move": "g8f6", "eval_cp": -400, "mate_in": None}]}
        b.push_uci(uci)
    rows.append(_pos(4, b, None, cp=30))
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows, mpv)
    assert out[3]["only_move"] is True
    assert out[3]["label"] == "best"


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
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None, "my_rating": 800}, rows)
    assert out[0]["wp_loss"] < 5 and out[0]["label"] == "blunder"
    # same eval drop but nothing hangs -> the win%-only label stands (+20 -> +9 is 98% -> 86% on the grading curve)
    rows[0]["move_played"] = "d2d3"
    b2 = b.copy(); b2.push_uci("d2d3"); rows[1] = _pos(1, b2, None, cp=-900)
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None, "my_rating": 800}, rows)
    assert out[0]["label"] == "mistake"


def test_giving_a_piece_away_when_already_lost(monkeypatch):
    """18...Rc4?? at -8 (arisgmn1 v maxamed-ibra): Stockfish's eval only goes -8.2 -> -9.5, under 2% of win chance,
    but the rook is simply taken and never won back -- a mistake, not "excellent"."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board("2r3k1/1p4pp/p3pb2/5p2/N7/4PN2/PP3PPP/1K3B1R b - - 2 18")
    best = ["c8c6", "f3d4", "c6d6", "f1e2", "f6d4", "e3d4", "d6d4", "a4c3"]   # Rc6 Nd4 Rd6 Be2 Bxd4 exd4 Rxd4 Nc3
    rows = [{**_pos(0, b, "c8c4", cp=-823, best="c8c6"), "pv": best}, None]
    b2 = b.copy(); b2.push_uci("c8c4")
    rows[1] = {**_pos(1, b2, None, cp=953), "pv": ["f1c4", "g8f7", "h1d1", "b7b5", "c4e6", "f7e6", "a4b6", "e6f7"]}
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None, "opponent_rating": 583}, rows)
    assert out[0]["wp_loss"] < 2 and out[0]["label"] == "mistake"
    # the same move when the engine's reply doesn't take the rook: the win%-only label stands (16% -> 13% graded)
    rows[1]["pv"] = ["g2g3", "c4c8"]
    out = classify_game({"game_id": "g", "my_colour": "white", "time_control": None, "opponent_rating": 583}, rows)
    assert out[0]["label"] == "good"


def test_grade_k_follows_rating():
    assert grade_k(500) == grade_k(GRADE_RATING_LOW) == pytest.approx(GRADE_K_LOW)
    assert grade_k(3400) == grade_k(GRADE_RATING_HIGH) == pytest.approx(GRADE_K_HIGH)
    mid = (GRADE_RATING_LOW + GRADE_RATING_HIGH) // 2
    assert grade_k(mid) == pytest.approx((GRADE_K_LOW * GRADE_K_HIGH) ** 0.5)       # log-linear between
    assert grade_k(None) == grade_k(GRADE_DEFAULT_RATING)


@pytest.mark.parametrize("rating, label", [(600, "good"), (3000, "inaccuracy")])
def test_same_slip_graded_by_rating(monkeypatch, rating, label):
    """+0.20 -> -0.20 at equality: nothing much at 600, an inaccuracy at 3000 (chess.com grades by the mover's rating)."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board()
    rows = [_pos(0, b, "a2a3", cp=20, best="e2e4"), None]
    b2 = b.copy(); b2.push_uci("a2a3"); rows[1] = _pos(1, b2, None, cp=20)
    game = {"game_id": "g", "my_colour": "black", "time_control": None, "my_rating": 1500, "opponent_rating": rating}
    assert classify_game(game, rows)[0]["label"] == label                    # white is the opponent here


def test_not_playing_mate_in_one_is_a_miss(monkeypatch):
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1")                  # Ra8# is on
    rows = [_pos(0, b, "a1a2", mate=1, best="a1a8"), None]
    b2 = b.copy(); b2.push_uci("a1a2"); rows[1] = _pos(1, b2, None, mate=-2)    # still mates, a move later
    assert classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows)[0]["label"] == "miss"


@pytest.mark.parametrize("before, mate_after, label", [
    ({"cp": -700}, 2, "mistake"),           # lost already, a short mate allowed
    ({"cp": -700}, 5, "inaccuracy"),        # ... a long one
    ({"mate": -5}, 1, "inaccuracy"),        # being mated in 5, walks into mate in 1
    ({"mate": -5}, 4, "excellent"),         # ... the mate just ticking down is no error
])
def test_mate_when_already_lost(monkeypatch, before, mate_after, label):
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board()
    rows = [_pos(0, b, "a2a3", best="e2e4", **before), None]
    b2 = b.copy(); b2.push_uci("a2a3"); rows[1] = _pos(1, b2, None, mate=mate_after)
    assert classify_game({"game_id": "g", "my_colour": "white", "time_control": None}, rows)[0]["label"] == label


@pytest.mark.parametrize("cp_before, label", [(-500, "mistake"), (500, "excellent")])
def test_losing_side_giving_material(monkeypatch, cp_before, label):
    """Black's king steps aside and the knight on d5 goes; the eval barely moves. Losing already, that is a mistake
    (chess.com); winning, it is giving material back to simplify, which chess.com lets be."""
    monkeypatch.setattr(book, "is_book", lambda key: False)
    b = chess.Board("4k3/8/8/3n4/8/8/8/3RK3 b - - 0 1")
    rows = [{**_pos(0, b, "e8e7", cp=cp_before, best="d5f6"), "pv": ["d5f6", "e1e2", "e8e7", "d1d2"]}, None]
    b2 = b.copy(); b2.push_uci("e8e7")
    rows[1] = {**_pos(1, b2, None, cp=-cp_before + 30), "pv": ["d1d5", "e7e6", "d5d4", "e6e5"]}
    game = {"game_id": "g", "my_colour": "black", "time_control": None, "my_rating": 800, "opponent_rating": 800}
    assert classify_game(game, rows)[0]["label"] == label
