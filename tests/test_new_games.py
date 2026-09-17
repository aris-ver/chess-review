import json
from types import SimpleNamespace

import pytest

from chess_review import ingest, profiles


@pytest.fixture
def profile(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    monkeypatch.setattr(ingest.time, "sleep", lambda *_: None)
    p = profiles.Profile(id="chesscom-me", source="chesscom", username="me")
    p.raw_dir.mkdir(parents=True)
    return p


def _api(monkeypatch, months: dict):
    """months: {'2026-08': [urls...], ...}; the archive list is their sorted keys."""
    base = "https://api.chess.com/pub/player/me/games/"
    calls = []

    def get(_session, url):
        calls.append(url)
        if url.endswith("/archives"):
            return SimpleNamespace(json=lambda: {"archives": [base + k.replace("-", "/") for k in sorted(months)]})
        key = "-".join(url.rstrip("/").split("/")[-2:])
        return SimpleNamespace(json=lambda: {"games": [{"url": u} for u in months[key]]})
    monkeypatch.setattr(ingest, "_get", get)
    return calls


def _on_disk(profile, key, urls):
    (profile.raw_dir / f"{key}.json").write_text(json.dumps({"games": [{"url": u} for u in urls]}))


def test_new_games_in_the_latest_month(profile, monkeypatch):
    calls = _api(monkeypatch, {"2026-08": ["g1", "g2"], "2026-09": ["g3", "g4", "g5"]})
    _on_disk(profile, "2026-08", ["g1", "g2"])
    _on_disk(profile, "2026-09", ["g3"])
    assert ingest.count_new_games(profile) == 2
    assert len(calls) == 2        # the archive list and the latest month only: August is on disk, so not re-read


def test_a_whole_month_never_fetched_counts(profile, monkeypatch):
    _api(monkeypatch, {"2026-07": ["a"], "2026-08": ["b", "c"], "2026-09": ["d"]})
    _on_disk(profile, "2026-07", ["a"])
    assert ingest.count_new_games(profile) == 3      # September and August are both new


def test_nothing_new(profile, monkeypatch):
    _api(monkeypatch, {"2026-09": ["g1", "g2"]})
    _on_disk(profile, "2026-09", ["g1", "g2"])
    assert ingest.count_new_games(profile) == 0
    _api(monkeypatch, {})
    assert ingest.count_new_games(profile) == 0
