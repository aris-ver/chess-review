"""Parity dumps for the JavaScript port's puzzles (docs/js-port.md, round 2 `puzzles`): chess_review/puzzles.py,
packs.py and own_puzzles.py on recorded inputs, written to tests/parity/puzzles.json, which
js/server/puzzles.test.js replays on SQLite.

    python scripts/dump_puzzles_parity.py            library puzzles (a sample of the pack: line, themes, pick), the
                                                     rating over a recorded run of attempts with resets, the packs'
                                                     ladders and shelf, the daily pick over a range of dates and the
                                                     streak over a recorded run of days; own puzzles on the profiles of
                                                     tests/parity/storage.json (run dump_storage_parity.py first),
                                                     their lines extended by a made-up engine, and the review schedule
    python scripts/dump_puzzles_parity.py --local    also own puzzles on every profile in data/profiles with the real
                                                     engine cache, and the real records' stats, to
                                                     tests/parity/local/puzzles-<id>.json (gitignored)

Everything runs in a scratch data directory in UTC; data/ is only read (--local). --data points at another data
directory (e.g. the main checkout's from a worktree).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
import sys
import tempfile
import time as _time
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OUT = ROOT / "tests" / "parity"

_args = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
_args.add_argument("--local", action="store_true", help="also dump own puzzles of every profile in data/profiles to tests/parity/local/")
_args.add_argument("--data", type=Path, default=ROOT / "data", help="the data directory --local reads")
ARGS = _args.parse_args()
SOURCE = ARGS.data.resolve()
SCRATCH = Path(tempfile.mkdtemp(prefix="puzzles-parity-"))
os.environ["CHESS_REVIEW_DATA"] = str(SCRATCH)        # before chess_review is imported: every path it has goes here
os.environ["TZ"] = "UTC"                              # the archive's name is local time; the JS test runs in UTC too
_time.tzset()

import chess  # noqa: E402

from chess_review import analyse, classify, normalise, profiles  # noqa: E402
from chess_review import own_puzzles as O  # noqa: E402
from chess_review import packs as K  # noqa: E402
from chess_review import puzzles as P  # noqa: E402
from chess_review.db import base_views, connect, dicts, write_parquet  # noqa: E402
from chess_review.fen import board_from_key  # noqa: E402

NOW = 1_792_756_800       # 2026-10-23 12:00 UTC: the clock every record and schedule below runs on


class Clock:
    """time as the modules see it: time() and strftime() at a time the dump sets."""

    def __init__(self):
        self.now = NOW

    def time(self):
        return self.now

    def strftime(self, fmt, t=None):
        return _time.strftime(fmt, _time.gmtime(self.now if t is None else t))


CLOCK = Clock()
P.time = K.time = O.time = CLOCK


class First:
    """random.choice's stand-in: the first (or last) of the choices, which the JS gets with rng = () => 0 (or ~1)."""

    def __init__(self, last=False):
        self.last = last

    def choice(self, xs):
        return xs[-1] if self.last else xs[0]


def plain(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, (tuple, set, frozenset)):
        return sorted(v) if isinstance(v, (set, frozenset)) else list(v)
    return v


# ---------- library puzzles ----------

