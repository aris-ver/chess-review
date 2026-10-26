"""The browser version end to end: web-dist/ served on localhost in headless Chromium (Playwright), the JS server in
the tabs' worker (js/web/worker.js), with chess.com and lichess answered by fakes routed inside the browser. What the
Node tests can't reach: the real fetch and stream reading from a worker, OPFS, the page around it (adding a profile,
"Load older games", a site's "slow down", the errors), several tabs on one database, the one-time move from the
Python build's IndexedDB (which needs the network for Pyodide), and a review with WASM Stockfish against the desktop's.

Needs `pip install pytest playwright` and a Chromium it can launch (`playwright install chromium`, plus its system
libraries: `playwright install-deps chromium`), and Node >= 22.13 to build the site (scripts/build_web.js). Skips without
them. The one-time move also needs duckdb (legacy/make_fixture.py writes the Python build's data).

Chromium runs with the GPU off: under WSL it finds WSLg's GPU (/dev/dxg) and then never draws a frame, so
requestAnimationFrame and HTMLImageElement.decode() never resolve, and the page (which decodes the board's image
before its first route) waits forever on "Loading your profiles".
"""

import base64
import functools
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
pw = pytest.importorskip("playwright.sync_api")
DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
STOCKFISH = ROOT / "bin" / ("stockfish.exe" if sys.platform == "win32" else "stockfish")
CHROMIUM_ARGS = ["--disable-gpu", "--disable-software-rasterizer"]
OUT = ROOT / "web-dist"
# the home screen drawn and shown: the splash (#boot) gone, which it waits for
READY = "document.documentElement.classList.contains('booted') && document.querySelector('#profiles .card.profile, #profiles .empty') && !/Loading/.test(document.querySelector('#profiles').textContent)"

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


class _Handler(SimpleHTTPRequestHandler):
    """web-dist/ as scripts/build_web.js --serve serves it: never cached, the right types, no log."""
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript",
                      ".mjs": "text/javascript", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".webp": "image/webp"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *_):
        pass


@pytest.fixture(scope="module")
def site():
    node = node22()
    if node is None:
        pytest.skip("needs Node >= 22.13 to build the site")
    subprocess.run([node, str(ROOT / "scripts" / "build_web.js")], check=True, capture_output=True)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_Handler, directory=str(OUT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}/"
    srv.shutdown()


@pytest.fixture(scope="module")
def pwr():
    with pw.sync_playwright() as p:
        yield p


@pytest.fixture(scope="module")
def browser(pwr):
    try:
        b = pwr.chromium.launch(args=CHROMIUM_ARGS)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no Chromium to launch: {str(e).splitlines()[0]}")
    yield b
    b.close()


@pytest.fixture(scope="module")
def webkit(pwr):
    """Playwright's WebKit, for what an iPhone does differently. Its GL in software: under WSL it finds WSLg's GPU
    and hangs on the first page, as Chromium does (which runs with the GPU off). Needs `playwright install webkit`
    and its system libraries (`playwright install-deps webkit`); skips without them."""
    try:
        b = pwr.webkit.launch(env={**os.environ, "LIBGL_ALWAYS_SOFTWARE": "1"})
        b.new_page().close()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no WebKit to launch: {str(e).splitlines()[0]}")
    yield b
    b.close()


@pytest.fixture(params=["chromium", "webkit"])
def engine(request):
    """(name, browser): the test runs in Chromium and in WebKit (as on an iPhone)."""
    return request.param, request.getfixturevalue("browser" if request.param == "chromium" else "webkit")


def phone_of(pwr, engine_name: str, **chromium_phone) -> dict:
    """New-context options for a phone: Playwright's iPhone 13 in WebKit, the given ones in Chromium."""
    if engine_name == "webkit":
        d = dict(pwr.devices["iPhone 13"])
        d.pop("default_browser_type", None)
        return d
    return chromium_phone


def throttle(ctx, page, engine_name: str, rate=4) -> None:
    """A slow phone's CPU (Chromium only: WebKit has no such switch)."""
    if engine_name == "chromium":
        ctx.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": rate})


@pytest.fixture
def app(site, browser):
    sites = Sites()
    ctx = browser.new_context(user_agent=LITE, viewport={"width": 1200, "height": 900})
    ctx.route(re.compile(r"https://(api\.chess\.com|lichess\.org)/.*"), sites.route)
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and print("console:", m.text))
    page.goto(site)
    page.wait_for_function("document.documentElement.classList.contains('booted') && document.querySelector('#profiles .empty') && !/Loading/.test(document.querySelector('#profiles').textContent)",
                           timeout=60_000)
    yield page, sites
    ctx.close()


def api(page, path: str, body=None):
    """The page's own fetch (through web/shim.js to the worker): (status, JSON)."""
    return page.evaluate("""async ([path, body]) => {
        const r = await fetch(path, body === null ? {} : { method: 'POST', body: JSON.stringify(body) });
        return [r.status, await r.json()];
    }""", [path, body])


def wait_job(page, timeout_s=600) -> dict:
    """api/status polled until the job and the queue are done."""
    for _ in range(timeout_s):
        s = api(page, "api/status")[1]
        if not (s.get("job") and s["job"]["status"] in ("queued", "running", "finishing")) and not s.get("queue"):
            return s
        page.wait_for_timeout(1000)
    raise TimeoutError(f"job still going after {timeout_s} s: {s}")


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
    page.goto(page.url.split("#")[0])                   # OPFS is written as the server writes: nothing to wait for
    page.wait_for_function("document.querySelector('#profiles .card.profile[data-id=chesscom-kept]')", timeout=60_000)
    assert "1,334 games" in page.text_content("#profiles .card.profile[data-id=chesscom-kept] .meta")
    page.click("#profiles .card.profile[data-id=chesscom-kept]")
    page.wait_for_function("/22 of 22 games/.test(document.getElementById('liststat').textContent)", timeout=60_000)
    assert sites.asked[asked:] == []                    # all from this browser: nothing asked of chess.com again


