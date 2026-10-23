"""The browser version end to end: web-dist/ served on localhost, Pyodide from its CDN, in headless Chromium
(Playwright), with chess.com and lichess answered by fakes routed inside the browser. What the CPython bridge tests
can't reach: the real pyfetch and stream reading in chess_web.runner.js_fetch, what a dropped connection raises
there, and the page around it (adding a profile, "Load older games", a site's "slow down", the errors).

Needs `pip install playwright` and a Chromium it can launch (`playwright install chromium`, plus its system libraries:
`playwright install-deps chromium`), and the network for Pyodide. Skips without them. Slow (a minute or so): Python
loads in the page first.
"""

import functools
import json
import re
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
pw = pytest.importorskip("playwright.sync_api")

PGN = (ROOT / "tests" / "fixtures" / "clocks.pgn").read_text().split("\n\n[Event")[0]
CHESSCOM = "https://api.chess.com/pub/player/"
CORS = {"Access-Control-Allow-Origin": "*"}     # no Access-Control-Expose-Headers: Retry-After stays unreadable, as on chess.com
LITE = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36"


def chesscom_months(user: str, months: dict) -> dict:
    """{'2026-09': n} -> {url: archive body} for `user`, n distinct games a month (the fixture's, renamed)."""
    pgn = PGN.replace("testuser", user)
    out = {}
    for key, n in months.items():
        y, m = key.split("-")
        out[f"{CHESSCOM}{user}/games/{y}/{m}"] = {"games": [
            {"url": f"https://www.chess.com/game/live/{y}{m}{i:03}", "pgn": pgn, "time_control": "180+2",
             "end_time": 1780000000 + int(y + m) * 100 + i, "rules": "chess", "time_class": "blitz",
             "white": {"username": "someone", "rating": 1500, "result": "win"},
             "black": {"username": user, "rating": 1480, "result": "checkmated"}} for i in range(n)]}
    out[f"{CHESSCOM}{user}/games/archives"] = {"archives": sorted(u for u in out)}
    return out


def lichess_games(user: str, n: int) -> list[dict]:
    pgn = PGN.replace("testuser", user)
    return [{"id": f"li{i:04}", "rated": True, "variant": "standard", "speed": "blitz", "createdAt": 1780000000000 + i * 86_400_000,
             "status": "mate", "winner": "white",
             "players": {"white": {"user": {"name": "someone", "id": "someone"}, "rating": 1500},
                         "black": {"user": {"name": user, "id": user}, "rating": 1480}},
             "clock": {"initial": 180, "increment": 2}, "pgn": pgn} for i in range(n)]


class Sites:
    """chess.com and lichess as the page's fetch sees them. `fail[url]` lists what to do the next times that URL is
    asked for instead of answering: "drop" (the connection fails) or a status code."""

    def __init__(self):
        self.chesscom: dict = {}
        self.lichess: dict[str, list] = {}
        self.fail: dict[str, list] = {}
        self.asked: list[str] = []

    def route(self, route):
        url = route.request.url
        self.asked.append(url)
        base = url.split("?")[0]
        todo = self.fail.get(base)
        if todo:
            what = todo.pop(0)
            return route.abort("internetdisconnected") if what == "drop" else route.fulfill(status=what, headers=CORS, body="{}")
        if base in self.chesscom:
            return route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps(self.chesscom[base]))
        m = re.match(r"https://lichess\.org/api/(user|games/user)/([^/?]+)", base)
        if m and m.group(2) in self.lichess:
            games = self.lichess[m.group(2)]
            if m.group(1) == "user":
                return route.fulfill(status=200, headers=CORS, content_type="application/json",
                                     body=json.dumps({"id": m.group(2), "count": {"all": len(games)}}))
            q = dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&"))
            out = [g for g in games if int(q.get("since", 0)) <= g["createdAt"] <= int(q.get("until", 1 << 60))]
            if q.get("sort") == "dateDesc":
                out = out[::-1]
            out = out[:int(q.get("max", len(out)))]
            return route.fulfill(status=200, headers=CORS, content_type="application/x-ndjson",
                                 body="".join(json.dumps(g) + "\n" for g in out))
        route.fulfill(status=404, headers=CORS, body='{"message": "not found"}')


@pytest.fixture(scope="module")
def site():
    import subprocess
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    from build_web import OUT, PYODIDE, _Handler
    try:
        urllib.request.urlopen(PYODIDE + "pyodide.mjs", timeout=10).close()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no network for Pyodide: {e}")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_web.py")], check=True, capture_output=True)
    quiet = type("Quiet", (_Handler,), {"log_message": lambda *_: None})
    srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(quiet, directory=str(OUT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}/"
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"no Chromium to launch: {str(e).splitlines()[0]}")
        yield b
        b.close()


@pytest.fixture
def app(site, browser):
    sites = Sites()
    ctx = browser.new_context(user_agent=LITE, viewport={"width": 1200, "height": 900})
    ctx.route(re.compile(r"https://(api\.chess\.com|lichess\.org)/.*"), sites.route)
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and print("console:", m.text))
    page.goto(site)
    page.wait_for_function("document.querySelector('#profiles .empty') && !/Loading/.test(document.querySelector('#profiles').textContent)",
                           timeout=180_000)
    yield page, sites
    ctx.close()