def library() -> dict:
    full = P.Pack()
    rows = full.rows()
    sample = rows[::100]
    mates, promos = [], []
    for r in rows:
        if len(mates) < 40 and "mate" in r["themes"] and P.line(r)["mates"]:
            mates.append(r)
        if len(promos) < 20 and any(len(u) == 5 for u in r["moves"].split()):
            promos.append(r)
    picked = {r["id"]: r for r in sample + mates + promos}
    raw = [{**r, "themes": " ".join(r["themes"])} for r in picked.values()]
    pack = P.Pack()
    pack._read = lambda: [dict(r) for r in raw]
    out = {"rows": raw, "lines": [P.line(r) for r in pack.rows()], "themes": pack.themes(),
           "theme_names": {t: P.theme_name(t) for t in sorted({t for r in rows for t in r["themes"]})}}
    out["glicko"] = [[r, rd, opp, s, list(P.glicko(r, rd, opp, s))]
                     for r in (800.0, 1500.0, 2210.5) for rd in (350.0, 120.0, 60.0) for opp in (600, 1500, 2600) for s in (0.0, 1.0)]

    # the rating over a recorded run: first tries, repeats (ignored), a reset (twice in one second), tries again
    rng = random.Random(7)
    path = P.ATTEMPTS
    ids = [r["id"] for r in pack.rows()]
    steps = []
    for i in range(160):
        CLOCK.now = NOW + 37 * i
        if i in (90, 91):
            if i == 91:     # something to move aside, then a second reset in the same second
                st = P.record(ids[0], 1500, True, 1000, False)
                steps.append({"op": "record", "id": ids[0], "rating": 1500, "solved": True, "ms": 1000, "hinted": False,
                              "now": CLOCK.now, "out": st})
            CLOCK.now = NOW + 37 * 90
            moved = P.reset()
            steps.append({"op": "reset", "now": CLOCK.now, "out": moved.name if moved else None,
                          "stats": P.stats(P.attempts())})
            continue
        pid = rng.choice(ids[:120]) if i % 9 else ids[i % 5]
        row = pack.get(pid)
        solved, hinted = rng.random() < 0.6, rng.random() < 0.1
        ms = None if i % 11 == 0 else rng.randrange(500, 90000)
        st = P.record(pid, row["rating"], solved, ms, hinted)
        steps.append({"op": "record", "id": pid, "rating": row["rating"], "solved": solved, "ms": ms, "hinted": hinted,
                      "now": CLOCK.now, "out": st})
    out["steps"] = steps
    out["attempts"] = P.attempts()
    out["stats"] = P.stats(P.attempts())
    out["tried"] = sorted(P.tried())
    # pick and next_puzzle with the choice made deterministic
    themes_sets = [None, {"fork"}, {"mateIn2", "pin"}, {"nonexistent"}, {"endgame"}]
    out["picks"] = []
    for themes in themes_sets:
        for rating in (400, 1500, 2900):
            for last in (False, True):
                exclude = set(ids[::3])
                p = P.pick(pack.rows(), rating, themes, exclude, First(last))
                out["picks"].append({"rating": rating, "themes": sorted(themes) if themes else None, "exclude": sorted(exclude),
                                     "last": last, "id": p["id"] if p else None})
    P.PACK_INSTANCE = pack
    out["next"] = []
    for themes in themes_sets[:3]:
        for skip in (None, ids[5]):
            rec = P.attempts()
            st = P.stats(rec)
            exclude = P.tried() | ({skip} if skip else set())
            p = P.pick(pack.rows(), st["rating"], themes, exclude, First())
            out["next"].append({"themes": sorted(themes) if themes else None, "skip": skip,
                                "out": [P.line(p) if p else None, st]})
    return out


# ---------- packs and the daily ----------

