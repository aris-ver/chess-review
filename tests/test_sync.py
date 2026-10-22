"""Puzzle progress synced through a Blundr account (chess_review/sync.py): two browsers, each a DATA folder
written by the real puzzles/packs code, and an account that keeps lines the way the Worker does (worker/src/store.js:
a set per file, new lines at the end)."""

import json
from pathlib import Path

import pytest

from chess_review import packs, puzzles, sync

USER = "u-1"


class Account:
    """worker/src/store.js's applyProgress and progress, in memory."""

    def __init__(self):
        self.files: dict[str, list[str]] = {}

    def post(self, add: dict, remove: dict) -> dict:
        for f, lines in add.items():
            have = self.files.setdefault(f, [])
            have += [ln for ln in lines if ln not in have]
        for f, lines in remove.items():
            self.files[f] = [ln for ln in self.files.get(f, []) if ln not in lines]
        self.files = {f: v for f, v in self.files.items() if v}
        return json.loads(json.dumps(self.files))


def run(data: Path, account: Account, user: str = USER) -> dict:
    """chess_review/static/account.js's sync: delta, post, commit, again while the browser still has something the account lacks."""
    for _ in range(3):
        d = sync.delta(user, data)
        out = sync.commit(user, account.post(d["add"], d["remove"]), data)
        if not out["pending"]:
            return out
    raise AssertionError("sync did not settle")


def attempts(data: Path) -> Path:
    return data / "puzzle_attempts.jsonl"


def solve(data: Path, pid: str, rating: int, solved: bool = True, ts: int = 0, monkeypatch=None):
    if monkeypatch and ts:
        monkeypatch.setattr(puzzles.time, "time", lambda: ts)
    return puzzles.record(pid, rating, solved, ms=4000, path=attempts(data))


@pytest.fixture
def a(tmp_path):
    (tmp_path / "a").mkdir()
    return tmp_path / "a"


@pytest.fixture
def b(tmp_path):
    (tmp_path / "b").mkdir()
    return tmp_path / "b"


def test_only_puzzle_progress_leaves_the_browser(a):
    solve(a, "00008", 1500)
    packs.mark_solved("00008", path=a / "puzzle_solved.jsonl")
    (a / "evals.duckdb").write_bytes(b"\0" * 16)
    (a / "settings.json").write_text("{}")
    prof = a / "profiles" / "chesscom-me"
    prof.mkdir(parents=True)
    (prof / "meta.json").write_text('{"source": "chesscom", "username": "me"}')
    (prof / "games.parquet").write_bytes(b"PAR1")
    (prof / "puzzle_attempts.jsonl").write_text('{"id": "own:x", "ts": 5, "solved": false}\n')
    pasted = a / "profiles" / "pgn-pasted-games"
    pasted.mkdir()
    (pasted / "meta.json").write_text('{"source": "pgn", "username": "Pasted games"}')
    d = sync.delta(USER, a)
    assert sorted(d["add"]) == ["profiles.jsonl", "profiles/chesscom-me/puzzle_attempts.jsonl", "puzzle_attempts.jsonl",
                                "puzzle_solved.jsonl"]
    assert [json.loads(ln) for ln in d["add"]["profiles.jsonl"]] == [
        {"source": "chesscom", "username": "me", "added": None, "pinned": None}]     # no games, no pasted PGNs
    assert d["remove"] == {}


def test_guest_progress_is_uploaded_at_sign_up_and_reaches_another_browser(a, b, monkeypatch):
    acc = Account()
    solve(a, "00008", 1500, ts=100, monkeypatch=monkeypatch)
    solve(a, "0000D", 1700, solved=False, ts=200, monkeypatch=monkeypatch)
    run(a, acc)
    assert len(acc.files["puzzle_attempts.jsonl"]) == 2
    # b logs in, then solves one dated between a's two: both browsers end up with all three, in order
    run(b, acc)
    solve(b, "000aY", 1400, ts=150, monkeypatch=monkeypatch)
    run(b, acc)
    run(a, acc)
    for d in (a, b):
        rec = puzzles.attempts(attempts(d))
        assert [x["id"] for x in rec] == ["00008", "000aY", "0000D"]       # oldest first: the rating replays in order
    assert puzzles.stats(puzzles.attempts(attempts(a))) == puzzles.stats(puzzles.attempts(attempts(b)))


