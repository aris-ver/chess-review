import chess

from chess_review.facts import extract, hung_pieces, idea_arrows, material_swing, motif, see


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


# --- idea arrows: what a good move does ---------------------------------------

def _idea(fen, uci, pv=()):
    return idea_arrows(chess.Board(fen), chess.Move.from_uci(uci), list(pv))


def test_idea_fork_shows_both_prongs():
    # screenshot: ...Na6+ forks the king on c5 and the rook on b8
    b = chess.Board("1R4nk/2n3p1/7p/P1K1P2p/5B2/6P1/2P4P/8 b - - 0 1")
    assert sorted(_idea(b.fen(), "c7a6", ["c5d5"])) == ["a6b8", "a6c5"]


def test_idea_trade_shows_capture_and_recapture():
    # screenshot: Rd8+ Rxd8 Rxd8 -- the trade the check forces, not the check itself
    fen = "r6k/6p1/p2R1n1p/1p3B2/1n6/4P3/1PP3PP/1K1R4 w - - 0 1"
    assert _idea(fen, "d6d8", ["a8d8", "d1d8"]) == ["a8d8", "d1d8"]
    assert _idea(fen, "d6d8", ["a8d8", "h8h7"]) == ["a8d8"]      # the line takes but never takes back


def test_idea_attack_only_what_is_worth_taking():
    # Nc3 hits d5, a pawn defended by e6: nothing to draw. Bb5+ hits the king: an arrow.
    assert _idea("rnbqkbnr/ppp2ppp/4p3/3p4/3P4/4P3/PPP2PPP/RNBQKBNR w KQkq - 0 3", "b1c3", ["g8f6"]) == []
    assert _idea("rnbqkbnr/ppp2ppp/4pn2/3p4/3P4/2N1P3/PPP2PPP/R1BQKBNR w KQkq - 0 4", "f1b5", ["c7c6"]) == ["b5e8"]


def test_idea_castling_when_the_move_clears_the_way():
    fen = "rnbqk2r/pppp1ppp/5n2/2b1p3/4P3/5N2/PPPPBPPP/RNBQK2R w KQkq - 0 4"
    assert _idea(fen, "e1g1", ["d7d6"]) == []                    # castling itself: nothing to prepare
    fen = "rnbqk2r/pppp1ppp/5n2/2b1p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 4"
    assert _idea(fen, "f1e2", ["d7d6", "e1g1"]) == ["e1g1"]      # Be2 clears f1: castling now possible


def test_idea_prepares_the_pawn_push_the_line_continues_with():
    # screenshot: 1.e3 e6 -- the engine's line goes 2.d4 d5, and e6 supports d5
    fen = "rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    assert _idea(fen, "e7e6", ["d2d4", "d7d5"]) == ["d7d5"]
    assert _idea(fen, "e7e6", ["d2d4", "g8f6"]) == []            # the line goes elsewhere: nothing drawn
    assert _idea(fen, "e7e6", ["d2d4", "a7a6"]) == []            # a push the move has nothing to do with
    # a capture the REPLY made possible is not something our move prepared: Qxf3 e6 dxe6 draws nothing
    fen = "r2qkb1r/ppp1pppp/2n5/3P4/2p1P3/2N2b2/PP3PPP/R1BQK2R w KQkq - 0 9"
    assert _idea(fen, "d1f3", ["e7e6", "d5e6"]) == []
    # a rook move that unblocks its pawn, and the line pushes it: drawn
    assert _idea("4k3/8/8/8/8/8/4P3/4KR2 w - - 0 1", "f1f4", ["e8d8", "e2e3"]) == []          # e3 was already possible
    assert _idea("4k3/8/8/8/8/4R3/4P3/4K3 w - - 0 1", "e3a3", ["e8d8", "e2e3"]) == ["e2e3"]   # the rook was in the way


def test_idea_only_for_good_labels():
    b = chess.Board("rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
    before = {"eval_cp": 0, "mate_in": None, "pv": ["e7e6"], "best_move": "e7e6"}
    after = {"eval_cp": 0, "mate_in": None, "pv": ["d2d4", "d7d5"]}
    row = {"game_id": "g", "ply": 1, "side_to_move": "black", "is_mine": True, "san": "e6", "best_san": "e6",
           "wp_before": 50.0, "wp_after": 50.0, "wp_loss": 0.0, "clock_remaining": None, "time_spent": None,
           "move_played": "e7e6", "label": "good"}
    assert extract(row, b, before, after).idea == ["d7d5"]
    assert extract({**row, "label": "inaccuracy"}, b, before, after).idea == []
