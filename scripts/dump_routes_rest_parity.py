"""Route-level parity dump for the rest of serve.Handler: /account/*, /api/sync/*, /api/fetch_image, /api/settings and
the updater's routes. serve.Handler answers a list of requests in a scratch data folder (through web/py/chess_web's
bridge, with the Host header and port the desktop server has), and tests/parity/routes-rest.json keeps each request
with its answer. js/server/routes-rest.test.js replays them on the JS router and compares.

Nothing outside is contacted: every HTTP request the handler makes (blundr.gr's Worker, GitHub's releases, image
hosts) is answered from the step's own list of replies, and the requests made are kept beside them ("upstream"),
so the JS side can check it asks the same things in the same order. Also kept: whatever was opened in the browser,
the account token after each step, and after each sync step the data folder's puzzle files, profiles and set-aside
workspaces (`view`).

    .venv/bin/python scripts/dump_routes_rest_parity.py
"""

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = Path(tempfile.mkdtemp(prefix="routes-rest-parity-"))
os.environ["CHESS_REVIEW_DATA"] = str(SCRATCH / "data")     # before chess_review.config is imported
os.environ.pop("BLUNDR_URL", None)
sys.path[:0] = [str(ROOT), str(ROOT / "web" / "py")]

import base64  # noqa: E402
import http.client  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import threading  # noqa: E402
import types  # noqa: E402
import webbrowser  # noqa: E402
import zipfile  # noqa: E402
from urllib.parse import urlencode  # noqa: E402

import requests  # noqa: E402
import urllib3  # noqa: E402
from requests.structures import CaseInsensitiveDict  # noqa: E402

from chess_web import bridge  # noqa: E402
from chess_review import account, serve, sync, updater  # noqa: E402
from chess_review.config import DATA  # noqa: E402

PORT = 8123
OUT = ROOT / "tests" / "parity" / "routes-rest.json"
GH = "https://api.github.com/repos/aris-ver/chess-review/releases"


# ---------- the outside world, answered from a list ----------

class Tape:
    def __init__(self):
        self.replies, self.seen = [], []

    def request(self, method, url, params=None, data=None, headers=None, **_kw):
        if params:
            url += "?" + urlencode(params)
        if not self.replies:
            raise AssertionError(f"unexpected request: {method} {url}")
        rep = self.replies.pop(0)
        self.seen.append({"method": method, "url": url, "headers": dict(headers or {}),
                          "body": data.decode() if data is not None else None, "reply": rep})
        if "raise" in rep:
            raise requests.ConnectionError(rep["raise"])
        body = bytes(rep["zeros"]) if "zeros" in rep else base64.b64decode(rep.get("b64", ""))
        r = requests.Response()
        r.status_code, r.reason, r.url = rep["status"], rep["reason"], url
        r.headers = CaseInsensitiveDict(rep["headers"])
        r.raw = urllib3.HTTPResponse(body=io.BytesIO(body), preload_content=False, status=rep["status"],
                                     headers=rep["headers"])
        return r


TAPE = Tape()
requests.request = TAPE.request
requests.get = lambda url, **kw: TAPE.request("GET", url, **kw)


def reply(status=200, body=b"", ctype="application/json", headers=None):
    if not isinstance(body, bytes):
        body = json.dumps(body).encode()
    h = {"Content-Type": ctype} if ctype else {}
    h.update(headers or {})
    return {"status": status, "reason": http.client.responses.get(status, ""), "headers": h,
            "b64": base64.b64encode(body).decode()}


def offline(msg="fake: unreachable"):
    return {"raise": msg}


OPENED = []
webbrowser.open = OPENED.append
account.Path = types.SimpleNamespace(home=lambda: SCRATCH / "home")     # no Downloads folder: the export goes to DATA


class LaterThread:
    """updater's download thread, run when the dump says (a "drain" step), so the answers don't race it."""
    pending = []

    def __init__(self, target, args=(), **_kw):
        self.target, self.args = target, args

    def start(self):
        LaterThread.pending.append(self)


