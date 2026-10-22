import random

import chess
import duckdb

from chess_review import analyse
from chess_review import own_puzzles as O
from chess_review.db import dicts
from chess_review.fen import fen_key

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


# ---------- the line: a stub engine and the extension rule ----------

START = chess.STARTING_FEN


def _key(*ucis, fen=START):
    b = chess.Board(fen)
    for u in ucis:
        b.push_uci(u)
    return fen_key(b.fen())


def _r(rank, move, cp, pv=None, mate=None):
    return {"rank": rank, "move": move, "eval_cp": cp, "mate_in": mate, "pv": pv or [move]}


# What the stub engine says, from the side to move. After 1.e4 (the setup), black's only good move is e5; after 2.Nf3
# Nc6 is the only good one again; after 3.Bb5 a6 and Nf6 are about as good, so the line stops before them.
ENGINE = {
    _key("e2e4"): [_r(1, "e7e5", 50, ["e7e5", "g1f3", "b8c6", "f1b5"]), _r(2, "c7c5", -300)],
    _key("e2e4", "e7e5", "g1f3"): [_r(1, "b8c6", 40, ["b8c6", "f1b5", "a7a6", "b5a4"]), _r(2, "d7d6", -400)],
    _key("e2e4", "e7e5", "g1f3", "b8c6", "f1b5"): [_r(1, "a7a6", 30, ["a7a6", "b5a4"]), _r(2, "g8f6", 20)],
}


def _board(*ucis):
    b = chess.Board()
    for u in ucis:
        b.push_uci(u)
    return b


def test_walk_follows_only_moves_and_ends_on_a_solver_move():
    waiting, solution, pv = O.walk(_board("e2e4"), "e7e5", ENGINE.get)
    assert waiting is None
    assert solution == ["e7e5", "g1f3", "b8c6"]                 # a6 had company: no reply dangling after Nc6
    assert pv == ["b8c6", "f1b5", "a7a6", "b5a4"]               # the engine's line from the last move of the solution


def test_walk_stops_at_once_when_the_second_move_has_company():
    engine = {**ENGINE, _key("e2e4", "e7e5", "g1f3"): [_r(1, "b8c6", 40, ["b8c6"]), _r(2, "d7d6", 0)]}
    assert O.walk(_board("e2e4"), "e7e5", engine.get) == (None, ["e7e5"], ["e7e5", "g1f3", "b8c6", "f1b5"])


def test_walk_waits_for_a_position_not_searched_yet():
    engine = {k: v for k, v in ENGINE.items() if k != _key("e2e4", "e7e5", "g1f3")}
    assert O.walk(_board("e2e4"), "e7e5", engine.get) == (_key("e2e4", "e7e5", "g1f3"), ["e7e5"], None)
    assert O.walk(_board("e2e4"), "e7e5", {}.get) == (_key("e2e4"), ["e7e5"], None)


def test_walk_keeps_the_games_move_when_the_cache_disagrees():
    assert O.walk(_board("e2e4"), "c7c5", ENGINE.get) == (None, ["c7c5"], None)


def test_walk_stops_on_mate_and_at_the_cap(monkeypatch):
    # 1.e4 e5 2.Bc4 Nc6 3.Qh5, setup 3...Nf6??: Qxf7 mates, nothing to search after it
    b = _board("e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6")
    engine = {fen_key(b.fen()): [_r(1, "h5f7", None, ["h5f7"], mate=1), _r(2, "c4f7", 100)]}
    assert O.walk(b, "h5f7", engine.get) == (None, ["h5f7"], ["h5f7"])
    # a6 the only move too: the line would go on (and wait for the position after 4.Ba4), but the cap ends it
    longer = {**ENGINE, _key("e2e4", "e7e5", "g1f3", "b8c6", "f1b5"): [_r(1, "a7a6", 30, ["a7a6", "b5a4"]), _r(2, "g8f6", -400)]}
    assert O.walk(_board("e2e4"), "e7e5", longer.get)[0] == _key("e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4")
    monkeypatch.setattr(O, "MAX_SOLVER_MOVES", 2)
    assert O.walk(_board("e2e4"), "e7e5", longer.get) == (None, ["e7e5", "g1f3", "b8c6"], ["b8c6", "f1b5", "a7a6", "b5a4"])


