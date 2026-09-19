import chess

from chess_review.fen import board_from_key, fen_key


def test_strips_counters():
    assert fen_key("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1") == \
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"


def test_same_position_different_move_numbers_share_key():
    a = chess.Board("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3")
    b = chess.Board("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 6 9")
    assert fen_key(a.fen()) == fen_key(b.fen())


def test_ep_square_and_castling_preserved():
    assert fen_key("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3").endswith("KQkq d6")


def test_roundtrip():
    key = "4k3/8/8/8/8/8/8/4K2R w K -"
    assert fen_key(board_from_key(key).fen()) == key