POPENS = []
updater.threading = types.SimpleNamespace(Thread=LaterThread, Lock=threading.Lock, Timer=threading.Timer)
updater.subprocess = types.SimpleNamespace(Popen=lambda *a, **k: POPENS.append(a), CREATE_NO_WINDOW=0,
                                           CREATE_NEW_PROCESS_GROUP=0, DEVNULL=-3)
updater.sys = types.SimpleNamespace(platform="win32", executable=str(SCRATCH / "app" / "Blundr.exe"))


# ---------- requests to the handler ----------

class Req(bridge._Request):
    """bridge's in-memory request, with the desktop server's port and the headers a browser sends."""

    def __init__(self, method, path, body, content_type, headers):
        super().__init__(method, path, body, content_type)
        self.server = types.SimpleNamespace(server_address=("127.0.0.1", PORT))
        h = {"Host": f"127.0.0.1:{PORT}", "Content-Length": str(len(body)), **({"Content-Type": content_type} if content_type else {}),
             **(headers or {})}
        head = "".join(f"{k}: {v}\r\n" for k, v in h.items()) + "\r\n"
        self.headers = http.client.parse_headers(io.BytesIO(head.encode("latin-1")))


def call(method, path, body, headers):
    req = Req(method, path, body, "application/json" if body else None, headers)
    try:
        getattr(req, "do_" + method)()
    except Exception as e:  # noqa: BLE001 - as bridge.handle answers
        return 500, "application/json", json.dumps({"error": str(e)}).encode()
    head, _, payload = req.wfile.getvalue().partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    hs = {k.lower(): v for k, v in (ln.split(": ", 1) for ln in lines[1:] if ": " in ln)}
    return int(lines[0].split()[1]), hs.get("content-type", ""), payload


steps = []


def view():
    """The data folder as sync sees it: per root (DATA, and each workspace in .accounts), its puzzle files and profile
    list (sync.local), and the files of its profiles and its base (meta.json and the base word for word)."""
    roots = [""]
    if (DATA / ".accounts").is_dir():
        roots += [f".accounts/{p.name}" for p in sorted((DATA / ".accounts").iterdir())]
    out = {}
    for r in roots:
        d = DATA / r if r else DATA
        files = {}
        for p in sorted(d.rglob("*")):
            rel = p.relative_to(d).as_posix()
            if not p.is_file() or p.suffix == ".jsonl" or not (rel.startswith("profiles/") or rel == sync.BASE):
                continue
            files[rel] = p.read_text(encoding="utf-8") if p.name in ("meta.json", sync.BASE) else True
        local = sync.local(d)
        if r and not files and not local:
            continue
        out[r] = {"local": local, "files": files}
    return out


def req(method, path, body=None, raw=None, headers=None, upstream=(), lenient=False, data=False):
    TAPE.replies, TAPE.seen = list(upstream), []
    payload = raw if raw is not None else json.dumps(body).encode() if body is not None else b""
    status, ctype, out = call(method, path, payload, headers)
    assert not TAPE.replies, f"{method} {path}: replies left over"
    step = {"method": method, "path": path, "body": payload.decode(), "headers": headers or {}, "status": status,
            "type": ctype.split(";")[0], "upstream": TAPE.seen, "opened": OPENED[:], "token": account.load_token()}
    OPENED.clear()
    if ctype.startswith("application/json"):
        step["json"] = json.loads(out)
    elif ctype.startswith("text/"):
        step["text"] = out.decode()
    else:
        step["b64"] = base64.b64encode(out).decode()
    if lenient:
        step["lenient"] = True      # an error worded by Python's own libraries: status and an "error" key only
    if data:
        step["view"] = view()
    steps.append(step)
    return step.get("json")


def seed(files: dict):
    for rel, text in files.items():
        (DATA / rel).parent.mkdir(parents=True, exist_ok=True)
        (DATA / rel).write_text(text, encoding="utf-8")
    steps.append({"seed": files, "view": view()})