def test_a_puzzle_both_browsers_tried_counts_once(a, b, monkeypatch):
    acc = Account()
    solve(a, "00008", 1500, ts=100, monkeypatch=monkeypatch)
    run(a, acc)
    solve(b, "00008", 1500, solved=False, ts=300, monkeypatch=monkeypatch)   # b hadn't synced yet
    (a / "puzzle_daily.jsonl").write_text('{"date": "2026-10-21", "n": 1, "solved": true}\n')
    (b / "puzzle_daily.jsonl").write_text('{"date": "2026-10-21", "n": 1, "solved": false}\n')
    run(a, acc)
    run(b, acc)
    assert len(packs.daily_record(b / "puzzle_daily.jsonl")) == 1          # one result a day
    rec = puzzles.attempts(attempts(b))
    assert len(rec) == 1 and rec[0]["solved"] is True                      # the first try, from a
    assert acc.files["puzzle_attempts.jsonl"] == [json.dumps(rec[0])]        # and the account dropped the second


def test_a_rating_reset_carries_over(a, b, monkeypatch):
    acc = Account()
    solve(a, "00008", 1500, ts=100, monkeypatch=monkeypatch)
    solve(a, "0000D", 1700, ts=200, monkeypatch=monkeypatch)
    run(a, acc)
    run(b, acc)
    moved = puzzles.reset(attempts(a))
    run(a, acc)
    assert "puzzle_attempts.jsonl" not in acc.files and moved.name in acc.files
    run(b, acc)
    assert not attempts(b).exists()
    assert puzzles.stats(puzzles.attempts(attempts(b)))["played"] == 0
    assert puzzles.tried(attempts(b)) == {"00008", "0000D"}               # still kept out of the deal
    assert packs.first_tries(attempts(b)) == {"00008": True, "0000D": True}


def test_a_review_schedule_syncs_per_profile(a, b):
    acc = Account()
    f = "profiles/chesscom-me/puzzle_attempts.jsonl"
    (a / f).parent.mkdir(parents=True)
    (a / f).write_text('{"id": "own:g:31", "ts": 100, "solved": false}\n{"id": "own:g:31", "ts": 90000, "solved": true}\n')
    run(a, acc)
    run(b, acc)
    assert (b / f).read_text() == (a / f).read_text()                   # repeats of a puzzle are the schedule: all kept


def test_progress_made_during_a_sync_is_kept_and_sent_next(a, monkeypatch):
    acc = Account()
    solve(a, "00008", 1500, ts=100, monkeypatch=monkeypatch)
    d = sync.delta(USER, a)
    theirs = acc.post(d["add"], d["remove"])
    solve(a, "0000D", 1700, ts=200, monkeypatch=monkeypatch)                # while the request was out
    out = sync.commit(USER, theirs, a)
    assert out["pending"]
    assert [x["id"] for x in puzzles.attempts(attempts(a))] == ["00008", "0000D"]
    run(a, acc)
    assert len(acc.files["puzzle_attempts.jsonl"]) == 2


def ids(data: Path) -> list[str]:
    return [x["id"] for x in puzzles.attempts(attempts(data))]


def test_a_new_account_takes_the_guests_data_only_when_asked(a, b, monkeypatch):
    for d, keep in ((a, True), (b, False)):
        solve(d, "00008", 1500, ts=100, monkeypatch=monkeypatch)
        add_profile(d, "lichess", "thibault")
        assert sync.guest_data(d) == {"puzzle_records": 1, "profiles": 1}
        acc = Account()
        assert sync.switch(USER, keep=keep, data=d) == ({"switched": False, "kept": True} if keep else {"switched": True})
        run(d, acc)
        if keep:
            assert ids(d) == ["00008"] and len(acc.files["profiles.jsonl"]) == 1
        else:
            assert acc.files == {} and ids(d) == [] and not (d / "profiles" / "lichess-thibault").exists()


def test_an_existing_account_never_gets_the_guests_data(a, b, monkeypatch):
    acc = Account()
    solve(a, "00008", 1500, ts=100, monkeypatch=monkeypatch)
    run(a, acc)                                          # the account, made elsewhere
    solve(b, "0000D", 1700, ts=200, monkeypatch=monkeypatch)
    add_profile(b, "lichess", "thibault")               # b, a guest so far
    sync.switch(USER, data=b)
    run(b, acc)
    assert ids(b) == ["00008"] and not (b / "profiles" / "lichess-thibault").exists()
    assert acc.files == {"puzzle_attempts.jsonl": [json.dumps(puzzles.attempts(attempts(a))[0])]}
    # logging out brings the guest's back, and sets the account's copy aside for next time
    solve(b, "000aY", 1400, ts=300, monkeypatch=monkeypatch)
    sync.switch(None, data=b)
    assert ids(b) == ["0000D"] and (b / "profiles" / "lichess-thibault" / "site" / "games.json").exists()
    assert sync.owner(b) is None
    sync.switch(USER, data=b)
    assert ids(b) == ["00008", "000aY"] and sync.owner(b) == USER
    run(b, acc)
    assert len(acc.files["puzzle_attempts.jsonl"]) == 2


