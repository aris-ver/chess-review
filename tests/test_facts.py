import chess

from chess_review.facts import extract, hung_pieces, material_swing, motif, see


def test_see_simple_exchanges():
    # Rook takes a pawn defended by a pawn: lose rook (500) for pawn (100) -> -400
    b = chess.Board("4k3/8/8/3p4/4p3/8/8/R3K3 w - - 0 1")
    b.set_piece_at(chess.A1, None); b.set_piece_at(chess.E1, chess.Piece(chess.KING, chess.WHITE))
    b.set_piece_at(chess.A4, chess.Piece(chess.ROOK, chess.WHITE))
    assert see(b, chess.Move.from_uci("a4e4")) == 100 - 500
    # same, but the pawn is undefended -> +100
    b.set_piece_at(chess.D5, None)
    assert see(b, chess.Move.from_uci("a4e4")) == 100


def test_see_recapture_chain():
    # QxN where N is defended once by a pawn and we attack twice (queen + rook): 300 - 900 + 100? no:
    # Q takes N (+300), pawn takes Q (-900), R takes pawn (+100): white would stop after N? swap-off says:
    # white shouldn't capture with the queen first -> value is 300 - 900 ... = -600 best line for white is not to recapture
    b = chess.Board("4k3/8/2p5/3n4/8/8/3Q4/3RK3 w - - 0 1")
    assert see(b, chess.Move.from_uci("d2d5")) == 300 - 900 + 100 or see(b, chess.Move.from_uci("d2d5")) < 0
    # rook on d1 x-rays through the queen; capture with the rook? not possible (queen blocks). Value must be negative.
    assert see(b, chess.Move.from_uci("d2d5")) < 0


def test_see_respects_pins():
    # Black knight on e5 attacked by white pawn d4; the black bishop on b8 "defends" e5 but the white queen
    # can't be a defender here... simpler: the defender is pinned to its king so the pawn wins the knight.
    b = chess.Board("4k3/8/8/4n3/3P4/8/8/4RK2 w - - 0 1")     # Ne5 defended by nothing: +300
    assert see(b, chess.Move.from_uci("d4e5")) == 300
    b = chess.Board("4k3/8/4r3/4n3/3P4/8/8/4RK2 w - - 0 1")    # Re6 defends e5, but is pinned by Re1 -> still +300
    assert see(b, chess.Move.from_uci("d4e5")) == 300


def test_hung_pieces_after_move():
    # Black to move; white queen on h5 attacked by the g6 pawn, undefended.
    b = chess.Board("rnbqkbnr/pppp1p1p/6p1/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 0 3")
    hung = hung_pieces(b, chess.WHITE)
    assert hung and hung[0]["piece"] == "queen" and hung[0]["square"] == "h5" and hung[0]["capture_san"] == "gxh5"
    # Nothing hangs in the start position after 1.e4
    b = chess.Board(); b.push_san("e4")
    assert hung_pieces(b, chess.WHITE) == []


def test_material_swing_over_pv():
    b = chess.Board("rnbqkbnr/pppp1p1p/6p1/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 0 3")
    assert material_swing(b, ["g6h5"], chess.WHITE) == -900
    assert material_swing(b, ["g6h5"], chess.BLACK) == 900


def test_motif_fork():
    # After 1...Kd8?? white plays Nxf7+ forking king d8 and rook h8: white knight on f7 -> fork
    b = chess.Board("r2k3r/pppq1ppp/8/4N3/8/8/PPPP1PPP/RNBQKB1R w KQ - 0 8")
    m, detail = motif(b, chess.Move.from_uci("e5f7"))
    assert m == "fork" and "king on d8" in detail and "rook on h8" in detail


def test_motif_pin():
    # is_pinned only sees pins to the king: after Rd1 the queen on d7 is pinned to the king on d8.
    b = chess.Board("3k4/3q4/8/8/8/8/5K2/5R2 w - - 0 1")
    m, detail = motif(b, chess.Move.from_uci("f1d1"))
    assert m == "pin" and "queen on d7" in detail


def test_motif_skewer():
    # Re8+ hits the king on c8 with the rook on a8 behind it on the same rank.
    b = chess.Board("r1k5/8/8/8/8/8/8/1K2R3 w - - 0 1")
    m, detail = motif(b, chess.Move.from_uci("e1e8"))
    assert m == "skewer" and "king on c8" in detail and "rook on a8" in detail
    # Same rook check with the pieces on opposite sides is a fork, not a skewer.
    b = chess.Board("k6r/8/8/8/8/8/8/K3R3 w - - 0 1")
    assert motif(b, chess.Move.from_uci("e1e8"))[0] == "fork"


def test_motif_discovered():
    # White bishop b2, white knight d4 in front on the long diagonal, black queen on g7. Nb5 discovers Bxg7.
    b = chess.Board("k7/6q1/8/8/3N4/8/1B6/K7 w - - 0 1")
    m, detail = motif(b, chess.Move.from_uci("d4b5"))
    assert m == "discovered" and "queen on g7" in detail


def _move(board, uci, **over):
    row = {"game_id": "g", "ply": 10, "side_to_move": "white" if board.turn else "black", "is_mine": True,
           "move_played": uci, "san": board.san(chess.Move.from_uci(uci)), "best_san": None, "label": "blunder",
           "wp_before": 60.0, "wp_after": 10.0, "wp_loss": 50.0, "is_forced": False, "in_book": False,
           "clock_remaining": 30, "time_spent": 4}
    row.update(over)
    return row


def test_extract_allowed_and_missed_mate():
    # White to move has Qxf7# (mate in 1). Playing Qh5-h4 instead misses it.
    b = chess.Board("r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4")
    before = {"eval_cp": None, "mate_in": 1, "best_move": "h5f7", "pv": ["h5f7"]}
    after = {"eval_cp": 150, "mate_in": None, "best_move": "g8f6", "pv": ["g8f6", "d2d3"]}   # black to move
    f = extract(_move(b, "h5h4", best_san="Qxf7#"), b, before, after)
    assert f.missed_mate == 1 and f.allowed_mate is None
    assert f.best_line == ["Qxf7#"]
    assert f.refutation == ["Nf6", "d3"]

    # Black to move, plays Nf6?? allowing Qxf7#.
    b = chess.Board("r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 4 4")
    before = {"eval_cp": -60, "mate_in": None, "best_move": "g7g6", "pv": ["g7g6", "h5f3"]}
    after = {"eval_cp": None, "mate_in": 1, "best_move": "h5f7", "pv": ["h5f7"]}
    f = extract(_move(b, "g8f6"), b, before, after)
    assert f.allowed_mate == 1 and f.missed_mate is None
    assert f.refutation == ["Qxf7#"]
    assert f.motif is None


def test_extract_only_move_from_multipv():
    b = chess.Board()
    before = {"eval_cp": 30, "mate_in": None, "best_move": "e2e4", "pv": ["e2e4"]}
    after = {"eval_cp": -20, "mate_in": None, "best_move": "e7e5", "pv": ["e7e5"]}
    mpv = [{"rank": 1, "move": "e2e4", "eval_cp": 500, "mate_in": None},
           {"rank": 2, "move": "d2d4", "eval_cp": 0, "mate_in": None}]
    f = extract(_move(b, "d2d4"), b, before, after, multipv=mpv)
    assert f.was_only_move is True
    f = extract(_move(b, "e2e4"), b, before, after, multipv=mpv)
    assert f.was_only_move is False       # played the only move
    f = extract(_move(b, "d2d4"), b, before, after, multipv=None)
    assert f.was_only_move is None
