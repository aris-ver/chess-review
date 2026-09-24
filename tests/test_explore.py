import chess
import chess.engine

from chess_review.explore import Explorer, _after_from_line, _lines_rows


def _info(multipv, cp=None, mate=None, pv=()):
    score = chess.engine.PovScore(chess.engine.Mate(mate) if mate is not None else chess.engine.Cp(cp), chess.WHITE)
    return {"multipv": multipv, "score": score, "pv": [chess.Move.from_uci(u) for u in pv], "depth": 20}


def test_lines_rows_matches_evaluate_shape():
    lines = {2: _info(2, cp=10, pv=["d2d4", "d7d5"]), 1: _info(1, cp=35, pv=["e2e4", "e7e5", "g1f3"])}
    main, ranks = _lines_rows(lines, nodes=5_000_000)
    assert main == {"nodes": 5_000_000, "eval_cp": 35, "mate_in": None, "best_move": "e2e4", "pv": ["e2e4", "e7e5", "g1f3"]}
    assert [r["rank"] for r in ranks] == [1, 2]
    assert ranks[1] == {"rank": 2, "move": "d2d4", "eval_cp": 10, "mate_in": None, "pv": ["d2d4", "d7d5"]}


def test_after_from_line_flips_pov_and_drops_the_move():
    _, ranks = _lines_rows({1: _info(1, cp=35, pv=["e2e4", "e7e5", "g1f3"]), 2: _info(2, cp=-20, pv=["a2a4", "d7d5"])}, 1)
    assert _after_from_line(ranks, "a2a4", 7) == {"nodes": 7, "eval_cp": 20, "mate_in": None, "best_move": "d7d5", "pv": ["d7d5"]}
    assert _after_from_line(ranks, "e2e4", 7)["eval_cp"] == -35
    assert _after_from_line(ranks, "h2h4", 7) is None   # not a line the search showed: needs its own search


def test_after_from_line_mate_counts():
    _, ranks = _lines_rows({1: _info(1, mate=3, pv=["a1a8", "b8c7", "a8c8", "c7b6", "c8b8"]),
                            2: _info(2, mate=-2, pv=["a1a2", "h8h1"])}, 1)
    assert _after_from_line(ranks, "a1a8", 1)["mate_in"] == -2      # the opponent is mated in 2 more
    assert _after_from_line(ranks, "a1a2", 1)["mate_in"] == 2       # the opponent now mates in 2
    _, ranks = _lines_rows({1: _info(1, mate=1, pv=["d1h5"])}, 1)
    assert _after_from_line(ranks, "d1h5", 1) == {"nodes": 1, "eval_cp": None, "mate_in": 0, "best_move": None, "pv": []}   # checkmated


# --- the move the coach names at the end of a variation ---
# A quiet middlegame, so nothing here depends on the opening book.
MIDDLEGAME = "r2q1rk1/pp2bppp/2n1bn2/2pp4/3P4/2N1PN2/PPQ1BPPP/R1B2RK1 w - - 0 11"
PLAYED = "d4c5"


def _replies():
    """Two legal replies to PLAYED: one to put in the previous search's pv, one for the new position's own."""
    b = chess.Board(MIDDLEGAME)
    b.push(chess.Move.from_uci(PLAYED))
    return sorted(m.uci() for m in b.legal_moves)[:2]


def _explored(before_pv, own_best, own_cp=-40):
    """Explorer.move() with the engine stubbed out: `before_pv` is the line the previous search had for the
    move played, `own_best` what a search of the position it reaches actually finds."""
    board = chess.Board(MIDDLEGAME)
    before = _lines_rows({1: _info(1, cp=40, pv=before_pv)}, 1_000)
    own = _lines_rows({1: _info(1, cp=own_cp, pv=[own_best])}, 1_000)
    ex = Explorer()
    ex.evaluate = lambda b: before if b.fen() == board.fen() else own
    return ex.move(MIDDLEGAME, PLAYED, "white")


def test_next_best_is_searched_not_read_off_the_previous_pv():
    """The arrow at the end of a variation is the engine's move in the position the variation reached. Taken
    from the tail of the previous search's line it is a weaker opinion -- below rank 1 it is often simply a
    different move -- so the new position is searched for it."""
    tail, own = _replies()
    d = _explored([PLAYED, tail], own)
    assert d["next_best_uci"] == own
    board = chess.Board(MIDDLEGAME)
    board.push(chess.Move.from_uci(PLAYED))
    assert d["next_best_san"] == board.san(chess.Move.from_uci(own))   # the bubble agrees with the arrow


def test_a_pv_that_stops_at_the_move_still_names_a_reply():
    """A line whose pv is just the move itself left no tail at all, and the end of the variation drew no
    arrow and named no move."""
    _, own = _replies()
    d = _explored([PLAYED], own)
    assert d["next_best_uci"] == own


def test_the_grade_still_comes_from_the_line_the_user_was_looking_at():
    """Only the continuation is re-searched: what the move scores stays the number the arrows were drawn
    from, so a move cannot come back graded against a different opinion than the one on screen."""
    tail, own = _replies()
    a = _explored([PLAYED, tail], own, own_cp=-40)
    b = _explored([PLAYED, tail], own, own_cp=900)      # a wildly different opinion of the new position
    for k in ("eval", "wp_white", "wp_loss", "label", "best_uci"):
        assert a[k] == b[k], k