def test_new_games_are_fetched_on_opening_with_no_click(app):
    page, sites = app
    sites.chesscom.update(chesscom_months("busy", {"2026-09": 3}))
    add(page, "chesscom", "busy")
    page.wait_for_url(re.compile(r"#/p/chesscom-busy$"), timeout=60_000)
    page.wait_for_function("/3 of 3 games/.test(document.getElementById('liststat').textContent)")
    wait_job(page)
    sites.chesscom.update(chesscom_months("busy", {"2026-09": 5}))     # two more played since
    page.goto(page.url.split("#")[0])
    card = "#profiles .card.profile[data-id=chesscom-busy]"
    page.wait_for_function(f"/5 games/.test(document.querySelector('{card} .meta')?.textContent)", timeout=60_000)
    assert page.locator(f"{card} .banner, {card} button").count() == 0     # no Fetch to press
    assert "2 not opened yet" in page.text_content(f"{card} .meta")
    s = wait_job(page)
    assert not any(j["kind"].startswith("analyse") for j in [s.get("job") or {"kind": ""}, *s.get("queue", [])])


def test_an_account_switch_moves_a_profiles_database_and_back(app):
    """sync's switch and release on SQLite WASM in OPFS: the databases aren't files there, so a profile's games.sqlite
    goes into .accounts/<who>/ table by table (Sync.copyDb) and comes back the same way."""
    page, sites = app
    sites.chesscom.update(chesscom_months("moved", {"2026-09": 4}))
    add(page, "chesscom", "moved")
    page.wait_for_url(re.compile(r"#/p/chesscom-moved$"), timeout=60_000)
    page.wait_for_function("/4 of 4 games/.test(document.getElementById('liststat').textContent)")
    wait_job(page)

    status, r = api(page, "api/sync/switch", {"user": "someone-else"})
    assert status == 200 and r.get("switched"), r
    assert "chesscom-moved" not in profile_ids(page)                 # set aside in .accounts/guest/ (the owner is
                                                                     # written by the first sync, not here)

    status, r = api(page, "api/sync/release", {})
    assert status == 200 and r.get("released"), r
    assert "chesscom-moved" in profile_ids(page)
    page.goto(page.url.split("#")[0] + "#/p/chesscom-moved")         # the games came back with their database
    page.wait_for_function("/4 of 4 games/.test(document.getElementById('liststat').textContent)", timeout=60_000)


def ready(page, timeout=60_000) -> None:
    page.wait_for_function(READY, timeout=timeout)


# 16 of the forks pack's stage 1 solved, so stage 2 is open too and the ladder opens on it, stage 1 peeking in on the left
OPEN_STAGE_TWO = """async () => {
    const k = (await (await fetch('api/puzzles/pack?id=forks')).json()).pack;
    for (const c of k.stages[0].puzzles.slice(0, 16))
        await fetch('api/puzzles/attempt', { method: 'POST', body: JSON.stringify({ id: c.id, solved: true, hinted: false, ms: 5000 }) });
    location.hash = '#/packs/forks';
}"""
FOCUS = "(document.querySelector('.scard.sel') || {dataset: {}}).dataset.n"


def ladder(browser, site, init=None, **kw):
    ctx = browser.new_context(**kw)
    if init:
        ctx.add_init_script(init)
    page = ctx.new_page()
    page.goto(site)
    ready(page)
    page.evaluate(OPEN_STAGE_TWO)
    page.wait_for_selector(".scard[data-n='2'].sel", timeout=30_000)
    return ctx, page


def settled(page) -> None:
    """Until the track stops moving (a smooth scroll to a stage)."""
    page.wait_for_function("""() => new Promise(done => {
        const tr = document.querySelector('.sttrack'); let x = tr.scrollLeft, still = 0;
        const f = () => { still = tr.scrollLeft === x ? still + 1 : 0; x = tr.scrollLeft; still > 5 ? done(true) : requestAnimationFrame(f); };
        requestAnimationFrame(f);
    })""")


def back_to_ladder(page, n: str) -> None:
    """Back from a puzzle, until the ladder is drawn again (the one left behind is still in the page till then)."""
    page.evaluate("document.querySelector('.sttrack').dataset.old = 1")
    page.go_back()
    page.wait_for_function(f"!document.querySelector('.sttrack').dataset.old && {FOCUS} === '{n}'")


def test_only_the_stage_in_focus_opens_its_puzzles(site, browser):
    ctx, page = ladder(browser, site, viewport={"width": 1280, "height": 900})
    try:
        # a tile of stage 1, peeking in beside stage 2: the click brings stage 1 in and opens nothing
        box = page.locator(".scard[data-n='1'] .tile").nth(5).bounding_box()
        assert box["x"] > 0
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_function(f"{FOCUS} === '1'")
        assert page.evaluate("location.hash") == "#/packs/forks"
        settled(page)
        box = page.locator(".scard[data-n='1'] .tile").nth(5).bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_function("location.hash === '#/packs/forks/1/6'")     # in focus now: it opens
        back_to_ladder(page, "1")                                           # back on the stage looked at
        # no Start/Continue button: the tiles alone open puzzles. Tabbing to a tile of a stage not in focus scrolls
        # that stage in, and Enter then opens its puzzle
        assert page.locator(".scard button").count() == 0
        page.focus(".scard[data-n='2'] .tile.next")
        page.wait_for_function(f"{FOCUS} === '2'")
        assert page.evaluate("location.hash") == "#/packs/forks"
        page.keyboard.press("Enter")
        page.wait_for_function("location.hash === '#/packs/forks/2/1'")
        back_to_ladder(page, "2")
        # the arrow keys step a stage at a time, onto locked ones too, and stop at the ends
        page.evaluate("document.activeElement.blur()")
        for key, n in [("ArrowRight", "3"), ("ArrowRight", "4"), ("ArrowLeft", "3"), ("ArrowLeft", "2"), ("ArrowLeft", "1"), ("ArrowLeft", "1")]:
            page.keyboard.press(key)
            page.wait_for_function(f"{FOCUS} === '{n}'")
        settled(page)
        assert page.evaluate("location.hash") == "#/packs/forks"
    finally:
        ctx.close()