def jsonl(*rows):
    return "".join(json.dumps(r) + "\n" for r in rows)


def lines(*rows):
    return [json.dumps(r) for r in rows]


# the lines each writer writes (puzzles.record, own_puzzles.record, packs.mark_solved, packs.record_daily)
def lib(pid, ts, solved=True, ms=4000, hinted=False, rating=1500):
    return {"id": pid, "ts": ts, "solved": solved, "ms": ms, "hinted": hinted, "rating": rating}


def own(pid, ts, solved=True, ms=None, hinted=False):
    return {"id": pid, "ts": ts, "solved": solved, "ms": ms, "hinted": hinted}


def daily(date, n, pid, solved=True, clean=True, ms=5000, marks=()):
    return {"date": date, "n": n, "id": pid, "solved": solved, "clean": clean, "ms": ms, "marks": list(marks)}


def meta(source, username, created, **more):
    return json.dumps({"source": source, "username": username, "created": created, **more})


def profile_line(source, username, added, pinned=None):
    return json.dumps({"added": added, "pinned": pinned, "source": source, "username": username}, sort_keys=True)


# ---------- the steps ----------

def settings_steps():
    req("GET", "/api/settings")
    req("POST", "/api/settings", {"volume": "0.5", "theme": "dark"})
    req("GET", "/api/settings")
    req("POST", "/api/settings", {"theme": None, "board": "green", "é": "ü"})
    req("POST", "/api/settings", [1])
    req("POST", "/api/settings", {"x": 1})
    req("POST", "/api/settings", {"x": True})
    req("GET", "/api/settings")
    steps.append({"file": "settings.json", "text": (DATA / "settings.json").read_text(encoding="utf-8")})


def image_steps():
    png = b"\x89PNG\r\n\x1a\n" + bytes(range(40))
    url = "https://img.example/board.png"
    req("GET", "/api/fetch_image")
    req("GET", "/api/fetch_image?url=ftp://img.example/x.png")
    req("GET", "/api/fetch_image?url=" + url, upstream=[reply(200, png, "image/png")])
    req("GET", "/api/fetch_image?url=" + url, upstream=[reply(200, b"<html></html>", "text/html; charset=utf-8")])
    req("GET", "/api/fetch_image?url=" + url, upstream=[reply(200, b"???", None)])
    req("GET", "/api/fetch_image?url=https://img.example/missing.png", upstream=[reply(404, b"no", "text/plain")])
    req("GET", "/api/fetch_image?url=http://img.example/broken", upstream=[reply(503, b"down", "text/plain")])
    req("GET", "/api/fetch_image?url=" + url, upstream=[offline()])
    big = reply(200, b"", "image/jpeg")
    del big["b64"]
    big["zeros"] = serve.MAX_IMAGE_BYTES + 1
    req("GET", "/api/fetch_image?url=" + url, upstream=[big])
    exact = dict(big, zeros=serve.MAX_IMAGE_BYTES)
    out = req("GET", "/api/fetch_image?url=" + url, upstream=[exact])
    steps[-1].pop("b64")        # ten megabytes of zeros: the length says enough
    steps[-1]["length"] = serve.MAX_IMAGE_BYTES
    assert out is None


