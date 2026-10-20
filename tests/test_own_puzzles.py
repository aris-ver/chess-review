import random

from chess_review import own_puzzles as O

DAY = O.DAY


def _a(pid, ts, solved):
    return {"id": pid, "ts": ts, "solved": solved}


def test_schedule_comes_back_after_1_3_7_days_then_learned():
    rec = [_a("p", 0, False)]
    assert O.schedule(rec)["p"] == {"box": 0, "due": 1 * DAY, "learned": False}
    rec.append(_a("p", 1 * DAY, True))
    assert O.schedule(rec)["p"] == {"box": 1, "due": 4 * DAY, "learned": False}
    rec.append(_a("p", 4 * DAY, True))
    assert O.schedule(rec)["p"] == {"box": 2, "due": 11 * DAY, "learned": False}
    rec.append(_a("p", 11 * DAY, True))
    assert O.schedule(rec)["p"]["learned"]


def test_schedule_miss_starts_over_and_first_try_is_learned():
    rec = [_a("p", 0, False), _a("p", DAY, True), _a("p", 4 * DAY, False)]
    assert O.schedule(rec)["p"] == {"box": 0, "due": 5 * DAY, "learned": False}
    assert O.schedule([_a("q", 0, True)])["q"]["learned"]
    assert O.schedule([_a("q", 0, True), _a("q", DAY, False)])["q"]["box"] == 0   # learned, then missed: back it comes


def test_pick_due_reviews_first_then_new():
    puzzles = [{"id": i} for i in "abcd"]
    sched = O.schedule([_a("a", 0, False), _a("b", 10, False), _a("c", 0, True)])
    now = 2 * DAY
    assert O.pick(puzzles, sched, now=now)["id"] == "a"                  # waited longest
    assert O.pick(puzzles, sched, skip="a", now=now)["id"] == "b"
    assert O.pick(puzzles, sched, now=DAY / 2, rng=random.Random(0))["id"] == "d"   # nothing due: the one never seen
    assert O.pick(puzzles[:3], sched, now=DAY / 2) is None               # all caught up


def test_stats_counts_each_state():
    puzzles = [{"id": i} for i in "abcde"]
    sched = O.schedule([_a("a", 0, False), _a("b", 3 * DAY, False), _a("c", 0, True), _a("zz", 0, False)])
    st = O.stats(puzzles, sched, now=2 * DAY)
    assert st == {"total": 5, "new": 2, "due": 1, "learning": 1, "learned": 1, "next_due": 4 * DAY}   # zz: not a puzzle any more


def test_record_appends_every_showing(tmp_path, monkeypatch):
    class P:
        id, dir, moves_parquet = "x", tmp_path, tmp_path / "none.parquet"
    out = O.record(P, "m0123456789", solved=False)
    assert out["review"]["box"] == 0
    out = O.record(P, "m0123456789", solved=True, hinted=True)      # a hint is not a find
    assert out["review"]["box"] == 0
    assert len(O.attempts(O.attempts_path(P))) == 2


def test_follow_stops_at_an_illegal_move():
    fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    f = O._follow(fen, ["e2e4", "e7e5", "g1f3", "zzzz", "b8c6"])
    assert [m["san"] for m in f] == ["e5", "Nf3"]
    assert O._follow(fen, None) == []


def test_ids():
    pid = O.puzzle_id("https://www.chess.com/game/live/1", 42)
    assert O.is_own_id(pid) and not O.is_own_id("00sHx") and pid == O.puzzle_id("https://www.chess.com/game/live/1", 42)