def test_settle_reads_the_cache_a_ply_at_a_time():
    asked = []

    def fetch(keys):
        asked.append(set(keys))
        return {k: ENGINE[k] for k in keys if k in ENGINE}

    out = O.settle([(_board("e2e4"), "e7e5"), (_board("e2e4"), "e7e5")], fetch)
    assert [s for _, s, _ in out] == [["e7e5", "g1f3", "b8c6"]] * 2
    assert [len(a) for a in asked] == [1, 1, 1]              # both puzzles share each round's query


def _candidate_db():
    """An in-memory stand-in for a profile's views plus the engine cache: one candidate (black missed 1...e5)."""
    con = duckdb.connect()
    con.execute(analyse.SCHEMA)
    con.execute("""CREATE TABLE moves AS SELECT 'g1' game_id, 2 ply, 'black' side_to_move, 'c5' san, 'e7e5' best_move,
                   'e5' best_san, 'mistake' AS label, 55.0 wp_before, 30.0 wp_after, true is_mine, false is_forced,
                   false in_book, true only_move, 25.0 wp_loss, 'c7c5' move_played""")
    after = _board("e2e4").fen()
    con.execute("CREATE TABLE positions (game_id TEXT, ply INT, fen TEXT, move_played TEXT, fen_key TEXT)")
    con.execute("INSERT INTO positions VALUES ('g1', 1, ?, 'e2e4', ?), ('g1', 2, ?, 'c7c5', ?)",
                [START, fen_key(START), after, fen_key(after)])
    con.execute("""CREATE TABLE games AS SELECT 'g1' game_id, 'someone' opponent, TIMESTAMP '2026-01-02 10:00' played_at,
                   'blitz' time_class, 'black' my_colour""")
    # what the game's own analysis left in the cache: the position the puzzle starts in
    analyse.write_results(con, [(_key("e2e4"), {"nodes": 1, "eval_cp": 50, "mate_in": None, "best_move": "e7e5",
                                                "pv": ENGINE[_key("e2e4")][0]["pv"]}, ENGINE[_key("e2e4")])])
    return con


def test_extend_searches_only_what_the_lines_wait_on_and_caches_it():
    con = _candidate_db()
    searched = []

    def search(keys):        # the stub engine: MultiPV rows straight from ENGINE, stored like analyse stores them
        searched.append(list(keys))
        analyse.write_results(con, [(k, {"nodes": 1, "eval_cp": ENGINE[k][0]["eval_cp"], "mate_in": None,
                                         "best_move": ENGINE[k][0]["move"], "pv": ENGINE[k][0]["pv"]}, ENGINE[k])
                                    for k in keys])

    progress = []
    stats = O.extend(con, search, on_progress=lambda d, t: progress.append((d, t)))
    assert searched == [[_key("e2e4", "e7e5", "g1f3")], [_key("e2e4", "e7e5", "g1f3", "b8c6", "f1b5")]]
    assert stats == {"puzzles": 1, "searched": 2, "waiting": 0, "lines": 1}
    assert progress[-1] == (1, 1)
    assert O.extend(con, search)["searched"] == 0               # settled once: nothing searched again
    assert len(searched) == 2

    # the puzzle the pool builds from it: setup, then e5 Nf3 Nc6, then the engine's line after Nc6
    class P:
        id = "x"
    r = dicts(con.execute(O.CANDIDATES_SQL))[0]
    walked = O.settle([O._start(r)], lambda keys: O.cached_lines(con, keys))[0]
    p = O._puzzle(P, r, walked)
    assert [m["san"] for m in p["moves"]] == ["e4", "e5", "Nf3", "Nc6"]
    assert [m["san"] for m in p["follow"]] == ["Bb5", "a6", "Ba4"]
    assert p["id"] == O.puzzle_id("g1", 2) and p["colour"] == "black"


def test_extend_stops_when_asked_and_unsettled_puzzles_stay_one_move():
    con = _candidate_db()
    stats = O.extend(con, lambda keys: None, should_stop=lambda: True)
    assert stats["waiting"] == 1 and stats["searched"] == 0
    r = dicts(con.execute(O.CANDIDATES_SQL))[0]
    walked = O.settle([O._start(r)], lambda keys: O.cached_lines(con, keys))[0]

    class P:
        id = "x"
    p = O._puzzle(P, r, walked)
    assert [m["san"] for m in p["moves"]] == ["e4", "e5"]
    assert [m["san"] for m in p["follow"]] == ["Nf3", "Nc6", "Bb5"]    # the game's own line, as before