def account_steps():
    me_out = {"user": None}
    alice = {"user": {"id": "u1", "email": "alice@example.com"}, "progress": True}
    req("GET", "/account/me", upstream=[reply(200, me_out)])
    req("GET", "/account/me", headers={"Host": f"evil.example:{PORT}"})
    req("GET", "/account/me", headers={"Origin": "https://evil.example"})
    req("GET", "/account/me", headers={"Host": f"localhost:{PORT}", "Origin": f"http://localhost:{PORT}"},
        upstream=[reply(200, me_out)])
    req("GET", "/account/me", upstream=[offline()])
    req("GET", "/account/me", upstream=[reply(500, b"boom", "text/plain")])

    # a provider sign-in: started here, finished in the browser, which comes back to /account/callback
    req("POST", "/account/app/login/lichess", {"mode": "login", "consent": True},
        upstream=[reply(200, {"url": "/account/app/go?resume=ST1&x=1"})])
    req("GET", "/account/callback?state=WRONG&code=C1")
    req("GET", "/account/callback?state=ST1&code=C1&account=signed-in", upstream=[reply(200, {"token": "T1"})])
    req("GET", "/account/callback?state=ST1&code=C1&account=signed-in")       # once only
    req("GET", "/account/me", upstream=[reply(200, alice)])
    req("GET", "/account/me", upstream=[reply(200, alice)])                     # the outcome is told once
    req("POST", "/account/progress", {"files": {"a": ["1"]}}, upstream=[reply(200, {"ok": True}, "application/json; charset=utf-8")])
    req("GET", "/account/whatever?x=1", upstream=[reply(404, b"nope", "text/plain")])
    req("POST", "/account/app/export", upstream=[reply(200, {"user": "u1", "files": {}})])
    steps[-1]["saved"] = (DATA / "blundr-account.json").read_text(encoding="utf-8")
    req("POST", "/account/app/export", upstream=[reply(403, {"error": "no"})])
    req("GET", "/account/me", upstream=[reply(401, {"error": "signed out"})])   # the session ended elsewhere
    req("GET", "/account/me", upstream=[reply(200, me_out)])

    # the other sign-ins: refused, cancelled, a code the Worker won't swap, no resume, a Worker that says no
    req("POST", "/account/app/login/google", {"mode": "signup"}, upstream=[reply(200, {"url": "/account/app/go?resume=ST2"})])
    req("GET", "/account/callback?state=ST2&account=cancelled")
    req("GET", "/account/me", upstream=[reply(200, me_out)])
    req("POST", "/account/app/login/google", upstream=[reply(200, {"url": "/account/app/go?resume=ST3"})])
    req("GET", "/account/callback?state=ST3&code=C3&account=welcome", upstream=[reply(400, {"error": "bad code"})])
    req("GET", "/account/me", upstream=[reply(200, me_out)])
    req("POST", "/account/app/login/google", upstream=[reply(200, {"url": "/account/app/go?resume=ST4"})])
    req("GET", "/account/callback?state=ST4&account=strange")
    req("POST", "/account/app/login/google", upstream=[reply(200, {"url": "/account/app/go?resume="})])
    req("POST", "/account/app/login/google", upstream=[reply(200, {"nourl": 1})])
    req("POST", "/account/app/login/google", upstream=[reply(403, {"error": "app sign-in is off"})])
    req("POST", "/account/app/login/google", upstream=[offline()])
    req("POST", "/account/app/login/google", raw=b"{nope", lenient=True)

    # email and password: the token stays here
    req("POST", "/account/email/login", {"email": "a@b", "password": "pw"},
        upstream=[reply(200, {"token": "T2", "user": {"id": "u1"}})])
    req("POST", "/account/email/check", {"email": "a@b"}, upstream=[reply(201, {"exists": True})])
    req("POST", "/account/email/check", {"email": "a@b"}, upstream=[reply(200, b"plain", "text/plain")])
    req("POST", "/account/email/login", {"email": "a@b", "password": "x"}, upstream=[reply(400, {"error": "wrong password"})])
    req("POST", "/account/logout", upstream=[reply(200, {"ok": True})])
    req("POST", "/account/email/login", {"email": "a@b", "password": "pw"},
        upstream=[reply(200, {"token": "T3", "user": {"id": "u1"}})])
    req("POST", "/account/logout", upstream=[offline()])
    req("POST", "/account/email/login", {"email": "a@b", "password": "pw"},
        upstream=[reply(200, {"token": "T4", "user": {"id": "u1"}})])
    req("POST", "/account/delete", upstream=[reply(400, {"error": "confirm"})])
    req("POST", "/account/delete", raw=b"", upstream=[reply(200, {"ok": True})])
    req("GET", "/account/me", upstream=[reply(200, me_out)])


