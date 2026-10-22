import datetime as dt
import json
from collections import Counter

from chess_review import packs as K


from chess_review import puzzles

DEFS = [d for d in K.DEFS if d[0] in ("forks", "pins", "sacrifices", "mate-in-two")]


def row(i, rating, themes=("fork",), popularity=95, moves="a b c d e f"):
    return {"id": f"p{i:05d}", "rating": rating, "popularity": popularity, "plays": 1000, "themes": list(themes), "moves": moves}


def library_build(rows=None, daily=()):
    return K.build(rows or puzzles.Pack().rows(), DEFS, daily=list(daily))


def test_packs_are_exclusive_climb_and_keep_the_daily_list():
    lib = puzzles.Pack().rows()
    daily = [r["id"] for r in lib if "fork" in r["themes"]][:200]
    d = library_build(lib, daily)
    assert d["daily"] == daily                                             # kept as given, order and all
    ids = [i for p in d["packs"] for s in p["stages"] for i in s["ids"]]
    assert ids and len(ids) == len(set(ids)) and not set(ids) & set(daily)  # one pack each, none from the daily list
    by_id = {r["id"]: r for r in lib}
    assert len({K.game_of(by_id[i]) for i in ids}) == len(ids)             # one puzzle per game
    for p in d["packs"]:
        st = p["stages"]
        assert len(st) <= K.MAX_STAGES and all(len(s["ids"]) == K.STAGE_SIZE for s in st)
        for a, b in zip(st, st[1:]):
            assert b["lo"] >= a["lo"] + K.STEP // 2                        # a real climb from one stage to the next
            assert a["hi"] < b["lo"]
        for s in st:
            rs = [by_id[i]["rating"] for i in s["ids"]]
            assert rs == sorted(rs) and rs[-1] - rs[0] < K.STEP            # one band, easiest first


def test_a_stage_doesnt_repeat_itself():
    lib = puzzles.Pack().rows()
    by_id = {r["id"]: r for r in lib}
    for p in library_build(lib)["packs"]:
        want = set(p["themes"])
        for s in p["stages"]:
            fs = [K.features(by_id[i]) for i in s["ids"]]
            assert max(Counter(f["last"] for f in fs).values()) <= K.SAME_MOVE + 1
            assert max(Counter(f["first"] for f in fs).values()) <= K.SAME_MOVE + 1
            assert sum(f["one"] for f in fs) <= K.STAGE_SIZE * K.ONE_MOVE
            motifs = Counter(t for i in s["ids"] for t in by_id[i]["themes"] if t not in K.GENERIC and t not in want)
            assert not motifs or max(motifs.values()) <= K.STAGE_SIZE * K.MOTIF + 2   # a little slack where a band is thin


def test_the_build_is_deterministic():
    lib = puzzles.Pack().rows()
    assert library_build(lib) == library_build(list(reversed(lib)))


def test_daily_list_skips_easy_short_and_excluded_ones():
    rows = [row(i, 2000) for i in range(5)]
    rows += [row(10, 1500), row(11, 2100, moves="a b c d"), row(12, 2100, popularity=80)]
    assert sorted(K.daily_list(rows, exclude={"p00004"})) == [f"p{i:05d}" for i in range(4)]


def test_a_stage_opens_on_what_you_solved_elsewhere():
    pack = {"id": "f", "family": "M", "name": "F", "desc": "", "themes": ["fork"], "without": ["mateIn1"], "stages": [
        {"n": 1, "lo": 600, "hi": 790, "ids": [f"a{i}" for i in range(20)]},
        {"n": 2, "lo": 800, "hi": 990, "ids": [f"b{i}" for i in range(20)]},
        {"n": 3, "lo": 1000, "hi": 1190, "ids": [f"c{i}" for i in range(20)]}]}
    rows = {f"x{i}": {"rating": 650 + 10 * i, "themes": ["fork"]} for i in range(30)}   # old pack puzzles, 650..940
    rows["m"] = {"rating": 900, "themes": ["fork", "mateIn1"]}             # not this pack's kind
    first = {i: True for i in rows}
    got = K.credit(pack, first, set(), rows.get)
    assert len(got) == 30
    lad = K.ladder(pack, first, set(), {"played": 0}, solved=got)
    assert [s["open"] for s in lad["stages"]] == [True, True, False]       # 30 at 600+ open stage 2; only 15 at 800+
    first.update({f"y{i}": True for i in range(2)})
    rows.update({f"y{i}": {"rating": 820, "themes": ["fork"]} for i in range(2)})
    lad = K.ladder(pack, first, set(), {"played": 0}, solved=K.credit(pack, first, set(), rows.get))
    assert [s["open"] for s in lad["stages"]] == [True, True, True]


