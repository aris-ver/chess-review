from pathlib import Path

from chess_review.normalise import parse_chesscom, parse_pgn_text

FIXTURE = Path(__file__).parent / "fixtures" / "clocks.pgn"


def test_pasted_pgn_parses_clocks_and_skips_variants():
    games = list(parse_pgn_text(FIXTURE.read_text(), "TestUser", "abc"))
    assert len(games) == 1  # chess960 game skipped
    row, pos = games[0]
    assert row["game_id"] == "https://www.chess.com/game/live/1"
    assert row["my_colour"] == "black"
    assert row["result"] == "loss"
    assert row["eco"] == "C41"
    assert row["opening_name"] == "Philidor Defense 3.d4 exd4"
    assert row["time_class"] == "blitz"
    assert row["my_rating"] == 1480 and row["opponent_rating"] == 1500
    assert row["played_at"].isoformat() == "2024-03-02T10:11:12"

    assert len(pos) == 14  # 13 moves + terminal row
    assert [p["ply"] for p in pos] == list(range(14))
    assert pos[0]["fen"].startswith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w")
    assert pos[0]["move_played"] == "e2e4" and pos[0]["clock_remaining"] == 180
    assert pos[1]["move_played"] == "e7e5" and pos[1]["clock_remaining"] == 180  # 179.5 rounds to 180
    assert pos[3]["clock_remaining"] == 170
    assert pos[8]["move_played"] == "c4f7"
    assert pos[13]["move_played"] is None and pos[13]["clock_remaining"] is None
    assert pos[13]["side_to_move"] == "black"
    assert all(p["side_to_move"] == ("white" if p["ply"] % 2 == 0 else "black") for p in pos)


def _chesscom_game(**over):
    g = {
        "url": "https://www.chess.com/game/live/99",
        "pgn": FIXTURE.read_text().split("\n\n[Event")[0],
        "time_control": "180+2",
        "end_time": 1709374272,
        "rules": "chess",
        "time_class": "blitz",
        "white": {"username": "Someone", "rating": 1500, "result": "win"},
        "black": {"username": "TestUser", "rating": 1480, "result": "checkmated"},
    }
    g.update(over)
    return g


def test_chesscom_json_result_mapping():
    row, pos = parse_chesscom(_chesscom_game(), "testuser")
    assert row["game_id"] == "https://www.chess.com/game/live/99"
    assert row["result"] == "loss" and row["my_colour"] == "black"
    assert row["termination"] == "someone won by checkmate"
    assert len(pos) == 14

    row, _ = parse_chesscom(_chesscom_game(white={"username": "Someone", "rating": 1500, "result": "repetition"},
                                          black={"username": "TestUser", "rating": 1480, "result": "repetition"}), "testuser")
    assert row["result"] == "draw"


def test_chesscom_json_skips_variants_and_strangers():
    assert parse_chesscom(_chesscom_game(rules="chess960"), "testuser") is None
    assert parse_chesscom(_chesscom_game(), "nobody") is None