def sync_steps():
    created = "2026-01-01T00:00:00+00:00"
    l1, l2, l3 = lib("L1", 10), lib("L2", 20, solved=False, ms=None), lib("L3", 15, hinted=True, solved=False)
    r1 = lib("R1", 5)
    a1, a2 = own("chesscom-alice-1", 100, ms=900), own("chesscom-alice-2", 200, solved=False)
    p1 = own("pgn-pasted-games-1", 300)
    s1, s2 = {"id": "S1", "ts": 30}, {"id": "S2", "ts": 40}
    d1, d2 = daily("2026-10-01", 1, "x1", marks=["a", "b"]), daily("2026-10-02", 2, "x2", solved=False, clean=False, ms=None)
    seed({
        "profiles/chesscom-alice/meta.json": meta("chesscom", "Alice", created),
        "profiles/chesscom-alice/site/games.json": '{"games": []}',
        "profiles/chesscom-alice/puzzle_attempts.jsonl": jsonl(a1, a2),
        "profiles/lichess-bob/meta.json": meta("lichess", "bob", "2026-01-02T00:00:00+00:00", pinned="2026-02-01T00:00:00+00:00"),
        "profiles/pgn-pasted-games/meta.json": meta("pgn", "Pasted games", created),
        "profiles/pgn-pasted-games/puzzle_attempts.jsonl": jsonl(p1),
        "puzzle_attempts.jsonl": jsonl(l1, l2),
        "puzzle_attempts.reset-20260101-000000.jsonl": jsonl(r1),
        "puzzle_solved.jsonl": jsonl(s1),
        "puzzle_daily.jsonl": jsonl(d1),
    })
    req("POST", "/api/sync/state", {}, data=True)
    req("POST", "/api/sync/delta", {}, data=True)
    delta = req("POST", "/api/sync/delta", {"user": "u1"}, data=True)
    req("POST", "/api/sync/switch", {"user": "u1", "keep": True}, data=True)
    req("POST", "/api/sync/state", {}, data=True)

    # the account answers with what it got plus another browser's: a profile, a pin, its own puzzles, a second try
    theirs = {f: list(v) for f, v in delta["add"].items()}
    theirs["puzzle_attempts.jsonl"] += lines(l3, lib("L2", 25))
    theirs["puzzle_daily.jsonl"] = lines(d2) + theirs["puzzle_daily.jsonl"]
    theirs["profiles.jsonl"] = [profile_line("chesscom", "Alice", created, "2026-04-01T00:00:00+00:00"),
                                profile_line("lichess", "carol", "2026-03-01T00:00:00+00:00"),
                                *[ln for ln in theirs["profiles.jsonl"] if "Alice" not in ln]]
    theirs["profiles/lichess-carol/puzzle_attempts.jsonl"] = lines(own("lichess-carol-1", 50))
    req("POST", "/api/sync/commit", {"user": "u1", "files": theirs}, data=True)
    req("POST", "/api/sync/delta", {"user": "u1"}, data=True)
    req("POST", "/api/sync/state", {}, data=True)

    # bob deleted elsewhere, and the library reset there: L1 moved into an archive
    here = sync.local(DATA)
    theirs2 = {f: list(v) for f, v in here.items()}
    theirs2["profiles.jsonl"] = [ln for ln in here["profiles.jsonl"] if "bob" not in ln]
    moved = [ln for ln in here["puzzle_attempts.jsonl"] if '"L1"' in ln]
    theirs2["puzzle_attempts.jsonl"] = [ln for ln in here["puzzle_attempts.jsonl"] if '"L1"' not in ln]
    theirs2["puzzle_attempts.reset-20261001-000000.jsonl"] = moved
    req("POST", "/api/sync/commit", {"user": "u1", "files": theirs2}, data=True)

    # solved here meanwhile: it stays, and goes up with the next sync
    seed({"puzzle_solved.jsonl": jsonl(s1, s2)})
    req("POST", "/api/sync/delta", {"user": "u1"}, data=True)
    req("POST", "/api/sync/commit", {"user": "u1", "files": theirs2}, data=True)

    # logged out: u1's data set aside; the guest plays a little
    req("POST", "/api/sync/switch", {"user": None}, data=True)
    req("POST", "/api/sync/state", {}, data=True)
    seed({
        "puzzle_attempts.jsonl": jsonl(lib("L9", 90), lib("L3", 16)),
        "puzzle_daily.jsonl": jsonl(daily("2026-10-01", 1, "x1", solved=False, clean=False), d1),     # the day twice
        "puzzle_solved.jsonl": jsonl({"id": "S1", "ts": 31}, {"id": "S9", "ts": 2}),
        "profiles/chesscom-alice/meta.json": meta("chesscom", "alice", "2026-05-01T00:00:00+00:00"),
        "profiles/chesscom-alice/puzzle_attempts.jsonl": jsonl(own("chesscom-alice-9", 900)),
        "profiles/chesscom-alice/site/games.json": '{"games": [1]}',
        "profiles/chesscom-alice/site/insights.html": "<p>guest</p>",
        "profiles/pgn-pasted-games/puzzle_attempts.jsonl": jsonl(own("pgn-pasted-games-2", 301)),
    })
    req("POST", "/api/sync/state", {}, data=True)
    req("POST", "/api/sync/switch", {"user": "u1"}, data=True)          # the guest's aside, u1's back
    req("POST", "/api/sync/switch", {"user": "u1"}, data=True)          # already
    req("POST", "/api/sync/switch", {"user": "u2"}, data=True)
    req("POST", "/api/sync/commit", {"user": "u2", "files": {"puzzle_attempts.jsonl": lines(lib("U2", 1))}}, data=True)
    req("POST", "/api/sync/switch", {"user": "bad id!"}, data=True)     # u2's set aside before the name is refused
    req("POST", "/api/sync/state", {}, data=True)
    req("POST", "/api/sync/switch", {"user": "u1"}, data=True)

    # u1's account deleted: its copy becomes the guest's, and what the guest had set aside joins it
    req("POST", "/api/sync/release", {}, data=True)
    req("POST", "/api/sync/state", {}, data=True)
    req("POST", "/api/sync/switch", {"user": "u2"}, data=True)
    req("POST", "/api/sync/switch", {"user": None, "wipe": True}, data=True)
    req("POST", "/api/sync/switch", {"user": "u2"}, data=True)
    req("POST", "/api/sync/release", {"wipe": True}, data=True)

    # what it refuses
    req("POST", "/api/sync/commit", {"user": "u3", "files": ["x"]}, data=True)
    req("POST", "/api/sync/commit", {"user": "u3", "files": {"puzzle_solved.jsonl": ["not json"]}}, data=True)
    req("POST", "/api/sync/commit", {"user": "u3", "files": {"profiles.jsonl": ["{nope"]}}, data=True)
    req("POST", "/api/sync/commit", {"user": "u3", "files": {"puzzle_solved.jsonl": ['{"id": "S7", "ts": 7}', 5]}},
        lenient=True, data=True)        # a line that isn't an object: a 500, worded by each language
    req("POST", "/api/sync/commit", {"user": "u3", "files": {"notes.txt": ["{}"], "puzzle_solved.jsonl": ['{"id": "S7", "ts": 7}']}},
        data=True)
    req("POST", "/api/sync/nope", {"user": "u3"}, data=True)
    req("POST", "/api/sync/state", raw=b"{nope", data=True)
    req("POST", "/api/sync/switch", {"user": 7}, data=True)
    req("POST", "/api/sync/switch", {"user": None}, data=True)


