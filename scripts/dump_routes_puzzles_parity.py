"""Route-level parity dump for the puzzle routes: serve.Handler (through web/py/chess_web/bridge.py's handle, on
CPython) answers GET /api/puzzles/<what> and the POSTs under /api/puzzles/, and runs the puzzle jobs (build and
puzzles) on serve.Runner itself; tests/parity/routes-puzzles.json keeps each request with its answer.
js/server/routes-puzzles.test.js replays the same requests on the JS router over an empty data folder and compares.

What the two sides share so the answers can match (as scripts/dump_router_parity.py, whose ways this copies):
  - the engine: every search Stockfish runs here is recorded (fen, nodes, MultiPV -> its info lines) and replayed
    by the JS side's pool;
  - the Lichess pack: tests/parity/puzzles.json's library sample, and a small packs.json made from it (both kept in
    the dump);
  - the clock: frozen at CLOCK (UTC), moved on by the "clock" steps; random.choice takes the first candidate;
  - jobs: serve.Runner's threads are held at the start until a "wait" step, as the JS runner's jobs only run once
    the test awaits them;
  - an empty opening book, and NODES nodes per position.

    STOCKFISH=../../../bin/stockfish .venv/bin/python scripts/dump_routes_puzzles_parity.py
"""

import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = Path(tempfile.mkdtemp(prefix="routes-puzzles-parity-"))
os.environ["CHESS_REVIEW_DATA"] = str(SCRATCH / "data")     # before chess_review.config is imported
os.environ["TZ"] = "UTC"
time.tzset()
sys.path[:0] = [str(ROOT), str(ROOT / "web" / "py")]

import asyncio  # noqa: E402
import datetime  # noqa: E402
import json  # noqa: E402
import random  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402
import types  # noqa: E402

from chess_review import own_puzzles, packs, puzzles, serve  # noqa: E402
from chess_web import bridge  # noqa: E402
from chess_web.runner import BrowserAnalyser  # noqa: E402

STOCKFISH = os.environ.get("STOCKFISH") or str(ROOT / "bin" / "stockfish")
NODES = 20000
ENGINE_NAME = "Stockfish (parity)"
OUT = ROOT / "tests" / "parity" / "routes-puzzles.json"
START = datetime.datetime(2026, 10, 23, 12, 0, tzinfo=datetime.timezone.utc).timestamp()
CLOCK = [START]
SCHOLAR = '[White "a"]\n[Black "b"]\n[Result "1-0"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n'
# reviewed as black: mistakes where one move stood out (the recapture 3...Nxe5, and what the Fried Liver asks for)
MISTAKES = ('[Event "g1"]\n[White "c"]\n[Black "d"]\n[Date "2026.10.01"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Be7 '
            '4. Qxg7 Bf6 5. Qg3 d5 6. exd5 Qe7+ 7. Be2 Nd4 8. Kd1 Bf5 1-0\n\n'
            '[Event "g2"]\n[White "e"]\n[Black "f"]\n[Date "2026.10.02"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 '
            '5. exd5 Nxd5 6. Nxf7 Kxf7 7. Qf3+ Ke6 8. Nc3 Ncb4 9. a3 Nxc2+ 10. Kd1 Nxa1 11. Nxd5 Kd6 12. d4 c6 1-0\n')