def test_states_unlocks_and_the_pass_mark():
    pack = {"id": "f", "family": "M", "name": "F", "desc": "", "stages": [
        {"n": 1, "lo": 600, "hi": 699, "ids": [f"a{i}" for i in range(30)]},
        {"n": 2, "lo": 700, "hi": 799, "ids": [f"b{i}" for i in range(30)]},
        {"n": 3, "lo": 800, "hi": 899, "ids": [f"c{i}" for i in range(30)]}]}
    first = {f"a{i}": i < 20 for i in range(24)}                           # 20 clean, 4 missed at first
    later = {"a20", "a21", "a22", "a23"}                                   # ... and solved since
    lad = K.ladder(pack, first, later, {"played": 0})
    s1, s2, s3 = lad["stages"]
    assert (s1["solved"], s1["clean"], s1["need"]) == (24, 20, 24)
    assert s2["open"] and not s3["open"]
    assert K.state_of("a0", first, later) == "clean" and K.state_of("a20", first, later) == "solved"
    assert K.state_of("b0", {"b0": False}, set()) == "missed" and K.state_of("zz", first, later) == "new"
    assert lad["current"] == 1
    lad = K.ladder(pack, {}, set(), {"played": 25, "rating": 820})         # a rating with something behind it
    assert [s["open"] for s in lad["stages"]] == [True, True, True]
    lad = K.ladder(pack, {}, set(), {"played": 5, "rating": 820})          # not yet
    assert [s["open"] for s in lad["stages"]] == [True, False, False]


def test_first_tries_include_archived_records(tmp_path):
    att = tmp_path / "puzzle_attempts.jsonl"
    (tmp_path / "puzzle_attempts.reset-20260101-000000.jsonl").write_text(json.dumps({"id": "x", "solved": False}) + "\n")
    att.write_text(json.dumps({"id": "x", "solved": True}) + "\n" + json.dumps({"id": "y", "solved": True}) + "\n")
    assert K.first_tries(att) == {"x": False, "y": True}                   # the archived one was first


def test_daily_is_kept_once_and_streaks_count(tmp_path, monkeypatch):
    monkeypatch.setattr(K.INSTANCE, "_data", {"packs": [], "daily": ["d1", "d2", "d3"]})
    path = tmp_path / "daily.jsonl"
    day1 = K.DAILY_EPOCH
    assert K.daily_id(day1) == "d1" and K.daily_id(day1 + dt.timedelta(days=4)) == "d2"
    out = K.record_daily(day1, "d1", True, True, 4000, ["ok", "ok"], path)
    assert out["result"]["clean"] and out["n"] == 1 and out["streak"] == 1
    out = K.record_daily(day1, "d1", False, False, 9000, ["shown"], path)   # a second go changes nothing
    assert out["result"]["clean"]
    K.record_daily(day1 + dt.timedelta(days=1), "d2", True, False, 1, ["miss", "ok"], path)
    assert K.daily(day1 + dt.timedelta(days=2), path)["streak"] == 2         # today not played yet: still on
    assert K.daily(day1 + dt.timedelta(days=3), path)["streak"] == 0
    assert K.daily(day1 + dt.timedelta(days=3), path)["best_streak"] == 2
    out = K.record_daily(day1 + dt.timedelta(days=2), "wrong-id", True, True, 1, [], path)
    assert out["result"] is None                                           # only the day's own puzzle


def test_shipped_packs_are_consistent():
    d = json.loads(K.PACKS.read_text(encoding="utf-8"))
    assert d["packs"] and len(d["daily"]) > 365
    for p in d["packs"]:
        ids = [i for s in p["stages"] for i in s["ids"]]
        assert len(ids) == len(set(ids))
        assert all(len(s["ids"]) <= d["stage_size"] for s in p["stages"])
        los = [s["lo"] for s in p["stages"]]
        assert los == sorted(los)
    in_packs = [i for p in d["packs"] for s in p["stages"] for i in s["ids"]]
    assert len(in_packs) == len(set(in_packs))                             # no puzzle in two packs
    assert not set(in_packs).intersection(d["daily"])
    lib = {r["id"] for r in puzzles.Pack().rows()}
    assert all(i in lib for i in in_packs + d["daily"])                    # all of them playable