def packs_case(lib_pack_ids: list[str]) -> dict:
    data = K.INSTANCE.data()
    full = P.Pack()
    rng = random.Random(11)
    pack_ids = [i for p in data["packs"] for s in p["stages"] for i in s["ids"]]
    # a record of tries across packs and the library sample, a rating reset in the middle, some solved later
    attempts_path, solved_path = SCRATCH / "pk_attempts.jsonl", SCRATCH / "pk_solved.jsonl"
    ops = []        # what the JS replays: ["record", id, rating, solved, hinted, now] | ["reset", now] | ["solved", id, now]
    chosen = rng.sample(pack_ids, 500) + lib_pack_ids[:30]
    # most of the first stages of a few packs, so stages open by solving them
    for p in data["packs"][:6]:
        chosen += p["stages"][0]["ids"][:18] + p["stages"][1]["ids"][:10]
    for i, pid in enumerate(chosen):
        CLOCK.now = NOW + (i if i < 400 else 400)       # the last ones in one second: two resets share a name
        r = full.get(pid)
        if r is None:
            continue
        solved, hinted = rng.random() < 0.7, rng.random() < 0.05
        P.record(pid, r["rating"], solved, None, hinted, path=attempts_path)
        ops.append(["record", pid, r["rating"], solved, hinted, CLOCK.now])
        if i in (260, 450, 520):
            P.reset(attempts_path)
            ops.append(["reset", CLOCK.now])
    CLOCK.now = NOW + 1000
    first = K.first_tries(attempts_path)
    missed = [i for i, c in first.items() if not c]
    for pid in missed[::2] + missed[:3]:
        K.mark_solved(pid, solved_path)
        ops.append(["solved", pid, CLOCK.now])
    later_set = K.solved_later(solved_path)
    rows_of = {i: {"rating": full.get(i)["rating"], "themes": full.get(i)["themes"]} for i in set(pack_ids) | set(first)
               if full.get(i)}
    stats_list = [P.stats(P.attempts(attempts_path)), {"played": 25, "rating": 1800}, {"played": 5, "rating": 2400}, {}]
    out = {"ops": ops, "archives": sorted(f.name for f in SCRATCH.glob("pk_attempts.reset-*.jsonl")),
           "rows": rows_of, "first": [[k, v] for k, v in first.items()], "later": sorted(later_set), "stats": stats_list}
    out["shelf"] = [K.shelf(st, attempts_path, solved_path) for st in stats_list]
    out["ladders"] = []
    for p in data["packs"]:
        ratings = {i: (full.get(i) or {}).get("rating") for s in p["stages"] for i in s["ids"]}
        cr = K.credit(p, first, later_set, full.get)
        for st in stats_list[:2]:
            out["ladders"].append({"pack": p["id"], "credit": cr, "out": K.ladder(p, first, later_set, st, ratings, cr)})
    out["where"] = {i: K.where(i) for i in pack_ids[::97] + ["nope", data["daily"][0]]}

    # the daily: the pick over a range of dates, and a recorded run of days with the streak after each
    start = date(2026, 9, 1)
    days = [start + timedelta(days=n) for n in range(0, 120)] + [K.DAILY_EPOCH + timedelta(days=n) for n in range(2990, 3010)] \
        + [K.DAILY_EPOCH + timedelta(days=n) for n in range(0, 9000, 37)] + [date(2025, 1, 1), date(2030, 2, 28), date(2032, 2, 29)]
    out["daily_ids"] = [[d.isoformat(), K.day_number(d), K.daily_id(d)] for d in days]
    path = SCRATCH / "pk_daily.jsonl"
    run = []
    day = date(2026, 10, 18)
    for i in range(40):
        day += timedelta(days=1 if i % 6 else 2 if i % 12 else 3)
        today = day
        pid = K.daily_id(today) if i % 13 != 5 else "wrong"
        solved, clean = bool(rng.random() < 0.8), bool(rng.random() < 0.6)
        ms = None if i % 7 == 0 else rng.randrange(1000, 100000)
        marks = [f"m{j}" for j in range(i % 25)]
        res = K.record_daily(today, pid, solved, clean, ms, marks, path)
        run.append({"day": today.isoformat(), "id": pid, "solved": solved, "clean": clean, "ms": ms, "marks": marks, "out": res})
        if i % 4 == 0:      # a second report the same day: ignored
            res = K.record_daily(today, K.daily_id(today), not solved, True, 5, ["x"], path)
            run.append({"day": today.isoformat(), "id": K.daily_id(today), "solved": not solved, "clean": True, "ms": 5,
                        "marks": ["x"], "out": res})
    out["daily_run"] = run
    rec = K.daily_record(path)
    out["streaks"] = [[d.isoformat(), list(K.streaks(rec, d))] for d in (date(2026, 10, 1), day, day + timedelta(days=1),
                                                                         day + timedelta(days=2), day + timedelta(days=30))]
    return out




# ---------- own puzzles ----------

def synth(key: str) -> tuple[dict, list[dict]]:
    """A made-up engine, deterministic from the position: (main, ranks) as analyse.evaluate_multipv returns them.
    #1 and its line pick legal moves by the key's hash; #2 is close behind about one time in four (the line stops
    there), far behind otherwise (it goes on)."""
    b = board_from_key(key)
    h = int(hashlib.sha1(key.encode()).hexdigest()[:12], 16)
    moves = sorted(m.uci() for m in b.legal_moves)
    if not moves:
        return {"nodes": 1, "eval_cp": 0 if not b.is_checkmate() else None, "mate_in": 0 if b.is_checkmate() else None,
                "best_move": None, "pv": []}, []
    k = h % len(moves)
    rot = moves[k:] + moves[:k]
    pv, line_board = [rot[0]], b.copy(stack=False)
    line_board.push_uci(rot[0])
    for j in range(5):
        nxt = sorted(m.uci() for m in line_board.legal_moves)
        if not nxt:
            break
        u = nxt[(h >> (4 * j + 3)) % len(nxt)]
        pv.append(u)
        line_board.push_uci(u)
    cp1 = 150 + h % 100
    gap = 40 if (h >> 2) % 4 == 0 else 600
    ranks = [{"rank": 1, "move": rot[0], "eval_cp": cp1, "mate_in": None, "pv": pv}]
    if len(rot) > 1:
        ranks.append({"rank": 2, "move": rot[1], "eval_cp": cp1 - gap, "mate_in": None, "pv": [rot[1]]})
    if len(rot) > 2:
        ranks.append({"rank": 3, "move": rot[2], "eval_cp": cp1 - gap - 50, "mate_in": None, "pv": [rot[2]]})
    return {"nodes": 1, "eval_cp": cp1, "mate_in": None, "best_move": rot[0], "pv": pv}, ranks