def zipped(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def release(tag, assets, body="", published="2026-10-01T10:00:00Z", **more):
    return {"tag_name": tag, "html_url": f"https://github.com/aris-ver/chess-review/releases/tag/{tag}", "body": body,
            "published_at": published, "draft": False, "prerelease": False,
            "assets": [{"name": n, "browser_download_url": f"https://github.com/dl/{tag}/{n}", "size": s} for n, s in assets],
            **more}


def new_updater(installed):
    u = updater.Updater()
    u.installed = installed
    serve.Handler.updates = u
    steps.append({"updater": {"installed": installed, "platform": "win32"}})


def drain(upstream):
    TAPE.replies, TAPE.seen = list(upstream), []
    for t in LaterThread.pending:
        t.target(*t.args)
    LaterThread.pending.clear()
    assert not TAPE.replies
    steps.append({"drain": True, "upstream": TAPE.seen})


def updater_steps():
    req("GET", "/api/update")          # a checkout, or the website: no updates
    req("POST", "/api/update/download")
    req("POST", "/api/update/apply")

    small = zipped({"Blundr/Blundr.exe": b"MZ", "Blundr/_internal/build.json": b"{}", "Blundr/_internal/chess_review/x.py": b""})
    notes = "Download it below.\n\n## What's new\n- faster\n- fixed a thing\n\n**Full changelog**: x\n"
    latest = release("v0.7.0", [("chess-review-update-rt1.zip", len(small)), ("Blundr-windows.zip", 250_000_000)], notes)
    releases = [
        latest,
        release("v0.6.5", [], "## What's new\nsmaller\n## Other\nno", "2026-09-01T00:00:00Z"),
        release("v0.6.9-beta", [], "beta", prerelease=True),
        release("v0.6.8", [], "draft", draft=True),
        release("v0.6.1", [], "mine"),
        release("v0.8.0", [], "later"),
        release("nightly", [], "?"),
        release("v0.6.2", [], "no heading at all\n", None),
    ]
    new_updater({"version": "v0.6.1", "runtime": "rt1"})
    req("GET", "/api/update", upstream=[reply(200, latest), reply(200, releases)])
    req("GET", "/api/update")                                   # checked within the hour: no request
    req("POST", "/api/update/apply")
    req("GET", "/api/update?check=1", upstream=[reply(200, latest), reply(200, releases)])
    req("POST", "/api/update/download")
    req("POST", "/api/update/download")                         # under way
    req("GET", "/api/update")
    drain([reply(200, small, "application/zip", {"Content-Length": str(len(small))})])
    req("GET", "/api/update")
    req("POST", "/api/update/download")                         # ready
    req("POST", "/api/update/apply")

    new_updater({"version": "v0.7.0", "runtime": "rt1"})         # up to date
    req("GET", "/api/update", upstream=[reply(200, latest)])
    req("POST", "/api/update/download")

    new_updater({"version": "v0.6.1", "runtime": "rt0"})         # another runtime: the full zip; the list fails
    req("GET", "/api/update", upstream=[reply(200, latest), offline("fake: no list")])
    req("POST", "/api/update/download")
    drain([reply(404, b"gone", "text/plain")])
    req("GET", "/api/update")
    req("POST", "/api/update/download")                         # after an error: again
    drain([offline("fake: cut off")])
    req("GET", "/api/update")

    new_updater({"version": "v0.6.1", "runtime": None})
    req("GET", "/api/update", upstream=[reply(200, release("v0.7.0", [("other.zip", 1)]))])     # nothing to download
    req("GET", "/api/update?check=1", upstream=[reply(404, {"message": "Not Found"})])
    req("GET", "/api/update?check=1", upstream=[offline("fake: offline")])
    req("POST", "/api/update/download")


def main():
    app = SCRATCH / "app"
    app.mkdir()
    (app / "book_keys.txt").write_text("", encoding="utf-8")
    bridge.setup(str(app), types.SimpleNamespace(size=1, name="none"))
    settings_steps()
    image_steps()
    account_steps()
    sync_steps()
    updater_steps()
    OUT.write_text(json.dumps({"port": PORT, "steps": steps}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(steps)} steps")


main()