def test_the_accounts_reviews_wait_for_it_in_the_browser(a, monkeypatch):
    acc = Account()
    sync.switch(USER, keep=True, data=a)
    add_profile(a, "lichess", "thibault")
    run(a, acc)
    sync.switch(None, data=a)
    assert not (a / "profiles" / "lichess-thibault").exists()
    sync.switch(USER, data=a)
    assert (a / "profiles" / "lichess-thibault" / "site" / "games.json").exists()    # reviews made while signed in


def test_two_accounts_on_one_browser_stay_apart(a, monkeypatch):
    acc1, acc2 = Account(), Account()
    sync.switch("u-1", keep=True, data=a)
    solve(a, "00008", 1500, ts=100, monkeypatch=monkeypatch)
    run(a, acc1, user="u-1")
    sync.switch("u-2", data=a)                           # another account logs in without logging out first
    run(a, acc2, user="u-2")
    assert ids(a) == [] and acc2.files == {}
    sync.switch("u-1", data=a)
    assert ids(a) == ["00008"]


def test_logging_out_on_a_shared_computer_removes_the_accounts_data(a, monkeypatch):
    acc = Account()
    sync.switch(USER, keep=True, data=a)
    solve(a, "00008", 1500, ts=100, monkeypatch=monkeypatch)
    add_profile(a, "lichess", "thibault")
    (a / "evals.duckdb").write_bytes(b"\0")
    run(a, acc)
    sync.switch(None, wipe=True, data=a)
    sync.switch(USER, data=a)
    assert ids(a) == [] and not (a / "profiles" / "lichess-thibault").exists()   # nothing set aside
    assert (a / "evals.duckdb").exists()                                           # the shared eval cache stays


def test_a_deleted_accounts_copy_becomes_the_guests(a, monkeypatch):
    solve(a, "0000D", 1700, ts=200, monkeypatch=monkeypatch)       # the guest's
    sync.switch(USER, data=a)
    solve(a, "00008", 1500, ts=100, monkeypatch=monkeypatch)       # the account's
    run(a, Account())
    sync.release(data=a)
    assert sync.owner(a) is None and ids(a) == ["00008", "0000D"]           # both, oldest first
    assert not (a / sync.WORKSPACES / USER).exists()


def test_switching_waits_while_a_profile_is_busy(a, monkeypatch):
    add_profile(a, "lichess", "thibault")
    monkeypatch.setattr(sync, "_busy", lambda pid: True)
    assert sync.switch(USER, data=a) == {"busy": True}
    assert (a / "profiles" / "lichess-thibault").exists()


def test_a_line_cut_short_is_not_uploaded(a):
    attempts(a).write_text('{"id": "00008", "ts": 1, "solved": true, "rating": 1500}\n{"id": "0000D", "ts"')
    assert sync.delta(USER, a)["add"] == {"puzzle_attempts.jsonl": ['{"id": "00008", "ts": 1, "solved": true, "rating": 1500}']}


def test_bridge_routes(a, monkeypatch):
    monkeypatch.setattr(sync, "DATA", a)
    monkeypatch.setattr(sync.delta, "__defaults__", (a,))
    monkeypatch.setattr(sync.commit, "__defaults__", (a,))
    for f in (sync.owner, sync.guest_data):
        monkeypatch.setattr(f, "__defaults__", (a,))
    monkeypatch.setattr(sync.switch, "__defaults__", (False, False, a))
    monkeypatch.setattr(sync.release, "__defaults__", (False, a))
    attempts(a).write_text('{"id": "00008", "ts": 1, "solved": true, "rating": 1500}\n')
    assert sync.handle("/api/sync/state", {}) == {"owner": None, "guest_data": {"puzzle_records": 1, "profiles": 0}}
    assert sync.handle("/api/sync/switch", {"user": USER, "keep": True}) == {"switched": False, "kept": True}
    assert sync.handle("/api/sync/delta", {"user": USER})["add"]
    assert sync.handle("/api/sync/commit", {"user": USER, "files": {}}) == {"changed": [], "pending": True, "profiles_added": []}
    assert sync.handle("/api/sync/state", {}) == {"owner": USER, "guest_data": None}
    assert sync.handle("/api/sync/delta", {}) is None
    assert sync.handle("/api/sync/switch", {}) == {"switched": True}
    assert sync.handle("/api/sync/release", {}) == {"released": True}
    with pytest.raises(ValueError):
        sync.handle("/api/sync/switch", {"user": "../x"})