def test_solved_tiles_look_done_and_first_tries_get_a_star(site, browser):
    """Every solved puzzle looks done, first try or not; a first try has a faint star in its corner, the stage card
    counts them by its ring, a stage all of first tries gets a solid star. No totals in the solved counts; the shelf
    says how far a pack went in stages, or what it holds when it's not been played."""
    ctx, page = ladder(browser, site, viewport={"width": 1280, "height": 900})
    try:
        page.evaluate("""async () => {
            const post = (u, b) => fetch(u, { method: 'POST', body: JSON.stringify(b) });
            const forks = (await (await fetch('api/puzzles/pack?id=forks')).json()).pack, c = forks.stages[0].puzzles[16];
            await post('api/puzzles/attempt', { id: c.id, solved: false, hinted: false, ms: 5000 });   // a miss, then found
            await post('api/puzzles/solved', { id: c.id, clean: false });
            const mates = (await (await fetch('api/puzzles/pack?id=mate-in-one')).json()).pack;     // a stage of first tries
            for (const p of mates.stages[0].puzzles) await post('api/puzzles/attempt', { id: p.id, solved: true, hinted: false, ms: 5000 });
            location.hash = '#/packs';
        }""")
        page.wait_for_selector(".card.pack[data-go='#/packs/forks']")
        desc = lambda id: page.locator(f".card.pack[data-go='#/packs/{id}'] .desc").inner_text().strip()
        assert desc("forks") == "Stage 1 under way"
        assert re.fullmatch(r"1 stage done · 1 perfect", desc("mate-in-one")), desc("mate-in-one")
        assert desc("pins") == "The piece in front can't move without losing the one behind."   # not played: what it holds
        assert not re.search(r"\bof \d+ solved", page.locator("#pzpacksbox").inner_text())

        page.evaluate("location.hash = '#/packs/forks'")
        page.wait_for_function("document.querySelectorAll('.scard[data-n=\"1\"] .tile.solved').length === 1")
        one = ".scard[data-n='1']"
        t = page.evaluate(f"""() => [...document.querySelectorAll("{one} .tile")].slice(0, 18).map(e =>
            [e.className.replace(/ ?(next|pressed)/g, '').trim(), !!e.querySelector('.star'), getComputedStyle(e).backgroundColor])""")
        assert all(c == "tile clean" and star for c, star, _ in t[:16]), t[:16]
        assert t[16][:2] == ["tile solved", False] and t[16][2] == t[0][2], t[16]      # done, the same fill, no star
        assert t[17][0] == "tile" and t[17][2] != t[0][2]
        assert page.locator(f"{one} .prog .firsts").inner_text().strip() == "16"
        assert page.locator(f"{one} .prog .firsts.all").count() == 0
        legend = page.locator(".legend").inner_text()
        assert "solved · " in legend and "first try" in legend and "miss" not in legend
        meta = page.locator(".ladhead .meta").inner_text()
        assert re.match(r"17 solved · 16 first try", meta), meta

        page.evaluate("location.hash = '#/packs/mate-in-one'")
        page.wait_for_selector(".scard[data-n='1'] .prog .firsts.all")
        assert "Stage complete" in page.locator(".scard[data-n='1'] .goal").inner_text()
        assert "👑" not in page.locator(".ladder").inner_text()
    finally:
        ctx.close()


# Safari has no scrollsnapchanging: a page without it, to try the way the ladder does without
NO_SNAP_EVENT = ("const add = EventTarget.prototype.addEventListener; EventTarget.prototype.addEventListener = "
                 "function (t, ...r) { if (t !== 'scrollsnapchanging') return add.call(this, t, ...r); };")


