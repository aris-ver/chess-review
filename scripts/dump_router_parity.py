"""Route-level parity dump: serve.Handler (through web/py/chess_web/bridge.py's handle, on CPython) answers a list of
requests in a scratch data folder, and tests/parity/router.json keeps each request with its answer. js/server's
router.test.js replays the same requests on the JS router over an empty data folder of its own and compares.

What the two sides share so the answers can match:
  - the engine: every search Stockfish runs here is recorded (fen, nodes, MultiPV → its info lines) and the JS side's
    pool replays them, so no engine is needed there;
  - chess.com: a fake one serving tests/parity/aggregates.json's chesscom pipeline (and a 404 for "nobody");
  - an empty opening book, and NODES nodes per position.

    STOCKFISH=../../../bin/stockfish .venv/bin/python scripts/dump_router_parity.py
"""

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = Path(tempfile.mkdtemp(prefix="router-parity-"))
os.environ["CHESS_REVIEW_DATA"] = str(SCRATCH / "data")     # before chess_review.config is imported
sys.path[:0] = [str(ROOT), str(ROOT / "web" / "py")]

import asyncio  # noqa: E402
import json  # noqa: E402
import subprocess  # noqa: E402

from chess_web import bridge  # noqa: E402
from chess_web.runner import WebRunner, _Replay  # noqa: E402

STOCKFISH = os.environ.get("STOCKFISH") or str(ROOT / "bin" / "stockfish")
NODES = 20000
ENGINE_NAME = "Stockfish (parity)"
OUT = ROOT / "tests" / "parity" / "router.json"
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
ITALIAN = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"
SCHOLAR = '[White "a"]\n[Black "b"]\n[Result "1-0"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n'


