"""The browser version's Python side on CPython: serve.Handler answering requests without a socket (web bridge),
and WebRunner analysing a pasted game on asyncio with an engine pool that hands back raw `info` lines, as the
WASM pool in web/engines.js does. Runs in a subprocess, since DATA is fixed when chess_review.config is imported."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
STOCKFISH = ROOT / "bin" / ("stockfish.exe" if sys.platform == "win32" else "stockfish")

SCRIPT = r"""
import asyncio, json, sys
sys.path[:0] = [ROOT, ROOT + "/web/py"]
from chess_web import bridge

class Lines(list):
    def to_py(self):
        return list(self)

class Pool:
    # engines.js's EnginePool over a native Stockfish: the search's info lines, raw
    size, name = 1, "Stockfish (test)"
    async def search(self, fen, nodes, multipv):
        p = await asyncio.create_subprocess_exec(STOCKFISH, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        p.stdin.write(f"uci\nsetoption name Threads value 1\nsetoption name Hash value 16\nsetoption name MultiPV value {multipv}\n"
                      f"ucinewgame\nposition fen {fen}\ngo nodes {nodes}\n".encode())
        out = Lines()
        while True:
            line = (await p.stdout.readline()).decode().strip()
            if line.startswith("info "):
                out.append(line)
            if line.startswith("bestmove"):
                break
        p.stdin.write(b"quit\n")
        await p.wait()
        return out

def call(method, path, body=None):
    status, headers, payload = bridge.handle(method, path, json.dumps(body).encode() if body is not None else b"")
    return status, {k.lower(): v for k, v in headers}, payload

async def main():
    open(APP + "/book_keys.txt", "w").write("")
    bridge.setup(APP, Pool())
    bridge.serve.Handler.runner.analyser.nodes = 20000
    out = {}
    status, headers, payload = call("GET", "/api/legal?fen=" + "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR%20w%20KQkq%20-%200%201")
    out["legal"] = [status, headers.get("content-type"), len(json.loads(payload)["moves"])]
    out["missing"] = call("GET", "/api/nope")[0]
    pgn = '[White "a"]\n[Black "b"]\n[Result "1-0"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n'
    status, _, payload = call("POST", "/api/pgn", {"pgn": pgn})
    d = json.loads(payload)
    pid, slug = d["profile"]["id"], d["games"][0]
    status, _, payload = call("POST", f"/api/p/{pid}/analyse/{slug}")
    out["analyse"] = [status, json.loads(payload)["job"]["status"]]
    for _ in range(600):
        st = json.loads(call("GET", "/api/status")[2])
        if st["job"]["status"] not in ("queued", "running", "finishing"):
            break
        await asyncio.sleep(0.05)
    out["job"] = {k: st["job"][k] for k in ("status", "done", "total", "error")}
    status, headers, payload = call("GET", f"/p/{pid}/games/{slug}.json")
    game = json.loads(payload)
    out["game"] = [status, headers.get("content-type"), game]
    print("RESULT" + json.dumps(out))

asyncio.run(main())
"""


@pytest.mark.skipif(not STOCKFISH.exists(), reason="no bin/stockfish")
def test_bridge_reviews_a_pasted_game(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    env = {**os.environ, "CHESS_REVIEW_DATA": str(tmp_path / "data")}
    script = f"ROOT, APP, STOCKFISH = {str(ROOT)!r}, {str(app)!r}, {str(STOCKFISH)!r}\n" + SCRIPT
    run = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=300)
    line = next((x for x in run.stdout.splitlines() if x.startswith("RESULT")), None)
    assert line, run.stdout + run.stderr
    out = json.loads(line[6:])
    assert out["legal"] == [200, "application/json", 20]
    assert out["missing"] == 404
    assert out["analyse"][0] == 200
    assert out["job"] == {"status": "done", "done": out["job"]["total"], "total": out["job"]["total"], "error": None}
    assert out["job"]["total"] > 0
    status, ctype, game = out["game"]
    assert status == 200 and ctype == "application/json"
    labels = [m.get("label") for m in game["moves"]]
    assert labels and all(labels), game["moves"]


LATER = r"""
import json, sys
sys.path[:0] = [ROOT, ROOT + "/web/py"]
from chess_web import later
later.stand_in()        # as the worker does: DuckDB still loading
from chess_web import bridge

class Pool:
    size, name = 1, "Stockfish (test)"

def call(method, path, body=None):
    try:
        status, _, payload = bridge.handle(method, path, json.dumps(body).encode() if body is not None else b"")
    except later.NotLoaded as e:
        return [type(e).__name__, str(e)]
    return [status, json.loads(payload) if payload[:1] in (b"{", b"[") else None]

open(APP + "/book_keys.txt", "w").write("")
bridge.setup(APP, Pool(), pack_later=True)
out = {}
# the puzzle pack still downloading: the puzzles wait for it (PackNotLoaded), the profiles don't
out["pack before"] = call("GET", "/api/puzzles/themes")[0]
out["profiles before pack"] = call("GET", "/api/profiles")[0]
import shutil; shutil.copy(PACK, APP + "/puzzles.json")       # as the worker writes it once downloaded
for path in ("/api/status", "/api/profiles", "/api/settings", "/api/puzzles/themes", "/api/puzzles/packs",
             "/api/puzzles/daily", "/api/puzzles/next", "/api/legal?fen=8/8/8/8/8/8/8/K1k5%20w%20-%20-%200%201"):
    out[path] = call("GET", path)[0]
pid = call("GET", "/api/puzzles/next")[1]["puzzle"]["id"]
out["attempt"] = call("POST", "/api/puzzles/attempt", {"id": pid, "solved": True, "ms": 5000})[0]
out["solved"] = call("POST", "/api/puzzles/solved", {"id": pid})[0]
out["post settings"] = call("POST", "/api/settings", {"theme": "x"})[0]
pgn = '[White "a"]\n[Black "b"]\n[Result "1-0"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n'
out["pgn before"] = call("POST", "/api/pgn", {"pgn": pgn})
out["duckdb imported"] = "duckdb.duckdb" in sys.modules
out["pyarrow imported"] = "pyarrow" in sys.modules
later.swap_in()
status, d = call("POST", "/api/pgn", {"pgn": pgn})
out["pgn after"] = [status, len(d["games"])]
from chess_review import analyse
out["swapped"] = type(analyse.duckdb).__name__
print("RESULT" + json.dumps(out))
"""


def test_light_routes_answer_before_duckdb(tmp_path):
    """The worker starts Python with a placeholder for DuckDB (web/py/chess_web/later.py): the home screen, the
    puzzles and the settings answer from the pack's JSON, and a request that needs DuckDB raises NotLoaded until
    it is swapped in, then works. Nothing imports pyarrow at all."""
    from chess_review import puzzles
    app = tmp_path / "app"
    app.mkdir()
    pack = tmp_path / "puzzles.json"        # arrives after start-up: the worker downloads it alongside Python
    pack.write_text(json.dumps(puzzles.PACK_INSTANCE._read()[:300]), encoding="utf-8")
    env = {**os.environ, "CHESS_REVIEW_DATA": str(tmp_path / "data")}
    script = f"ROOT, APP, PACK = {str(ROOT)!r}, {str(app)!r}, {str(pack)!r}\n" + LATER
    run = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=120)
    line = next((x for x in run.stdout.splitlines() if x.startswith("RESULT")), None)
    assert line, run.stdout + run.stderr
    out = json.loads(line[6:])
    assert {k: v for k, v in out.items() if k.startswith("/api/")} == {k: 200 for k in out if k.startswith("/api/")}
    assert out["attempt"] == out["solved"] == out["post settings"] == 200
    assert out["pack before"] == "PackNotLoaded" and out["profiles before pack"] == 200
    assert out["pgn before"][0] == "NotLoaded"
    assert out["duckdb imported"] is False
    assert out["pgn after"] == [200, 1]
    assert out["swapped"] == "module"
    assert out["pyarrow imported"] is False


FETCH = r"""
import asyncio, json, sys
sys.path[:0] = [ROOT, ROOT + "/web/py"]
from chess_web import bridge, runner
from chess_review import ingest

class Pool:
    size, name = 1, "Stockfish (test)"

GAME = {"url": "https://www.chess.com/game/live/99", "pgn": PGN, "time_control": "180+2", "end_time": 1709374272,
        "rules": "chess", "time_class": "blitz", "white": {"username": "Someone", "rating": 1500, "result": "win"},
        "black": {"username": "TestUser", "rating": 1480, "result": "checkmated"}}
BASE = "https://api.chess.com/pub/player/"
asked = []

def reply(status, body=b"", chunk=1 << 20):
    parts = [body[i:i + chunk] for i in range(0, len(body), chunk)]
    async def read():
        await asyncio.sleep(0.01)
        return parts.pop(0) if parts else b""
    return status, {"Content-Type": "application/json"}, read, lambda: None

async def fetch(url, headers):
    # chess.com as the browser's fetch would answer it, a little slowly
    asked.append((url, headers))
    await asyncio.sleep(0.05)
    if url == BASE + "testuser/games/archives":
        return reply(200, json.dumps({"archives": [BASE + "testuser/games/2026/09"]}).encode())
    if url == BASE + "testuser/games/2026/09":
        return reply(200, json.dumps({"games": [GAME]}).encode(), chunk=100)
    if url.startswith(BASE + "offline/"):
        raise TypeError("Failed to fetch")      # what fetch throws offline, or refused by CORS
    if url.startswith(BASE + "hangs/"):
        await asyncio.Event().wait()
    return reply(404, b'{"message": "not found"}')

def call(method, path, body=None):
    status, _, payload = bridge.handle(method, path, json.dumps(body).encode() if body is not None else b"")
    return status, json.loads(payload) if payload[:1] in (b"{", b"[") else None

async def until_ended(seen=None):
    for _ in range(400):
        job = call("GET", "/api/status")[1]["job"]
        if seen is not None:
            seen.append([job["status"], job["done"], job["total"]])
        if job["status"] not in ("queued", "running", "finishing"):
            return job
        await asyncio.sleep(0.02)
    raise AssertionError("the job never ended")

async def main():
    open(APP + "/book_keys.txt", "w").write("")
    bridge.setup(APP, Pool())
    bridge.serve.Handler.runner.fetch = fetch
    out = {}
    status, d = call("POST", "/api/profiles", {"source": "chesscom", "username": "testuser"})
    first = d["job"]["id"]
    # asked again before it has got anywhere (the page redrawn by an account sync): the same fetch, not "busy"
    again = call("POST", "/api/profiles", {"source": "chesscom", "username": "testuser"})
    out["again"] = [again[0], again[1]["job"]["id"] == first]
    seen = []
    job = await until_ended(seen)
    out["ok"] = {k: job[k] for k in ("status", "error")}
    out["seen"] = seen
    out["games"] = len(call("GET", "/p/chesscom-testuser/games.json")[1]["games"])
    out["user agent"] = any("User-Agent" in h for _, h in asked)

    call("POST", "/api/profiles", {"source": "chesscom", "username": "typo"})
    out["typo"] = (await until_ended())["error"]
    call("POST", "/api/profiles", {"source": "chesscom", "username": "offline"})
    out["offline"] = (await until_ended())["error"]
    out["profiles"] = sorted(p["id"] for p in call("GET", "/api/profiles")[1]["profiles"])
    status, d = call("POST", "/api/profiles", {"source": "chesscom", "username": "offline"})
    out["offline again"] = [status, d["job"]["status"]]
    await until_ended()

    def one(step):
        return (yield step)
    try:        # a request that never answers ends at its timeout
        await runner.drive(one(ingest.Get(BASE + "hangs/games/archives", timeout=0.2)), fetch)
    except TimeoutError as e:
        out["hangs"] = str(e)

    # lichess's export, streamed in chunks that cut lines in two
    body = b"".join(json.dumps({"id": f"g{i}"}).encode() + b"\n" for i in range(5))
    async def lichess(url, headers):
        asked.append((url, headers))
        return reply(200, body, chunk=7)
    got = []
    await runner.drive(ingest._lichess_stream("someone", {}, lambda g: got.append(g["id"])), lichess)
    out["lichess"] = [got, asked[-1][1], "perfType=" in asked[-1][0]]
    print("RESULT" + json.dumps(out))

asyncio.run(main())
"""


def test_fetching_a_profile_in_the_browser_keeps_answering_and_always_ends(tmp_path):
    """WebRunner fetches with the browser's fetch (stubbed here), each request awaited: the page's status polls are
    answered while the games come in, with the fetch's progress, and a fetch that fails or never answers ends the
    job with an error that says why. A second ask for the same fetch gets that job, not "busy"; only a player
    who doesn't exist removes the profile."""
    app = tmp_path / "app"
    app.mkdir()
    pgn = (ROOT / "tests" / "fixtures" / "clocks.pgn").read_text().split("\n\n[Event")[0]
    env = {**os.environ, "CHESS_REVIEW_DATA": str(tmp_path / "data")}
    script = f"ROOT, APP, PGN = {str(ROOT)!r}, {str(app)!r}, {pgn!r}\n" + FETCH
    run = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=120)
    line = next((x for x in run.stdout.splitlines() if x.startswith("RESULT")), None)
    assert line, run.stdout + run.stderr
    out = json.loads(line[6:])
    assert out["again"] == [200, True]
    assert out["ok"] == {"status": "done", "error": None}
    assert ["running", 0, 4] in out["seen"]        # polled mid-fetch: the month list is in, the month isn't yet
    assert out["games"] == 1
    assert out["user agent"] is False
    assert out["typo"] == "chess.com has no user called typo"
    assert out["offline"] == "couldn't reach api.chess.com: Failed to fetch"
    assert out["profiles"] == ["chesscom-offline", "chesscom-testuser"]
    assert out["offline again"] == [200, "queued"]
    assert out["hangs"] == "api.chess.com didn't answer within 0.2 s"
    assert out["lichess"] == [[f"g{i}" for i in range(5)], {"Accept": "application/x-ndjson"}, True]