@pytest.mark.parametrize("snap_event", [True, False], ids=["scrollsnapchanging", "without it, as Safari"])
def test_a_swiped_stage_lights_once_it_is_sure_to_stop_there(site, browser, snap_event):
    """On a phone (a slow one: the CPU throttled) a fling goes on after the finger lifts, and the browser's snap takes
    a while to bring the stage in. The stage swiped to lights as soon as it is sure to stop there: where the browser
    says where the snap goes, just after the finger lifts; without that, once it's near the middle and down to a
    crawl, before the track stops. Never a stage passed on the way; the one swiped away greys as it goes."""
    ctx, page = ladder(browser, site, init=None if snap_event else NO_SNAP_EVENT, viewport={"width": 412, "height": 915},
                       device_scale_factor=2.6, is_mobile=True, has_touch=True, user_agent=LITE)
    try:
        settled(page)
        page.evaluate("""() => {
            const tr = document.querySelector('.sttrack'), two = tr.querySelector('.scard[data-n="2"]');
            const off = c => { const r = c.getBoundingClientRect(), t = tr.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - (t.left + t.width / 2)) / r.width; };
            window.swipe = { scrolls: [], lit: [] };
            tr.addEventListener('scroll', () => window.swipe.scrolls.push(performance.now()), { passive: true });
            tr.addEventListener('touchend', () => { window.swipe.lift = performance.now(); }, { passive: true });
            new MutationObserver(ms => {
                for (const m of ms) if (m.target.classList.contains('scard') && m.target.classList.contains('sel') && !m.oldValue.includes('sel'))
                    window.swipe.lit.push([m.target.dataset.n, performance.now(), off(m.target)]);
                if (!two.classList.contains('sel') && !window.swipe.dimmed) window.swipe.dimmed = performance.now();
            }).observe(tr, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
        }""")
        cdp = ctx.new_cdp_session(page)
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": 60, "y": 400}]})
        for x in range(90, 360, 30):                    # a finger dragging right: the track scrolls back to stage 1
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": 400}]})
            page.wait_for_timeout(16)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_function(f"{FOCUS} === '1'", timeout=10_000)
        settled(page)
        s = page.evaluate("window.swipe")
        stop = s["scrolls"][-1]
        assert [n for n, _, _ in s["lit"]] == ["1"], f"lit on the way: {s['lit']}"
        _, lit, off = s["lit"][0]
        print(f"phone ({'scrollsnapchanging' if snap_event else 'no scrollsnapchanging'}): stage 1 lit {lit - s['lift']:.0f} ms "
              f"after the finger lifted, {stop - lit:.0f} ms before the track stopped, {off:.0%} of a card from the middle")
        assert s["dimmed"] < stop, "stage 2 stayed lit till the track stopped"
        assert lit < stop, f"stage 1 lit only {lit - stop:.0f} ms after the track stopped"
        if snap_event:
            assert lit - s["lift"] < 80, f"stage 1 lit {lit - s['lift']:.0f} ms after the finger lifted"
        else:
            assert off < .15, f"stage 1 lit {off:.0%} of a card from the middle"
    finally:
        ctx.close()


# a puzzle on screen, its setup move played: then the solver's moves, each once the board is waiting for it, and the
# board's box (x, y, width, height) before the first and after the card has come up
PLAY_THE_SOLUTION = """async () => {
    const until = c => new Promise(r => { const t = setInterval(() => { if (c()) { clearInterval(t); r(); } }, 30); });
    const box = () => { const b = document.getElementById('boardbox').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
    await until(() => pz.p && state.game && state.game.moves.length >= 1 && !state.exploring);
    const before = box();
    for (let i = 1; i < pz.p.moves.length; i += 2) {
        await until(() => state.game.moves.length === i && !state.exploring);
        puzzleMove(pz.p.moves[i].uci);
    }
    await until(() => pz.over === 'done');
    await new Promise(r => setTimeout(r, 300));
    return [before, box()];
}"""


def test_the_board_stays_still_as_a_puzzle_is_solved_on_a_phone(site, pwr, engine):
    """On a phone held upright the board takes the height the rows around it leave: once a puzzle is solved, Skip
    turns into "Next puzzle →", the themes and the game link come in, the daily's result card comes up. None of it may
    move the board (it did by a couple of pixels, the daily's card by 86), on a pack's puzzle, the next one, the daily.
    (WebKit reports no layout shifts: there, the board's box alone.)"""
    name, browser = engine
    ctx = browser.new_context(**phone_of(pwr, name, viewport={"width": 412, "height": 915}, device_scale_factor=2.6, is_mobile=True, has_touch=True, user_agent=LITE))
    page = ctx.new_page()
    try:
        page.goto(site)
        ready(page)
        throttle(ctx, page, name)
        # layout shifts, but the title row's: its counts come in after the first puzzle and widen with the numbers
        page.evaluate("""() => { window.shifted = 0;
            const title = n => n && n.closest && n.closest('.phead, .pzhead');
            new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.sources.some(s => s.node && !title(s.node))) window.shifted += e.value; })
                .observe({ type: 'layout-shift' }); }""")
        for name, go in [("a pack's first", "#/packs/forks/1/1"), ("the next", None), ("the daily", "#/daily")]:
            if go:
                page.evaluate(f"location.hash = '{go}'")
            else:
                page.click("#pzover [data-act=next]")
            page.wait_for_function("document.body.classList.contains('puzzle') && !!pz.p && !pz.done", timeout=30_000)
            page.evaluate("window.shifted = 0")
            before, after = page.evaluate(PLAY_THE_SOLUTION)
            assert after == before, f"{name} puzzle: the board moved from {before} to {after} as it was solved"
            assert page.evaluate("window.shifted") == 0, f"{name} puzzle: layout shift {page.evaluate('window.shifted')} as it was solved"
        assert page.locator("#pzover .dres [data-act=share]").count() == 1      # the daily's result, with its share button, on the card
    finally:
        ctx.close()


