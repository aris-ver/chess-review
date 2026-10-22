"""The app fetches a profile a page at a time, newest first: chess.com in whole months until a page's worth of
games, lichess PAGE games per request. "Older" fetches the page before the oldest on disk, a refresh only what's
newer, and a site's "slow down" is waited out with a note for the user."""

import json
from types import SimpleNamespace

import pytest

from chess_review import ingest, profiles

BASE = "https://api.chess.com/pub/player/me/games/"


@pytest.fixture
def chesscom(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    monkeypatch.setattr(ingest.time, "sleep", lambda *_: None)
    return profiles.create("chesscom", "me")


def _site(monkeypatch, months: dict, statuses=()):
    """chess.com with `months` {'2026-08': n games}; `statuses` are answered first (429s, say). Returns the URLs asked."""
    asked, statuses = [], list(statuses)

    def get(self, url, **_):
        asked.append(url)
        if statuses:
            status, headers = statuses.pop(0)
            return SimpleNamespace(status_code=status, headers=headers)
        if url.endswith("/archives"):
            body = {"archives": [BASE + k.replace("-", "/") for k in sorted(months)]}
        else:
            key = "-".join(url.rstrip("/").split("/")[-2:])
            body = {"games": [{"url": f"{key}/{i}"} for i in range(months[key])]}
        text = json.dumps(body)
        return SimpleNamespace(status_code=200, headers={}, text=text, json=lambda: json.loads(text),
                               raise_for_status=lambda: None)
    monkeypatch.setattr(ingest.requests.Session, "get", get)
    return asked


def _months(p):
    return sorted(f.stem for f in p.raw_dir.iterdir())


def test_chesscom_newest_months_first_until_a_page(chesscom, monkeypatch):
    asked = _site(monkeypatch, {"2026-06": 30, "2026-07": 12, "2026-08": 5, "2026-09": 8})
    stats = ingest.fetch(chesscom)
    assert _months(chesscom) == ["2026-07", "2026-08", "2026-09"]     # 8 + 5 + 12 >= 20: June waits
    assert stats["games"] == 25 and stats["older"] is True
    assert chesscom.summary()["older"] is True
    assert len(asked) == 4                                              # the list and three months

    stats = ingest.fetch(chesscom, older=True)
    assert _months(chesscom) == ["2026-06", "2026-07", "2026-08", "2026-09"]
    assert stats == {"listed": 4, "fetched": 1, "skipped": 0, "games": 30, "older": False}
    assert chesscom.summary()["older"] is False


def test_chesscom_first_fetch_cut_short_picks_up_where_it_stopped(chesscom, monkeypatch):
    _site(monkeypatch, {"2026-07": 15, "2026-08": 5, "2026-09": 8})
    chesscom.raw_dir.mkdir(parents=True)
    (chesscom.raw_dir / "2026-09.json").write_text(json.dumps({"games": [{"url": "x"}] * 8}))
    stats = ingest.fetch(chesscom)
    assert (stats["fetched"], stats["skipped"]) == (2, 1)
    assert stats["older"] is False


def test_chesscom_refresh_asks_only_for_the_newest_month_and_after(chesscom, monkeypatch):
    asked = _site(monkeypatch, {"2026-06": 30, "2026-07": 25, "2026-08": 5})
    ingest.fetch(chesscom)                          # August, then July: June stays on the site
    asked.clear()
    months = {"2026-06": 30, "2026-07": 25, "2026-08": 9, "2026-09": 2}
    _site(monkeypatch, months)
    ingest.fetch(chesscom, refresh=True)
    assert _months(chesscom) == ["2026-07", "2026-08", "2026-09"]       # never June
    assert json.loads((chesscom.raw_dir / "2026-08.json").read_text())["games"][-1]["url"] == "2026-08/8"


def test_chesscom_says_while_it_waits_out_a_429(chesscom, monkeypatch):
    _site(monkeypatch, {"2026-09": 3}, statuses=[(429, {}), (429, {"Retry-After": "7"})])
    notes = []
    ingest.fetch(chesscom, on_wait=notes.append)
    assert notes == ["chess.com asked to slow down: trying again in 2 s", None,
                     "chess.com asked to slow down: trying again in 7 s", None]


def test_chesscom_gives_up_after_too_many_429s(chesscom, monkeypatch):
    _site(monkeypatch, {"2026-09": 3}, statuses=[(429, {})] * 6)
    with pytest.raises(RuntimeError, match="kept asking to slow down"):
        ingest.fetch(chesscom)


@pytest.fixture
def lichess(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    monkeypatch.setattr(ingest.time, "sleep", lambda *_: None)
    return profiles.create("lichess", "me")


DAY = 86_400_000


def _lichess(monkeypatch, n: int, statuses=()):
    """lichess with n games, one a day; the export honours since/until/max/sort as lichess does."""
    games = [{"id": f"g{i:03}", "createdAt": 1780000000000 + i * DAY} for i in range(n)]
    asked, statuses = [], list(statuses)

    def get(self, url, params=None, stream=False, **_):
        if not stream:
            return SimpleNamespace(status_code=200, raise_for_status=lambda: None, json=lambda: {"count": {"all": n}})
        asked.append(dict(params))
        if statuses:
            return SimpleNamespace(status_code=statuses.pop(0), close=lambda: None, iter_lines=lambda: iter(()))
        out = [g for g in games if g["createdAt"] >= params.get("since", 0) and g["createdAt"] <= params.get("until", 1 << 60)]
        if params.get("sort") == "dateDesc":
            out.reverse()
        out = out[:params.get("max", len(out))]
        lines = [json.dumps(g).encode() for g in out]
        return SimpleNamespace(status_code=200, raise_for_status=lambda: None, close=lambda: None,
                               iter_lines=lambda: iter(lines))
    monkeypatch.setattr(ingest.requests.Session, "get", get)
    return games, asked


def _ids(p):
    return sorted(json.loads(line)["id"] for f in p.raw_dir.glob("*.ndjson") for line in f.read_text().splitlines())


def test_lichess_pages_back_from_the_newest(lichess, monkeypatch):
    games, asked = _lichess(monkeypatch, 45)
    assert ingest.fetch(lichess)["older"] is True
    assert _ids(lichess) == [f"g{i:03}" for i in range(25, 45)]
    assert asked[-1]["max"] == ingest.PAGE and asked[-1]["sort"] == "dateDesc" and "until" not in asked[-1]

    ingest.fetch(lichess, older=True)
    assert asked[-1]["until"] == games[25]["createdAt"] - 1
    assert _ids(lichess) == [f"g{i:03}" for i in range(5, 45)]
    assert lichess.summary()["older"] is True

    assert ingest.fetch(lichess, older=True) == {"fetched": 5, "skipped": 0, "older": False}
    assert len(_ids(lichess)) == 45
    assert lichess.summary()["older"] is False


def test_lichess_refresh_asks_only_for_newer_games(lichess, monkeypatch):
    games, asked = _lichess(monkeypatch, 30)
    ingest.fetch(lichess)
    assert ingest.fetch(lichess, refresh=True) == {"fetched": 0, "skipped": 1}     # the newest comes back from `since`
    assert asked[-1]["since"] == games[-1]["createdAt"] and "max" not in asked[-1]
    assert len(_ids(lichess)) == 20


def test_lichess_says_while_it_waits_out_a_429(lichess, monkeypatch):
    _lichess(monkeypatch, 3, statuses=[429])
    notes = []
    ingest.fetch(lichess, on_wait=notes.append)
    assert notes == ["lichess asked to slow down: trying again in a minute", None]
    assert len(_ids(lichess)) == 3