def own_case(p, name: str, before_extend=None) -> dict:
    """Own puzzles of profile p (its parquet and the scratch cache in place): the candidates, the pool, then the
    lines extended by synth() and the pool again, and a review schedule over its puzzles. before_extend(case): what
    local() takes from the cache while it is still the real one."""
    O.POOL.invalidate(p.id)
    con = connect(p)
    candidates = [{k: plain(v) for k, v in r.items()} for r in dicts(con.execute(O.CANDIDATES_SQL))]
    con.close()
    case = {"name": name, "candidates": candidates, "before": O.POOL.puzzles(p), "waiting_before": O.POOL.waiting(p)}
    if before_extend:
        before_extend(case)
    con = analyse.open_db()
    base_views(con, p)
    rounds, engine, progress = [], {}, []

    def search(keys):
        rounds.append(list(keys))
        res = []
        for k in keys:
            main, ranks = synth(k)
            engine[k] = [main, ranks]
            res.append((k, main, ranks))
        analyse.write_results(con, res)

    case["extend"] = O.extend(con, search, on_progress=lambda d, t: progress.append([d, t]))
    con.close()
    case.update({"rounds": rounds, "engine": engine, "progress": progress})
    O.POOL.invalidate(p.id)
    case["after"] = O.POOL.puzzles(p)
    case["waiting_after"] = O.POOL.waiting(p)
    puzzles = case["after"]
    case["review"] = review(p, puzzles)
    return case


def review(p, puzzles: list[dict]) -> dict:
    """The schedule over a recorded run of showings: record(), stats and pick at several times, a reset."""
    rng = random.Random(3)
    ids = [z["id"] for z in puzzles]
    steps = []
    if not ids:
        ids = ["m0000000000"]
    for i in range(40):
        CLOCK.now = NOW + i * 7 * 3600
        pid = ids[rng.randrange(len(ids))] if i % 5 else ids[0]
        solved, hinted = rng.random() < 0.6, rng.random() < 0.1
        ms = None if i % 6 == 0 else rng.randrange(1000, 60000)
        res = O.record(p, pid, solved, ms, hinted)
        steps.append({"op": "record", "id": pid, "solved": solved, "ms": ms, "hinted": hinted, "now": CLOCK.now, "out": res})
        if i == 25:
            moved = O.reset(p)
            steps.append({"op": "reset", "now": CLOCK.now, "out": moved.name if moved else None})
    rec = O.attempts(O.attempts_path(p))
    sched = O.schedule(rec)
    checks = []
    for days in (0, 1, 2, 4, 8, 30):
        now = CLOCK.now + days * O.DAY
        for skip in (None, ids[0]):
            for last in (False, True):
                z = O.pick(puzzles, sched, skip, now, First(last))
                checks.append({"now": now, "skip": skip, "last": last, "id": z["id"] if z else None,
                               "stats": O.stats(puzzles, sched, now)})
    return {"steps": steps, "attempts": rec, "schedule": sched, "checks": checks}


def fixture_profiles() -> list[dict]:
    cases = json.loads((OUT / "storage.json").read_text(encoding="utf-8"))
    out = []
    for c in cases:
        for f in (analyse.EVALS_DB, analyse.EVALS_PARQUET):
            f.unlink(missing_ok=True)
        p = profiles.create(c["source"], c["username"])
        write_parquet(c["games"], normalise.GAMES_SCHEMA, p.games_parquet)
        write_parquet(c["positions"], normalise.POSITIONS_SCHEMA, p.positions_parquet)
        write_parquet(c["moves"], classify.MOVES_SCHEMA, p.moves_parquet)
        con = analyse.open_db()
        if c["cache"]["evals"]:
            con.executemany("INSERT INTO evals VALUES (?, ?, ?, ?, ?, ?)",
                            [[r[k] for k in ("fen_key", "nodes", "eval_cp", "mate_in", "best_move", "pv")] for r in c["cache"]["evals"]])
        if c["cache"]["multipv"]:
            con.executemany("INSERT INTO evals_multipv VALUES (?, ?, ?, ?, ?, ?)",
                            [[r[k] for k in ("fen_key", "rank", "move", "eval_cp", "mate_in", "pv")] for r in c["cache"]["multipv"]])
        if c["results"]:
            analyse.write_results(con, [tuple(r) for r in c["results"]])
        con.close()
        case = own_case(p, c["name"])
        print(f"own puzzles {c['name']}: {len(case['before'])} puzzles, {case['extend']}")
        out.append(case)
        shutil.rmtree(p.dir)
    return out