def test_on_a_phone_its_own_back_goes_where_the_back_button_did(site, pwr, engine):
    """An iPhone has no Back in the header (its swipe is the back), so the history keeps to the levels the Back button
    goes by: Next and Skip take the puzzle's place, and back from any puzzle of a pack is its ladder. On a desktop (the
    app has no back of its own) the button stays."""
    name, browser = engine
    ctx = browser.new_context(**phone_of(pwr, name, viewport={"width": 412, "height": 915}, device_scale_factor=2.6, is_mobile=True, has_touch=True, user_agent=IPHONE))
    page = ctx.new_page()
    hash_is = lambda h: page.wait_for_function("h => location.hash === h", arg=h, timeout=30_000)
    try:
        page.goto(site)
        ready(page)
        for h in ["#/packs", "#/packs/forks", "#/packs/forks/1/1"]:
            page.evaluate(f"location.hash = '{h}'")
            hash_is(h)
        page.wait_for_function("document.body.classList.contains('puzzle') && !!pz.p", timeout=30_000)
        assert page.locator("#b-back").is_hidden()
        assert page.locator("#b-home").is_visible()
        depth = page.evaluate("history.length")
        for n in (2, 3):
            # the puzzle the address names, on the board and waiting for a move (not the one before it, still
            # there while this one loads)
            page.wait_for_function("pz.hash === location.hash && state.game.moves.length > 0 && !state.exploring", timeout=30_000)
            page.click("#pz-next")                      # Skip: the next puzzle of the stage, in this one's place
            hash_is(f"#/packs/forks/1/{n}")
        assert page.evaluate("history.length") == depth
        for h in ["#/packs/forks", "#/packs", ""]:
            page.go_back()
            hash_is(h)
        desk = browser.new_context(viewport={"width": 1280, "height": 900})
        try:
            d = desk.new_page()
            d.goto(site + "#/packs/forks/1/1")
            d.wait_for_function("document.documentElement.classList.contains('booted') && document.body.classList.contains('puzzle') && !!pz.p", timeout=60_000)
            assert d.locator("#b-back").is_visible()
        finally:
            desk.close()
    finally:
        ctx.close()


# every frame the ladder is seen in, which stage sits in the middle of the track (with "~" when one is only near it)
FRAMES = """() => {
    window.seen = []; window.recording = true;
    const f = () => {
        const box = document.getElementById('pzpacksbox'), tr = box && box.querySelector('.sttrack');
        if (tr && box.offsetParent && getComputedStyle(box).visibility !== 'hidden') {
            const t = tr.getBoundingClientRect(), mid = t.left + t.width / 2;
            let best = null, gap = 1e9;
            for (const c of tr.children) { const r = c.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - mid); if (d < gap) { gap = d; best = c.dataset.n; } }
            if (window.seen[window.seen.length - 1] !== best + (gap < 5 ? '' : '~')) window.seen.push(best + (gap < 5 ? '' : '~'));
        }
        if (window.recording) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
}"""


def test_a_ladder_opens_on_the_stage_you_are_at(site, pwr, engine):
    """Back from a puzzle, the ladder faces that puzzle's stage; opened from the shelf or home, the stage being worked
    on (here 2: 16 of stage 1 solved). From the first frame it's seen: no scroll there, no other stage on the way."""
    name, browser = engine
    ctx, page = ladder(browser, site, **phone_of(pwr, name, viewport={"width": 412, "height": 915}, device_scale_factor=2.6, is_mobile=True,
                                                 has_touch=True, user_agent=LITE))
    try:
        throttle(ctx, page, name)
        settled(page)

        def ladder_on(n, go):
            page.evaluate("document.querySelector('.sttrack') && (document.querySelector('.sttrack').dataset.old = 1)")
            page.evaluate(FRAMES)
            go()
            page.wait_for_function(f"location.hash === '#/packs/forks' && document.querySelector('.sttrack') && !document.querySelector('.sttrack').dataset.old && {FOCUS} === '{n}'", timeout=30_000)
            page.wait_for_timeout(500)
            seen = page.evaluate("window.recording = false, window.seen")
            assert seen == [n], f"the ladder showed {seen} on its way to stage {n}"

        def puzzle(h):
            page.evaluate(f"location.hash = '{h}'")
            page.wait_for_function("document.body.classList.contains('puzzle') && pz.hash === location.hash", timeout=30_000)

        for stage in ("1", "2", "1"):
            puzzle(f"#/packs/forks/{stage}/5")
            ladder_on(stage, page.go_back)                    # the phone's back: to the stage the puzzle is in
        page.evaluate("location.hash = '#/'")
        page.wait_for_function(READY)
        ladder_on("2", lambda: page.evaluate("location.hash = '#/packs/forks'"))   # from home: the stage being worked on
        page.evaluate("location.hash = '#/packs'")
        page.wait_for_selector(".card.pack[data-go='#/packs/forks']", timeout=30_000)
        ladder_on("2", lambda: page.click(".card.pack[data-go='#/packs/forks']"))      # from the shelf: the same
    finally:
        ctx.close()


IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
PIXEL = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36"


SEEN = {}     # phone -> (header height, board box): the same on both


@pytest.mark.parametrize("phone", ["iphone", "android"])
def test_swiping_right_goes_back_and_android_keeps_the_button(site, browser, phone):
    """A swipe right from anywhere goes back a level, as the phone's back does: not from the board, not from Safari's
    own strip along the left edge on an iPhone, not when it's mostly up or down, not when short. An iPhone has no Back
    button, Android has it as well; the header is the same height either way, and so the board sits in the same place."""
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                              user_agent=IPHONE if phone == "iphone" else PIXEL)
    page = ctx.new_page()
    try:
        page.goto(site)
        ready(page)
        for h in ["#/packs", "#/packs/forks", "#/packs/forks/1/1"]:
            page.evaluate(f"location.hash = '{h}'")
            page.wait_for_function("h => location.hash === h", arg=h)
        page.wait_for_function("document.body.classList.contains('puzzle') && pz.hash === location.hash && !state.exploring", timeout=30_000)
        assert page.evaluate("document.documentElement.classList.contains('pf-' + (navigator.userAgent.includes('iPhone') ? 'ios' : 'android'))")
        assert page.locator("#b-back").is_visible() == (phone == "android")
        header = page.locator("header").bounding_box()["height"]
        board = tuple(page.locator("#boardbox").bounding_box().values())
        print(f"{phone}: header {header} px, board {board}")
        SEEN[phone] = (header, board)
        assert len(set(SEEN.values())) == 1, f"the header or the board differ: {SEEN}"
        cdp = ctx.new_cdp_session(page)
        y = page.locator("#now").bounding_box()["y"] + 20

        def swipe(x0, y0, dx, dy, steps=8):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
            for i in range(1, steps + 1):
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + dx * i / steps, "y": y0 + dy * i / steps}]})
                page.wait_for_timeout(12)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            page.wait_for_timeout(300)
            return page.evaluate("location.hash")

        here = "#/packs/forks/1/1"
        assert swipe(60, y, 50, 0) == here                         # too short
        assert swipe(60, y, 150, 120) == here                      # more down than across
        b = page.locator("#boardbox").bounding_box()
        assert swipe(b["x"] + 40, b["y"] + b["height"] / 2, 200, 0) == here     # on the board: a move, not a way back
        if phone == "iphone":
            assert swipe(8, y, 200, 0) == here                     # Safari's own edge swipe: left to Safari
        assert swipe(60, y, 180, 20) == "#/packs/forks"            # back to the ladder
        page.wait_for_selector(".scard.sel", timeout=30_000)
        page.wait_for_timeout(500)
        tr = page.locator(".sttrack").bounding_box()
        assert swipe(60, tr["y"] + 120, 200, 0) == "#/packs/forks"  # on the stages: that's the stages' own swipe
        legend = page.locator(".legend").bounding_box()
        assert swipe(60, legend["y"] + 5, 200, 0) == "#/packs"     # off them: back to the shelf
        assert swipe(60, 400, 200, 0) in ("", "#/")                 # and home
        assert swipe(60, 400, 200, 0) in ("", "#/")                 # nowhere further: it stays
    finally:
        ctx.close()


