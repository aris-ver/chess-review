import datetime as dt
import json

from chess_review import packs as K


def row(i, rating, themes=("fork",), popularity=95, plays=1000, moves="a b c d e f"):
    return {"id": f"p{i:05d}", "rating": rating, "popularity": popularity, "plays": plays, "themes": list(themes), "moves": moves}


def test_stages_go_uphill_one_band_each_and_merge_thin_bands():
    rows = [row(i, 600 + i % 100) for i in range(40)]                      # 40 in the 600s
    rows += [row(100 + i, 700 + i) for i in range(10)]                     # only 10 in the 700s
    rows += [row(200 + i, 800 + i) for i in range(25)]                     # 25 in the 800s
    d = K.build(rows, [("forks", "Motifs", "Forks", "", ["fork"], None)], stage_size=30)
    st = d["packs"][0]["stages"]
    assert [len(s["ids"]) for s in st] == [30, 30]                         # 600s; 700s + 20 of the 800s (a band fills one stage at most)
    assert st[0]["hi"] < 700 and st[1]["lo"] >= 700
    ratings = {r["id"]: r["rating"] for r in rows}
    for s in st:
        rs = [ratings[i] for i in s["ids"]]
        assert rs == sorted(rs)                                            # numbered from the easiest


def test_most_popular_first_within_a_band_and_deterministic():
    rows = [row(i, 650, popularity=80 + i % 20) for i in range(60)]
    a = K.build(rows, [("f", "M", "F", "", ["fork"], None)], stage_size=30)
    b = K.build(list(reversed(rows)), [("f", "M", "F", "", ["fork"], None)], stage_size=30)
    assert a == b
    pops = {r["id"]: r["popularity"] for r in rows}
    assert min(pops[i] for i in a["packs"][0]["stages"][0]["ids"]) >= 90


def test_daily_avoids_pack_puzzles_and_easy_or_short_ones():
    rows = [row(i, 2000, themes=("fork",)) for i in range(5)]               # in the pack
    rows += [row(10 + i, 2000, themes=("quiet",)) for i in range(5)]        # daily material
    rows += [row(20, 1500, themes=("quiet",)), row(21, 2100, themes=("quiet",), moves="a b c d")]
    d = K.build(rows, [("f", "M", "F", "", ["fork"], None)], stage_size=5)
    assert sorted(d["daily"]) == [f"p{10 + i:05d}" for i in range(5)]


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
    in_packs = {i for p in d["packs"] for s in p["stages"] for i in s["ids"]}
    assert not in_packs.intersection(d["daily"])