class Recorder:
    """One Stockfish, searched synchronously; every search's info lines kept under "fen|nodes|multipv"."""

    def __init__(self):
        self.proc = subprocess.Popen([STOCKFISH], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.send("uci", "setoption name Threads value 1", "setoption name Hash value 16")
        self.lines: dict[str, list[str]] = {}
        self.lock = threading.Lock()

    def send(self, *cmds):
        self.proc.stdin.write("".join(c + "\n" for c in cmds))
        self.proc.stdin.flush()

    def search(self, fen: str, nodes: int, multipv: int) -> list[str]:
        key = f"{fen}|{nodes}|{multipv}"
        with self.lock:
            if key not in self.lines:
                self.send("ucinewgame", f"setoption name MultiPV value {multipv}", "isready")
                while not self.proc.stdout.readline().startswith("readyok"):
                    pass
                self.send(f"position fen {fen}", f"go nodes {nodes}")
                out = []
                while True:
                    line = self.proc.stdout.readline().strip()
                    if line.startswith("bestmove"):
                        break
                    if line.startswith("info "):
                        out.append(line)
                self.lines[key] = out
            return self.lines[key]


class Lines(list):
    def to_py(self):
        return list(self)


class Pool:
    """web/engines.js's EnginePool, as BrowserAnalyser sees it."""
    size, name = 2, ENGINE_NAME

    def __init__(self, rec: Recorder):
        self.rec = rec

    async def search(self, fen, nodes, multipv):
        await asyncio.sleep(0)
        return Lines(self.rec.search(fen, nodes, multipv))


class SyncAnalyser:
    """BrowserAnalyser (the analysis the JS runner does) for serve.Runner's job threads."""

    def __init__(self, pool):
        self.inner = BrowserAnalyser(pool, NODES)
        self.workers = self.inner.workers

    def run(self, *a, **k):
        return asyncio.run(self.inner.run(*a, **k))


class GatedRunner(serve.Runner):
    """serve.Runner whose job threads wait for release(): a job starts when the replay awaits it, not before."""

    def __init__(self, pool):
        super().__init__(NODES, workers=2, builds_file=SCRATCH / "data" / "puzzle_builds.json")
        self.analyser = SyncAnalyser(pool)
        self.gates: list[threading.Event] = []

    def _spawn(self, job, before):
        gate = threading.Event()
        self.gates.append(gate)

        def run():
            gate.wait()
            self._run(job, before)
        t = threading.Thread(target=run, daemon=True)
        t.start()
        return t

    def release(self):
        for g in self.gates:
            g.set()

    def settle(self):
        """Until every job (and whatever each one starts as it ends) has run."""
        while True:
            self.release()
            t = self.thread
            if t is not None:
                t.join(0.05)
            if (t is None or not t.is_alive()) and self.thread is t and not self.busy() and not self.queue:
                return


class Clock:
    """The time module, with time() and strftime() at CLOCK."""

    def __getattr__(self, name):
        return getattr(time, name)

    def time(self):
        return CLOCK[0]

    def strftime(self, fmt, t=None):
        return time.strftime(fmt, time.localtime(CLOCK[0]) if t is None else t)


class Day(datetime.date):
    @classmethod
    def today(cls):
        return datetime.date.fromtimestamp(CLOCK[0])


def pack_data() -> tuple[list[dict], dict]:
    """The library sample's rows as puzzles.json has them, and a packs.json over them: two packs of three stages,
    and a daily list."""
    rows = json.loads((ROOT / "tests" / "parity" / "puzzles.json").read_text(encoding="utf-8"))["library"]["rows"]
    out = []
    for pid, theme, without in (("mates", "mate", []), ("endgames", "endgame", ["mate"])):
        mine = sorted((r for r in rows if theme in r["themes"].split() and not set(without) & set(r["themes"].split())),
                      key=lambda r: (r["rating"], r["id"]))[:15]
        stages = [{"n": i + 1, "lo": mine[i * 5]["rating"], "hi": mine[i * 5 + 4]["rating"],
                   "ids": [r["id"] for r in mine[i * 5:i * 5 + 5]]} for i in range(3)]
        out.append({"id": pid, "family": theme, "name": theme.capitalize(), "desc": f"{theme} puzzles", "themes": [theme],
                    "without": without, "stages": stages})
    return rows, {"version": 1, "stage_size": 5, "packs": out, "daily": [r["id"] for r in rows[:10]]}


def call(method, path, body=None):
    status, headers, payload = bridge.handle(method, path, json.dumps(body).encode() if body is not None else b"",
                                             "application/json" if body is not None else None)
    ctype = {k.lower(): v for k, v in headers}.get("content-type", "")
    try:
        parsed = json.loads(payload) if ctype.startswith("application/json") else None
    except ValueError:
        parsed = None
    return status, ctype, parsed


def main():
    rec = Recorder()
    app = SCRATCH / "app"
    app.mkdir()
    (app / "book_keys.txt").write_text("", encoding="utf-8")
    rows, packs_json = pack_data()
    (app / "puzzles.json").write_text(json.dumps(rows), encoding="utf-8")
    bridge.setup(str(app), Pool(rec))
    packs.INSTANCE._data = packs_json
    for m in (serve, puzzles, packs, own_puzzles):
        m.time = Clock()
    serve.datetime = types.SimpleNamespace(date=Day)
    random.choice = lambda xs: xs[0]
    runner = GatedRunner(Pool(rec))
    bridge.serve.Handler.runner = runner

    pgn = "pgn-pasted-games"
    steps = []

    def req(method, path, body=None):
        status, ctype, parsed = call(method, path, body)
        step = {"method": method, "path": path, "body": body, "status": status, "type": ctype.split(";")[0]}
        if parsed is not None:
            step["json"] = parsed
        steps.append(step)
        return parsed

    def waited():
        runner.settle()
        steps.append({"wait": True})

    def clock(t):
        CLOCK[0] = t
        steps.append({"clock": t})

    lib = [r["id"] for r in rows]
    daily = packs.daily_id(Day.today())
    mates = packs_json["packs"][0]

    # the library, before anything is played
    req("GET", "/api/puzzles/themes")
    req("GET", "/api/puzzles/sources")
    req("GET", "/api/puzzles/packs")
    req("GET", "/api/puzzles/daily")
    req("GET", f"/api/puzzles/pack?id={mates['id']}")
    req("GET", "/api/puzzles/pack?id=nope")
    req("GET", "/api/puzzles/pack")
    req("GET", "/api/puzzles/next")
    req("GET", f"/api/puzzles/next?skip={lib[0]}&source=")
    req("GET", "/api/puzzles/next?themes=endgame,fork")
    req("GET", "/api/puzzles/next?themes=noSuchTheme")
    req("GET", f"/api/puzzles/get?id={lib[3]}")
    req("GET", "/api/puzzles/get?id=nope")
    req("GET", "/api/puzzles/get?id=m0123456789")
    req("GET", "/api/puzzles/get")
    req("GET", "/api/puzzles/next?source=mine:nobody")
    req("GET", "/api/puzzles/nope")
    req("POST", "/api/puzzles/nope", {})

    # tries, solves and the daily
    for i, pid in enumerate(mates["stages"][0]["ids"]):
        req("POST", "/api/puzzles/attempt", {"id": pid, "solved": i != 2, "ms": 1000 + i * 250.7, "hinted": i == 4})
    req("POST", "/api/puzzles/attempt", {"id": mates["stages"][0]["ids"][0], "solved": False, "ms": 5})   # not counted
    req("POST", "/api/puzzles/attempt", {"id": lib[7], "solved": 1, "ms": "fast"})
    req("POST", "/api/puzzles/attempt", {"id": lib[8], "solved": True, "ms": True})
    req("POST", "/api/puzzles/attempt", {"id": "nope", "solved": True})
    req("POST", "/api/puzzles/attempt", {})
    req("POST", "/api/puzzles/solved", {"id": mates["stages"][0]["ids"][2]})
    req("POST", "/api/puzzles/solved", {"id": mates["stages"][0]["ids"][2]})
    req("POST", "/api/puzzles/solved", {"id": "nope"})
    req("POST", "/api/puzzles/daily", {"id": "wrong", "solved": True, "clean": True, "ms": 3000, "marks": ["a"]})
    req("POST", "/api/puzzles/daily", {"id": daily, "solved": True, "clean": True, "ms": 3000.9, "marks": ["e4", 5, None]})
    req("POST", "/api/puzzles/daily", {"id": daily, "solved": False, "clean": False, "ms": 1, "marks": []})
    req("GET", "/api/puzzles/daily")
    req("GET", "/api/puzzles/packs")
    req("GET", f"/api/puzzles/pack?id={mates['id']}")
    req("GET", "/api/puzzles/themes")
    req("GET", "/api/puzzles/next?themes=mate")
    clock(CLOCK[0] + 86400)
    req("POST", "/api/puzzles/daily", {"id": packs.daily_id(Day.today()), "solved": True, "clean": False, "ms": None, "marks": "x"})
    req("GET", "/api/puzzles/packs")
    req("POST", "/api/puzzles/reset", {"what": "rating"})
    req("POST", "/api/puzzles/reset", {"what": "rating"})       # nothing left to archive
    req("POST", "/api/puzzles/reset", {"what": "everything"})
    req("POST", "/api/puzzles/reset", {"what": "schedule", "profile": "nobody"})
    req("GET", f"/api/puzzles/pack?id={mates['id']}")
    req("GET", "/api/puzzles/next")
    req("POST", "/api/puzzles/attempt", {"id": mates["stages"][0]["ids"][1], "solved": True})   # tried before the reset

    # puzzles from your own games
    req("POST", "/api/pgn", {"pgn": SCHOLAR + "\n" + (ROOT / "tests" / "fixtures" / "clocks.pgn").read_text(encoding="utf-8")})
    req("POST", "/api/pgn", {"pgn": SCHOLAR, "review_as": "black"})
    out = req("POST", "/api/pgn", {"pgn": MISTAKES, "review_as": "black"})
    games = out["games"]
    req("GET", "/api/puzzles/sources")
    req("GET", f"/api/puzzles/next?source=mine:{pgn}")
    req("POST", "/api/puzzles/build", {"profile": "nobody"})
    req("POST", "/api/puzzles/build/stop", {})
    req("POST", f"/api/p/{pgn}/analyse/{games[0]}")
    waited()
    req("GET", "/api/puzzles/sources")              # a profile with puzzles waiting for their lines: job "puzzles"
    req("GET", "/api/status")
    req("GET", f"/api/puzzles/next?source=mine:{pgn}")
    req("GET", "/api/puzzles/sources")              # the job is under way: not started again
    req("POST", "/api/puzzles/build", {"profile": pgn})     # takes over from the puzzles job
    req("POST", "/api/puzzles/build", {"profile": pgn})     # asked again: the same build
    req("POST", f"/api/p/{pgn}/analyse/{games[1]}")         # the build gives way
    req("GET", "/api/status")
    waited()
    req("GET", "/api/status")
    req("GET", "/api/puzzles/sources")
    first = req("GET", f"/api/puzzles/next?source=mine:{pgn}")
    own = [first["puzzle"]["id"]] if first.get("puzzle") else []
    second = req("GET", f"/api/puzzles/next?source=mine:{pgn}&skip={own[0]}") if own else None
    if second and second.get("puzzle"):
        own.append(second["puzzle"]["id"])
    for pid in own:
        req("GET", f"/api/puzzles/get?id={pid}")
    if own:
        req("POST", "/api/puzzles/attempt", {"id": own[0], "solved": False, "ms": 4000})
        req("POST", "/api/puzzles/solved", {"id": own[0]})
    if len(own) > 1:
        req("POST", "/api/puzzles/attempt", {"id": own[1], "solved": True, "hinted": True})
    req(f"GET", f"/api/puzzles/next?source=mine:{pgn}")
    clock(CLOCK[0] + 2 * 86400)
    req("GET", f"/api/puzzles/next?source=mine:{pgn}")      # the miss is due
    if own:
        req("POST", "/api/puzzles/attempt", {"id": own[0], "solved": True, "ms": 2000})
        clock(CLOCK[0] + 4 * 86400)
        req("POST", "/api/puzzles/attempt", {"id": own[0], "solved": True, "ms": 1500})
    req("GET", "/api/puzzles/sources")
    req("POST", "/api/puzzles/reset", {"what": "schedule", "profile": pgn})
    req("POST", "/api/puzzles/reset", {"what": "schedule", "profile": pgn})
    req("GET", f"/api/puzzles/next?source=mine:{pgn}")
    req("POST", "/api/puzzles/build", {"profile": pgn})     # nothing left to analyse: settles the lines, done
    req("GET", "/api/status")
    waited()
    req("GET", "/api/status")
    req("POST", "/api/puzzles/build", {"profile": pgn})
    req("POST", "/api/puzzles/build/stop", {"profile": pgn})   # stopped before it ran
    waited()
    req("GET", "/api/status")
    req("POST", "/api/puzzles/build/stop", {"profile": pgn})
    req("POST", f"/api/profiles/{pgn}/delete")
    req("GET", "/api/puzzles/sources")

    OUT.write_text(json.dumps({"nodes": NODES, "engine": ENGINE_NAME, "clock": START, "pack": rows, "packs": packs_json,
                               "lines": rec.lines, "steps": steps}, indent=1) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(steps)} steps, {len(rec.lines)} searches, own puzzles {own}")
    rec.send("quit")


main()