def local() -> None:
    out = OUT / "local"
    out.mkdir(parents=True, exist_ok=True)
    for f in (analyse.EVALS_DB, analyse.EVALS_PARQUET):
        f.unlink(missing_ok=True)
    shutil.copy(SOURCE / "evals.duckdb", analyse.EVALS_DB)
    fetched: set[str] = set()
    real_cached = O.cached_lines

    def logged(con, keys):
        keys = list(keys)
        fetched.update(keys)
        return real_cached(con, keys)

    O.cached_lines = logged
    for src in sorted((SOURCE / "profiles").iterdir()):
        if not (src / "moves.parquet").exists() or not (src / "meta.json").exists():
            continue
        m = json.loads((src / "meta.json").read_text(encoding="utf-8"))
        p = profiles.create(m["source"], m["username"])
        for f in ("games.parquet", "positions.parquet", "moves.parquet"):
            shutil.copy(src / f, p.dir / f)
        rec_src = src / "puzzle_attempts.jsonl"
        fetched.clear()

        def inputs(case, p=p):
            """What the JS needs to build the same pool: the games, the moves that might qualify and their positions
            (and the ones before), and the cache rows the pool read, as they were before the extension."""
            con = connect(p)
            rows = lambda sql, params=(): [{k: plain(v) for k, v in r.items()} for r in dicts(con.execute(sql, list(params)))]  # noqa: E731
            some = "SELECT (game_id, ply) FROM moves WHERE is_mine AND wp_loss >= 8"
            case["games"] = rows("SELECT * FROM games")
            case["positions"] = [{k: v for k, v in r.items() if k != "fen_key"} for r in rows(
                f"SELECT * FROM positions WHERE (game_id, ply) IN ({some}) OR (game_id, ply + 1) IN ({some})")]
            case["moves"] = rows("SELECT * FROM moves WHERE is_mine AND wp_loss >= 8")
            pos_keys = sorted({r["fen_key"] for r in rows(f"SELECT fen_key FROM positions WHERE (game_id, ply) IN ({some})")})
            case["evals"] = rows("SELECT * FROM evals WHERE list_contains(?, fen_key)", [pos_keys])
            case["multipv"] = rows("SELECT * FROM evals_multipv WHERE list_contains(?, fen_key)", [sorted(fetched)])
            con.close()

        case = own_case(p, p.id, inputs)
        real = O.attempts(rec_src)
        case["real_review"] = {"attempts": real, "schedule": O.schedule(real), "now": NOW,
                               "stats": O.stats(case["before"], O.schedule(real), NOW)}
        path = out / f"puzzles-{p.id}.json"
        path.write_text(json.dumps(case, separators=(",", ":"), default=plain), encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB): {len(case['before'])} puzzles")
        shutil.rmtree(p.dir)
    O.cached_lines = real_cached
    # the real library and daily records
    att = P.attempts(SOURCE / "puzzle_attempts.jsonl")
    daily = K.daily_record(SOURCE / "puzzle_daily.jsonl")
    today = date(2026, 10, 23)
    case = {"attempts": att, "stats": P.stats(att), "daily": daily, "solved": K.solved_later(SOURCE / "puzzle_solved.jsonl"),
            "streaks": [[d.isoformat(), list(K.streaks(daily, d))] for d in (today, date(2026, 10, 20), date(2026, 10, 21))]}
    path = out / "puzzles-records.json"
    path.write_text(json.dumps(case, separators=(",", ":"), default=plain), encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    try:
        lib = library()
        sample_ids = [r["id"] for r in lib["rows"]]
        out = {"now": NOW, "library": lib, "packs": packs_case(sample_ids), "own": fixture_profiles()}
        path = OUT / "puzzles.json"
        path.write_text(json.dumps(out, separators=(",", ":"), default=plain), encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")
        if ARGS.local:
            local()
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    main()