# ---------- the profile list ----------

def add_profile(data: Path, source: str, username: str, pinned: str = None, games: bool = True) -> Path:
    pid = f"{source}-{username.lower()}"
    d = data / "profiles" / pid
    d.mkdir(parents=True, exist_ok=True)
    meta = {"source": source, "username": username, "created": "2026-10-01T10:00:00+00:00", "unseen": ["g1"]}
    if pinned:
        meta["pinned"] = pinned
    (d / "meta.json").write_text(json.dumps(meta))
    if games:
        (d / "site").mkdir(exist_ok=True)
        (d / "site" / "games.json").write_text('{"games": [{"id": "g1"}]}')     # reviews: never synced
    return d


def meta(data: Path, pid: str) -> dict:
    return json.loads((data / "profiles" / pid / "meta.json").read_text())


def test_profiles_follow_the_account_without_their_games(a, b):
    acc = Account()
    add_profile(a, "chesscom", "Hikaru", pinned="2026-10-02T09:00:00+00:00")
    add_profile(a, "lichess", "DrNykterstein")
    run(a, acc)
    add_profile(b, "chesscom", "MagnusCarlsen")          # b's own profile, from before logging in
    out = run(b, acc)
    assert sorted(p["username"] for p in sync.commit(USER, acc.files, b)["profiles_added"] + out["profiles_added"]) == \
        ["DrNykterstein", "Hikaru"]
    assert meta(b, "chesscom-hikaru") == {"source": "chesscom", "username": "Hikaru", "created": "2026-10-01T10:00:00+00:00",
                                          "pinned": "2026-10-02T09:00:00+00:00"}
    assert not (b / "profiles" / "chesscom-hikaru" / "site").exists()      # the page fetches the games afresh
    run(a, acc)
    assert sorted(p.name for p in (a / "profiles").iterdir()) == ["chesscom-hikaru", "chesscom-magnuscarlsen", "lichess-drnykterstein"]
    assert (a / "profiles" / "chesscom-hikaru" / "site" / "games.json").exists()    # a's own reviews untouched
    assert meta(a, "chesscom-hikaru")["unseen"] == ["g1"]                           # and its local-only state


def test_a_pin_and_a_removal_carry_over(a, b):
    acc = Account()
    add_profile(a, "chesscom", "Hikaru")
    add_profile(a, "lichess", "DrNykterstein")
    run(a, acc)
    run(b, acc)
    m = meta(a, "chesscom-hikaru")
    m["pinned"] = "2026-10-03T08:00:00+00:00"
    (a / "profiles" / "chesscom-hikaru" / "meta.json").write_text(json.dumps(m))
    import shutil
    shutil.rmtree(a / "profiles" / "lichess-drnykterstein")
    run(a, acc)
    assert len(acc.files["profiles.jsonl"]) == 1
    run(b, acc)
    assert meta(b, "chesscom-hikaru")["pinned"] == "2026-10-03T08:00:00+00:00"
    assert not (b / "profiles" / "lichess-drnykterstein").exists()
    # unpinning on b reaches a
    m = meta(b, "chesscom-hikaru")
    del m["pinned"]
    (b / "profiles" / "chesscom-hikaru" / "meta.json").write_text(json.dumps(m))
    run(b, acc)
    run(a, acc)
    assert "pinned" not in meta(a, "chesscom-hikaru")


def test_pinned_wins_when_two_browsers_disagree(a, b):
    acc = Account()
    add_profile(a, "chesscom", "Hikaru")
    run(a, acc)
    run(b, acc)
    m = meta(b, "chesscom-hikaru")
    m["pinned"] = "2026-10-04T08:00:00+00:00"
    (b / "profiles" / "chesscom-hikaru" / "meta.json").write_text(json.dumps(m))
    run(b, acc)
    acc.files["profiles.jsonl"].insert(0, sync.profile_line(meta(a, "chesscom-hikaru")))   # a's unpinned line came back
    run(a, acc)
    assert meta(a, "chesscom-hikaru")["pinned"] == "2026-10-04T08:00:00+00:00"
    assert len(acc.files["profiles.jsonl"]) == 1


def test_a_profile_line_this_app_cant_make_is_left_alone(a):
    acc = Account()
    acc.files["profiles.jsonl"] = ['{"source": "fide", "username": "x"}']
    out = run(a, acc)
    assert out["profiles_added"] == [] and not (a / "profiles").exists()