# a finger's swipe in the page itself (WebKit has no touch input to drive from outside): touch events at the element
# under the start, every 12 ms; the hash after it, whether anything cancelled a move (that would stop a scroll), and
# the sign's opacity and green halfway and at the end
SWIPE_JS = """([x0, y0, dx, dy, steps]) => new Promise(done => {
    const el = document.elementFromPoint(x0, y0), sign = () => document.getElementById('swipeback');
    // (WPE's WebKit has no Touch constructor: an event of the touch type carrying the same fields)
    const touch = (x, y) => ({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
    let blocked = false, seen = [];
    const fire = (type, x, y) => { const e = new Event(type, { bubbles: true, cancelable: true, composed: true });
        const now = type === 'touchend' ? [] : [touch(x, y)];
        Object.defineProperties(e, { touches: { value: now }, targetTouches: { value: now }, changedTouches: { value: [touch(x, y)] } });
        el.dispatchEvent(e); blocked = blocked || e.defaultPrevented; };
    fire('touchstart', x0, y0);
    let i = 0;
    const step = () => {
        i++;
        fire('touchmove', x0 + dx * i / steps, y0 + dy * i / steps);
        if (sign()) seen.push([+getComputedStyle(sign()).opacity, sign().classList.contains('go')]);
        if (i < steps) setTimeout(step, 12);
        else {      // then the hash once it changes (going back is a history step: it takes a moment), or after 1.5 s
            const was = location.hash, t0 = performance.now();
            fire('touchend', x0 + dx, y0 + dy);
            const wait = () => location.hash !== was || performance.now() - t0 > 1500 ? done({ hash: location.hash, blocked, seen }) : setTimeout(wait, 20);
            wait();
        }
    };
    setTimeout(step, 12);
})"""


def test_on_an_iphone_a_swipe_right_goes_back_in_webkit(site, pwr, webkit):
    """The swipe right in WebKit, as on an iPhone: from anywhere but Safari's own strip along the left edge, the
    board and the stages; not short, not mostly down; never blocking a scroll; the sign follows and turns green.
    No Back button there."""
    ctx = webkit.new_context(**phone_of(pwr, "webkit"))
    page = ctx.new_page()
    try:
        page.goto(site)
        ready(page)
        for h in ["#/packs", "#/packs/forks", "#/packs/forks/1/1"]:
            page.evaluate(f"location.hash = '{h}'")
            page.wait_for_function("h => location.hash === h", arg=h)
        page.wait_for_function("document.body.classList.contains('puzzle') && pz.hash === location.hash && !state.exploring", timeout=60_000)
        assert page.evaluate("document.documentElement.classList.contains('pf-ios')")
        assert page.locator("#b-back").is_hidden()
        swipe = lambda x, y, dx, dy, steps=8: page.evaluate(SWIPE_JS, [x, y, dx, dy, steps])
        y = page.locator("#now").bounding_box()["y"] + 20
        here = "#/packs/forks/1/1"
        for args in [(60, y, 50, 0), (60, y, 150, 120), (8, y, 200, 0)]:     # short, mostly down, Safari's edge strip
            r = swipe(*args)
            assert r["hash"] == here and not r["blocked"], (args, r)
        b = page.locator("#boardbox").bounding_box()
        assert swipe(b["x"] + 40, b["y"] + b["height"] / 2, 200, 0)["hash"] == here      # on the board
        r = swipe(60, y, 180, 20)
        assert r["hash"] == "#/packs/forks" and not r["blocked"], r
        assert r["seen"][0][0] > 0 and r["seen"][-1] == [1, True], r["seen"]          # the sign: there, then green
        page.wait_for_selector(".scard.sel", timeout=30_000)
        tr = page.locator(".sttrack").bounding_box()
        assert swipe(60, tr["y"] + 120, 200, 0)["hash"] == "#/packs/forks"            # on the stages
        legend = page.locator(".legend").bounding_box()
        assert swipe(60, legend["y"] + 5, 200, 0)["hash"] == "#/packs"
    finally:
        ctx.close()