def add(page, source: str, user: str) -> None:
    if page.locator("#addcard").is_hidden():
        page.click("#b-addprofile")
    page.select_option("#addform select[name=source]", source)
    page.fill("#addform input[name=username]", user)
    page.click("#addform button[type=submit]")


def toast(page, text: str, timeout=60_000) -> None:
    page.wait_for_function("t => document.getElementById('toast').textContent.includes(t)", arg=text, timeout=timeout)


def test_a_chesscom_profile_a_page_at_a_time(app):
    page, sites = app
    sites.chesscom.update(chesscom_months("paged", {"2026-07": 15, "2026-08": 12, "2026-09": 10}))
    add(page, "chesscom", "paged")
    page.wait_for_url(re.compile(r"#/p/chesscom-paged$"), timeout=60_000)      # opens by itself once its games are in
    page.wait_for_function("/22 of 22 games/.test(document.getElementById('liststat').textContent)")
    assert "older ones not loaded yet" in page.text_content("#liststat")
    assert not any(u.endswith("/2026/07") for u in sites.asked)                # September and August make a page

    sites.fail[f"{CHESSCOM}paged/games/2026/07"] = ["drop"]                     # the connection drops: try again
    page.click("#b-older")
    page.wait_for_function("document.getElementById('b-older').textContent === 'Try again'", timeout=60_000)
    assert "Couldn't load older games: couldn't reach api.chess.com" in page.text_content("#older-note")
    page.click("#b-older")
    page.wait_for_function("/37 of 37 games/.test(document.getElementById('liststat').textContent)", timeout=60_000)
    assert page.locator("#older").is_hidden()                                   # July was the first month: nothing older


def test_a_lichess_profile_a_page_at_a_time(app):
    page, sites = app
    sites.lichess["pagedli"] = lichess_games("pagedli", 26)
    add(page, "lichess", "pagedli")
    page.wait_for_url(re.compile(r"#/p/lichess-pagedli$"), timeout=60_000)
    page.wait_for_function("/20 of 20 games/.test(document.getElementById('liststat').textContent)")
    page.click("#b-older")
    page.wait_for_function("/26 of 26 games/.test(document.getElementById('liststat').textContent)", timeout=60_000)
    assert page.locator("#older").is_hidden()


def test_a_429_is_waited_out_and_said(app):
    page, sites = app
    sites.chesscom.update(chesscom_months("slow", {"2026-09": 3}))
    sites.fail[f"{CHESSCOM}slow/games/archives"] = [429]
    add(page, "chesscom", "slow")
    page.wait_for_function("[...document.querySelectorAll('#profiles .meta')].some(m => /chess.com asked to slow down: trying again in 2 s/.test(m.textContent))",
                           timeout=30_000)
    page.wait_for_url(re.compile(r"#/p/chesscom-slow$"), timeout=60_000)


def test_failures_say_why_and_only_an_unknown_player_is_removed(app):
    page, sites = app
    add(page, "chesscom", "nobody")
    toast(page, "chess.com has no user called nobody")
    page.wait_for_function("!document.querySelector('#profiles .card.profile[data-id=chesscom-nobody]')")

    sites.chesscom.update(chesscom_months("dropped", {"2026-09": 3}))
    sites.fail[f"{CHESSCOM}dropped/games/2026/09"] = ["drop"]
    add(page, "chesscom", "dropped")
    toast(page, "Couldn't fetch dropped's games: couldn't reach api.chess.com")
    assert page.locator("#profiles .card.profile[data-id=chesscom-dropped]").count() == 1


def test_a_reload_keeps_the_games_and_the_count_played(app):
    page, sites = app
    sites.chesscom.update(chesscom_months("kept", {"2026-08": 12, "2026-09": 10}))
    sites.chesscom[f"{CHESSCOM}kept/stats"] = {"chess_blitz": {"record": {"win": 700, "loss": 600, "draw": 34}}}
    add(page, "chesscom", "kept")
    page.wait_for_url(re.compile(r"#/p/chesscom-kept$"), timeout=60_000)
    page.wait_for_function("/22 of 22 games · 1,334 played in all/.test(document.getElementById('liststat').textContent)")
    asked = len(sites.asked)
    page.wait_for_timeout(2000)                         # IndexedDB is written half a second after the last change
    page.goto(page.url.split("#")[0])
    page.wait_for_function("document.querySelector('#profiles .card.profile[data-id=chesscom-kept]')", timeout=180_000)
    assert "1,334 games" in page.text_content("#profiles .card.profile[data-id=chesscom-kept] .meta")
    page.click("#profiles .card.profile[data-id=chesscom-kept]")
    page.wait_for_function("/22 of 22 games/.test(document.getElementById('liststat').textContent)", timeout=60_000)
    assert sites.asked[asked:] == []                    # all from this browser: nothing asked of chess.com again
