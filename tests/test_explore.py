import chess
import chess.engine

from chess_review.explore import _after_from_line, _lines_rows


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