class Recorder:
    """One Stockfish, searched synchronously; every search's info lines kept under "fen|nodes|multipv"."""

    def __init__(self):
        self.proc = subprocess.Popen([STOCKFISH], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.send("uci", "setoption name Threads value 1", "setoption name Hash value 16")
        self.lines: dict[str, list[str]] = {}

    def send(self, *cmds):
        self.proc.stdin.write("".join(c + "\n" for c in cmds))
        self.proc.stdin.flush()

    def search(self, fen: str, nodes: int, multipv: int) -> list[str]:
        key = f"{fen}|{nodes}|{multipv}"
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
    """web/engines.js's EnginePool, as WebRunner sees it."""
    size, name = 2, ENGINE_NAME

    def __init__(self, rec: Recorder):
        self.rec = rec

    async def search(self, fen, nodes, multipv):
        await asyncio.sleep(0)
        return Lines(self.rec.search(fen, nodes, multipv))


class ReplayEngine:
    """The explorer's chess.engine.SimpleEngine, answered by the recorder."""

    def __init__(self, rec: Recorder):
        self.rec = rec

    def analyse(self, board, limit, multipv=None, game=None):
        return _Replay(self.rec.search(board.fen(), limit.nodes, multipv or 1)).analyse(board, limit, multipv, game)

    def quit(self):
        pass


def chesscom_site():
    c = json.loads((ROOT / "tests" / "parity" / "aggregates.json").read_text(encoding="utf-8"))["pipeline"]["chesscom"]
    user, raw = c["username"], c["raw"]
    base = f"https://api.chess.com/pub/player/{user}/games/"

    async def fetch(url, headers):
        def reply(status, body):
            data = [body.encode() if isinstance(body, str) else json.dumps(body).encode()]

            async def read():
                return data.pop() if data else b""
            return status, {}, read, lambda: None
        if f"/player/{user}/" not in url:
            return reply(404, {"code": 0, "message": "User not found"})
        if url.endswith("/stats"):
            return reply(200, {"chess_blitz": {"record": {"win": 40, "loss": 30, "draw": 3}}})
        if url.endswith("/archives"):
            return reply(200, {"archives": [base + f[:7].replace("-", "/") for f in sorted(raw)]})
        month = "-".join(url.split("?")[0].split("/")[-2:])
        return reply(200, raw[f"{month}.json"])
    return user, raw, fetch


def call(method, path, body=None):
    status, headers, payload = bridge.handle(method, path, json.dumps(body).encode() if body is not None else b"",
                                             "application/json" if body is not None else None)
    ctype = {k.lower(): v for k, v in headers}.get("content-type", "")
    try:
        parsed = json.loads(payload) if ctype.startswith("application/json") else None
    except ValueError:
        parsed = None
    return status, ctype, parsed, payload


async def wait():
    for _ in range(6000):
        st = call("GET", "/api/status")[2]
        if not st["job"] or st["job"]["status"] not in ("queued", "running", "finishing"):
            if not st["queue"]:
                return
        await asyncio.sleep(0.02)
    raise TimeoutError("the job never ended")


async def main():
    rec = Recorder()
    app = SCRATCH / "app"
    app.mkdir()
    (app / "book_keys.txt").write_text("", encoding="utf-8")
    bridge.setup(str(app), Pool(rec))
    user, raw, fetch = chesscom_site()
    runner = WebRunner(Pool(rec), nodes=NODES, fetch=fetch)
    runner.explorer.nodes = NODES
    runner.explorer.engine = lambda: ReplayEngine(rec)
    runner.explorer.close = lambda: None
    bridge.serve.Handler.runner = runner

    real_sleep = asyncio.sleep
    asyncio.sleep = lambda s, *a, **k: real_sleep(min(s, 0.01), *a, **k)    # ingest's pauses between months

    pgn, cc = "pgn-pasted-games", f"chesscom-{user.lower()}"
    steps = []

    def req(method, path, body=None, lenient=False, text=False):
        status, ctype, parsed, payload = call(method, path, body)
        step = {"method": method, "path": path, "body": body, "status": status, "type": ctype.split(";")[0]}
        if parsed is not None and not lenient:
            step["json"] = parsed
        if lenient:
            step["lenient"] = True      # an error worded by the chess library: status and an "error" key only
        if text:
            step["text"] = payload.decode()
        steps.append(step)
        return parsed

    async def waited():
        await wait()
        steps.append({"wait": True})

    req("GET", "/api/status")
    req("GET", "/api/profiles")
    req("POST", "/api/pgn", {"pgn": "  "})
    req("POST", "/api/pgn", {"pgn": "hello"})
    out = req("POST", "/api/pgn", {"pgn": SCHOLAR + "\n" + (ROOT / "tests" / "fixtures" / "clocks.pgn").read_text(encoding="utf-8")})
    slugs = list(out["games"])
    out = req("POST", "/api/pgn", {"pgn": SCHOLAR, "review_as": "black"})
    slugs += [s for s in out["games"] if s not in slugs]
    req("GET", "/api/profiles")
    req("GET", f"/p/{pgn}/games.json")
    for s in slugs:
        req("GET", f"/p/{pgn}/games/{s}.json")
    req("GET", f"/p/{pgn}/games/../games.json")
    req("GET", f"/p/{pgn}/games/nope.json")
    req("GET", "/p/nobody/games.json")
    req("POST", f"/api/p/{pgn}/analyse/{slugs[0]}")
    req("POST", f"/api/p/{pgn}/analyse/{slugs[0]}")       # the same analysis: the job under way
    req("POST", f"/api/p/{pgn}/analyse/{slugs[1]}")       # another: queued behind it
    req("GET", "/api/status")
    req("POST", f"/api/profiles/{pgn}/delete")            # busy
    await waited()
    req("GET", "/api/status")
    for s in slugs[:2]:
        req("GET", f"/p/{pgn}/games/{s}.json")
    req("GET", f"/p/{pgn}/games.json")
    req("GET", f"/p/{pgn}/insights.html")
    req("GET", "/api/profiles")

    req("POST", "/api/profiles", {"source": "fide", "username": "x"})
    req("POST", "/api/profiles", {"username": "  "})
    req("POST", "/api/profiles", {"source": "chesscom", "username": user})
    await waited()
    req("GET", "/api/status")
    req("GET", "/api/profiles")
    req("GET", f"/p/{cc}/games.json")
    req("POST", "/api/profiles", {"source": "chesscom", "username": user})    # already there: just opened
    req("POST", f"/api/p/{cc}/refresh")
    await waited()
    req("GET", "/api/status")
    req("POST", f"/api/p/{cc}/older")
    await waited()
    req("GET", "/api/status")
    req("POST", "/api/profiles", {"source": "chesscom", "username": "nobody"})
    await waited()
    req("GET", "/api/status")
    req("GET", "/api/profiles")                           # nobody's profile is gone

    games = call("GET", f"/p/{cc}/games.json")[2]["games"]
    req("GET", f"/api/profiles/{cc}/unseen")
    req("POST", f"/api/profiles/{cc}/seen")
    req("POST", f"/api/profiles/{cc}/games/{games[0]['id']}/seen")
    req("POST", f"/api/profiles/{cc}/pin", {"pinned": True})
    req("POST", f"/api/profiles/{cc}/pin", {"pinned": False})
    req("POST", "/api/profiles/nobody/pin", {})
    req("POST", "/api/p/nobody/refresh")
    req("POST", f"/api/p/{cc}/analyse/nope")
    req("POST", f"/api/p/{cc}/analyse/..%2Fx")

    req("GET", "/api/legal?fen=" + START.replace(" ", "%20"))
    req("GET", "/api/legal?fen=" + ITALIAN.replace(" ", "+"))
    req("GET", "/api/legal?fen=not+a+fen", lenient=True)
    req("GET", "/api/eval?fen=" + ITALIAN.replace(" ", "%20"))
    req("GET", "/api/eval?fen=" + START.replace(" ", "%20"))
    req("GET", "/api/eval?fen=xx", lenient=True)
    req("POST", "/api/explore", {"fen": ITALIAN, "uci": "g8f6", "my_colour": "black", "ply": 5})
    req("POST", "/api/explore", {"fen": START, "uci": "e2e4"})
    req("POST", "/api/explore", {"fen": START, "uci": "e2e5"}, lenient=True)
    req("POST", "/api/explore", {"uci": "e2e4"})
    req("GET", "/api/engine")
    req("POST", "/api/stop")
    req("POST", f"/api/profiles/{pgn}/delete")
    req("GET", "/api/profiles")
    req("POST", "/api/nope")
    req("GET", "/api/status")

    OUT.write_text(json.dumps({"nodes": NODES, "engine": ENGINE_NAME, "chesscom": {"username": user, "raw": raw},
                               "lines": rec.lines, "steps": steps}, indent=1) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(steps)} steps, {len(rec.lines)} searches")
    rec.send("quit")


asyncio.run(main())
