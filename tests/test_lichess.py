import json
from types import SimpleNamespace

import pytest

from chess_review import ingest, normalise, profiles

PGN = """[Event "rated blitz game"]
[Site "https://lichess.org/PndlSDZg"]
[UTCDate "2026.10.12"]
[UTCTime "14:04:47"]
[White "thibault"]
[Black "Pehachzed"]
[Result "0-1"]
[Variant "Standard"]
[TimeControl "300+3"]

1. f3 { [%clk 0:05:00] } 1... e5 { [%clk 0:05:00] } 2. g4 { [%clk 0:04:58] } 2... Qh4# { [%clk 0:04:59] } 0-1
"""


def game(gid="PndlSDZg", created=1791813887348, **kw):
    g = {"id": gid, "rated": True, "variant": "standard", "speed": "blitz", "createdAt": created,
         "status": "mate", "winner": "black",
         "players": {"white": {"user": {"name": "thibault", "id": "thibault"}, "rating": 1749, "ratingDiff": -5},
                     "black": {"user": {"name": "Pehachzed", "id": "pehachzed"}, "rating": 1800, "ratingDiff": 7}},
         "opening": {"eco": "C20", "name": "Barnes Opening: Fool's Mate"},
         "clock": {"initial": 300, "increment": 3}, "pgn": PGN}
    g.update(kw)
    return g


def test_parse_lichess_from_the_loser():
    row, pos = normalise.parse_lichess(game(), "Thibault")
    assert row["game_id"] == "https://lichess.org/PndlSDZg"
    assert (row["my_colour"], row["result"], row["time_class"], row["time_control"]) == ("white", "loss", "blitz", "300+3")
    assert (row["my_rating"], row["opponent_rating"]) == (1744, 1807)       # after the game, like chess.com
    assert row["termination"] == "Pehachzed won by checkmate"
    assert (row["eco"], row["opening_name"], row["opponent"]) == ("C20", "Barnes Opening: Fool's Mate", "Pehachzed")
    assert len(pos) == 5 and pos[1]["clock_remaining"] == 300 and pos[-1]["move_played"] is None


def test_parse_lichess_classes_and_draws():
    row, _ = normalise.parse_lichess(game(speed="ultraBullet", winner=None, status="stalemate"), "pehachzed")
    assert (row["my_colour"], row["result"], row["time_class"]) == ("black", "draw", "bullet")
    assert row["termination"] == "Game drawn by stalemate"
    row, _ = normalise.parse_lichess(game(speed="correspondence", clock=None, daysPerTurn=2), "thibault")
    assert (row["time_class"], row["time_control"]) == ("daily", "1/172800")
    ai = game(players={"white": {"user": {"name": "thibault", "id": "thibault"}, "rating": 1858}, "black": {"aiLevel": 3}})
    row, _ = normalise.parse_lichess(ai, "thibault")
    assert (row["opponent"], row["opponent_rating"]) == ("lichess AI level 3", None)


def test_parse_lichess_skips_what_it_cant_review():
    assert normalise.parse_lichess(game(variant="chess960"), "thibault") is None
    assert normalise.parse_lichess(game(status="aborted"), "thibault") is None
    assert normalise.parse_lichess(game(), "someone-else") is None


@pytest.fixture
def profile(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    return profiles.create("lichess", "thibault")


def _api(monkeypatch, games):
    """The export returns `games` from the `since` asked for; the user endpoint counts them."""
    asked = []

    def stream(_session, _username, params):
        asked.append(params)
        return iter([g for g in games if g["createdAt"] >= params.get("since", 0)])
    monkeypatch.setattr(ingest, "_lichess_stream", stream)
    monkeypatch.setattr(ingest.requests.Session, "get",
                        lambda self, url, **kw: SimpleNamespace(status_code=200, raise_for_status=lambda: None,
                                                                json=lambda: {"count": {"all": len(games)}}))
    return asked


def test_fetch_then_refresh_only_asks_for_newer_games(profile, monkeypatch):
    sep, oct1, oct2 = 1788000000000, 1791000000000, 1791813887348      # 2026-08-29, 2026-10-03, 2026-10-12
    games = [game("a", sep), game("b", oct1)]
    asked = _api(monkeypatch, games)
    assert ingest.fetch(profile)["fetched"] == 2
    assert sorted(f.name for f in profile.raw_dir.iterdir()) == ["2026-08.ndjson", "2026-10.ndjson"]

    games.append(game("c", oct2))
    assert ingest.count_new(profile) == 1
    assert ingest.fetch(profile, refresh=True) == {"fetched": 1, "skipped": 1}     # "b" comes back from `since`
    assert asked[-1]["since"] == oct1
    assert len((profile.raw_dir / "2026-10.ndjson").read_text().splitlines()) == 2
    assert ingest.count_new(profile) == 0

    stats = normalise.build(profile)
    assert stats["games"] == 3
