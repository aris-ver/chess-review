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
later.stand_in()        # as the worker does: DuckDB and pyarrow still loading
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
out["pyarrow imported"] = "pyarrow.lib" in sys.modules or "duckdb.duckdb" in sys.modules
later.swap_in()
status, d = call("POST", "/api/pgn", {"pgn": pgn})
out["pgn after"] = [status, len(d["games"])]
from chess_review import analyse
out["swapped"] = type(analyse.duckdb).__name__
print("RESULT" + json.dumps(out))
"""


def test_light_routes_answer_before_duckdb_and_pyarrow(tmp_path):
    """The worker starts Python with placeholders for DuckDB and pyarrow (web/py/chess_web/later.py): the home screen,
    the puzzles and the settings answer from the pack's JSON, and a request that needs the two raises NotLoaded
    until they are swapped in, then works."""
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
    assert out["pyarrow imported"] is False
    assert out["pgn after"] == [200, 1]
    assert out["swapped"] == "module"