def test_the_home_mark_shows_no_ring_when_tapped(site, pwr, engine):
    """Tapped away from home, the Home mark goes in a little and comes back, and nothing else: no border, outline or
    focus ring in any frame after (a white 1 px border faded out over it, going home)."""
    name, browser = engine
    ctx = browser.new_context(**phone_of(pwr, name, viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True, user_agent=PIXEL))
    page = ctx.new_page()
    try:
        page.goto(site + "#/packs")
        page.wait_for_function("document.documentElement.classList.contains('booted') && !!document.querySelector('.card.pack')", timeout=60_000)
        page.evaluate("""() => { window.frames_ = []; const a = document.getElementById('b-home'), t0 = performance.now();
            const f = () => { const s = getComputedStyle(a);
                window.frames_.push({ border: s.borderTopColor, outline: s.outlineStyle, focus: a.matches(':focus-visible'), pressed: a.classList.contains('pressed') });
                if (performance.now() - t0 < 600) requestAnimationFrame(f); };
            requestAnimationFrame(f); }""")
        page.tap("#b-home")
        page.wait_for_timeout(800)
        frames = page.evaluate("window.frames_")
        assert page.evaluate("location.hash") in ("", "#/")
        assert {f["border"] for f in frames} == {"rgba(0, 0, 0, 0)"}, {f["border"] for f in frames}
        assert {f["outline"] for f in frames} == {"none"} and not any(f["focus"] for f in frames)
        assert any(f["pressed"] for f in frames), "no press-in"
    finally:
        ctx.close()


def profile_ids(page) -> list[str]:
    return sorted(p["id"] for p in api(page, "api/profiles")[1]["profiles"])


def test_two_tabs_work_on_one_database_and_the_second_takes_over(site, browser):
    ctx = browser.new_context(user_agent=LITE)
    try:
        a = ctx.new_page()
        a.goto(site)
        ready(a)
        b = ctx.new_page()
        b.goto(site)
        ready(b)
        status, d = api(b, "api/pgn", {"pgn": PGN})              # written by the leader (tab a) for tab b
        assert status == 200, d
        slug = d["games"][0]
        assert profile_ids(a) == ["pgn-pasted-games"]
        b.goto(site + f"#/p/pgn-pasted-games/game/{slug}")       # tab b's page draws the review, answered by tab a
        b.wait_for_function("document.getElementById('crumb').textContent.length > 0", timeout=60_000)
        a.close()                                               # the leader goes: tab b opens the database itself
        assert profile_ids(b) == ["pgn-pasted-games"]
        status, d = api(b, f"p/pgn-pasted-games/games/{slug}.json")
        assert status == 200 and len(d["moves"]) > 10
        c = ctx.new_page()                                      # a tab opened later is answered by b
        c.goto(site)
        c.wait_for_function("document.querySelector('#profiles .card.profile[data-id=pgn-pasted-games]')", timeout=60_000)
        assert api(c, "api/pgn", {"pgn": PGN})[0] == 200
    finally:
        ctx.close()


def node22():
    """A Node that has node:sqlite (>= 22.13), for the desktop's server: $NODE, the PATH's, or nvm's."""
    cands = [os.environ.get("NODE"), shutil.which("node"),
             *sorted(map(str, Path.home().glob(".nvm/versions/node/*/bin/node")), reverse=True)]
    for c in filter(None, cands):
        try:
            v = subprocess.run([c, "-p", "process.versions.node"], capture_output=True, text=True, timeout=20).stdout.strip()
            if tuple(map(int, v.split(".")[:2])) >= (22, 13):
                return c
        except (OSError, ValueError):
            continue
    return None


NATIVE_REVIEW = r"""
// the desktop's server (js/server over node:sqlite and native Stockfish) reviews the PGN at NODES
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, stockfish, pgnFile, bookFile, nodes] = process.argv.slice(2);
const imp = p => import(pathToFileURL(join(root, p)).href);
const { loadBook } = await imp('js/core/book.js');
const { nodeSqlite } = await imp('js/server/db-node.js');
const { Store } = await imp('js/server/db.js');
const { nodeFiles } = await imp('js/server/profiles-files-node.js');
const { Profiles } = await imp('js/server/profiles.js');
const { serve } = await imp('js/server/router.js');
const { EnginePool } = await imp('js/desktop/engines.js');
loadBook(readFileSync(bookFile, 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'blundr-native-'));
const store = new Store(nodeSqlite(dir)), files = nodeFiles(dir);
const pool = new EnginePool({ path: stockfish });
const log = Object.assign(() => {}, { info() {}, warn() {}, error: (...a) => console.error(...a), debug() {} });
const router = await serve({ env: { store, files, profiles: new Profiles(files, store), fetch, log }, pool, nodes: +nodes, scan: false });
const call = async (m, p, b) => {
  const body = (await router.handle(m, p, b ? JSON.stringify(b) : null)).body;
  return JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
};
const d = await call('POST', '/api/pgn', { pgn: readFileSync(pgnFile, 'utf8') });
const slug = d.games[0];
await call('POST', `/api/p/pgn-pasted-games/analyse/${slug}`);
await new Promise(r => setTimeout(r, 200));
for (;;) {
  const s = await call('GET', '/api/status');
  if (!(s.job && ['queued', 'running', 'finishing'].includes(s.job.status))) break;
  await new Promise(r => setTimeout(r, 200));
}
const game = await call('GET', `/p/pgn-pasted-games/games/${slug}.json`);
console.log('RESULT' + JSON.stringify(game.moves.map(m => [m.san, m.label, m.best_san ?? null])));
await pool.close?.();
process.exit(0);
"""


def test_a_review_with_wasm_stockfish_has_the_desktops_labels(site, browser, tmp_path):
    node = node22()
    if node is None or not STOCKFISH.exists():
        pytest.skip("needs Node >= 22.13 and bin/stockfish for the desktop's side")
    nodes = 50_000
    pgn = tmp_path / "game.pgn"
    pgn.write_text(PGN, encoding="utf-8")
    script = tmp_path / "native.mjs"
    script.write_text(NATIVE_REVIEW, encoding="utf-8")
    run = subprocess.run([node, str(script), str(ROOT), str(STOCKFISH), str(pgn), str(ROOT / "web-dist" / "book_keys.txt"),
                          str(nodes)], capture_output=True, text=True, timeout=600)
    line = next((x for x in run.stdout.splitlines() if x.startswith("RESULT")), None)
    assert line, run.stdout + run.stderr
    desktop = json.loads(line[6:])

    ctx = browser.new_context(user_agent=DESKTOP)      # a computer: the full engine, as the desktop's
    # the desktop side's node count, through config.js (CR_CONFIG.nodes is for tests only)
    ctx.route(re.compile(r".*/web/config\.js$"), lambda route: route.fulfill(
        status=200, content_type="text/javascript", body=route.fetch().text() + f"\nself.CR_CONFIG.nodes = {nodes};\n"))
    try:
        page = ctx.new_page()
        page.on("console", lambda m: m.type in ("error", "warning") and print("console:", m.text[:500]))
        page.goto(site)
        ready(page)
        status, d = api(page, "api/pgn", {"pgn": PGN})
        assert status == 200, d
        slug = d["games"][0]
        status, d = api(page, f"api/p/pgn-pasted-games/analyse/{slug}", {})
        assert status == 200, d
        page.wait_for_timeout(500)
        st = wait_job(page, timeout_s=900)
        assert st["job"]["status"] == "done", st["job"]
        status, game = api(page, f"p/pgn-pasted-games/games/{slug}.json")
        web = [[m["san"], m["label"], m.get("best_san")] for m in game["moves"]]
        assert all(m[1] for m in web)
        assert web == desktop
    finally:
        ctx.close()


SEED_IDBFS = """async ({ files, pyodide }) => {
    // Pyodide's IDBFS at /data, as the Python build mounted it, filled with the Python data folder
    const { loadPyodide } = await import(pyodide + 'pyodide.mjs');
    const py = await loadPyodide({ indexURL: pyodide });
    py.FS.mkdirTree('/data');
    py.FS.mount(py.FS.filesystems.IDBFS, {}, '/data');
    const sync = populate => new Promise((res, rej) => py.FS.syncfs(populate, e => (e ? rej(e) : res())));
    await sync(true);
    for (const [path, b64] of Object.entries(files)) {
        py.FS.mkdirTree('/data/' + path.split('/').slice(0, -1).join('/'));
        py.FS.writeFile('/data/' + path, Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    }
    await sync(false);
    return (await indexedDB.databases()).map(d => d.name);
}"""

OPFS_TEXT = """async path => {
    let d = await navigator.storage.getDirectory();
    const ps = path.split('/');
    try {
        for (const p of ps.slice(0, -1)) d = await d.getDirectoryHandle(p);
        return await (await (await d.getFileHandle(ps.at(-1))).getFile()).text();
    } catch (e) { return null; }
}"""


def test_the_python_builds_data_moves_to_sqlite_once(site, browser, tmp_path):
    config = next(OUT.glob("v/*/web/config.js")).read_text(encoding="utf-8")     # the build's code version
    pyodide = json.loads(config[config.index("{"):config.rindex("}") + 1])["legacy"]["pyodide"]
    try:
        urllib.request.urlopen(pyodide + "pyodide.mjs", timeout=10).close()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no network for Pyodide: {e}")
    pytest.importorskip("duckdb")
    # a data folder as the Python build left it (frozen with the export it runs: legacy/)
    data = tmp_path / "data"
    subprocess.run([sys.executable, str(ROOT / "legacy" / "make_fixture.py"), str(data)], check=True)
    files = {f.relative_to(data).as_posix(): base64.b64encode(f.read_bytes()).decode()
             for f in sorted(data.rglob("*")) if f.is_file()}
    assert "evals.duckdb" in files and "profiles/pgn-fuzz/games.parquet" in files

    ctx = browser.new_context(user_agent=LITE)
    asked = []
    ctx.on("request", lambda r: asked.append(r.url))
    try:
        page = ctx.new_page()
        page.on("console", lambda m: m.type in ("error", "warning") and print("console:", m.text[:500]))
        page.goto(site + "privacy.html")                     # the site's origin, without the app
        assert "/data" in page.evaluate(SEED_IDBFS, {"files": files, "pyodide": pyodide})
        asked.clear()
        page.goto(site)
        page.wait_for_function("document.querySelector('#profiles .card.profile[data-id=pgn-fuzz]')", timeout=300_000)
        assert any("/pyodide/" in u for u in asked) and any(u.endswith("legacy/app.zip") for u in asked)
        assert profile_ids(page) == ["pgn-fuzz", "pgn-testuser"]
        done = json.loads(page.evaluate(OPFS_TEXT, "data/pyodide-migration.json"))
        assert done["status"] == "done", done
        assert done["files"]["evals.sqlite"]["evals"] > 0
        assert page.evaluate(OPFS_TEXT, "data/sqlite-export.json") is not None
        status, d = api(page, "p/pgn-fuzz/games.json")
        assert status == 200 and len(d["games"]) > 0

        asked.clear()                                       # a reload: the data stays, Python never loads again
        page.reload()
        page.wait_for_function("document.querySelector('#profiles .card.profile[data-id=pgn-fuzz]')", timeout=60_000)
        assert not any("/pyodide/" in u or "/legacy/" in u for u in asked)
        assert profile_ids(page) == ["pgn-fuzz", "pgn-testuser"]
    finally:
        ctx.close()
