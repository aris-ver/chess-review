"""Blundr with no network (web/offline.js, the service worker scripts/build_web.js writes as offline.js): opened once
online on a phone (the lite engine), it opens again with the network cut and runs a puzzle, a drill and a review of a
pasted game; what needs the network (a chess.com profile) fails at once and says so. A second deploy installs whole
in the background, a broken one not at all, and no page ever runs on files of two builds.

Two builds of their own (--out, --nodes: a short review, and a second build that differs in its code), served on one
origin from a folder the test switches, with every request the server gets logged. Needs Playwright's Chromium and
Node >= 22.13, as tests/test_web_browser.py does; the WebKit run (as an iPhone) skips without Playwright's WebKit.
"""

import json
import os
import shutil
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from test_web_browser import (
    CHROMIUM_ARGS,
    LITE,
    PGN,
    READY,
    api,
    node22,
    toast,
    wait_job,
)

pw = pytest.importorskip("playwright.sync_api")
ROOT = Path(__file__).resolve().parent.parent
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"


def offline_list(out: Path) -> dict:
    """offline.js's head: {version, files: {path: sha256}}."""
    head = (out / "offline.js").read_text(encoding="utf-8").split("\n", 1)[0]
    return json.loads(head[head.index("{"):head.rindex("}") + 1])


@pytest.fixture(scope="module")
def builds(tmp_path_factory):
    """Two builds, a and b: the same site but for config.js's node count, so b's code (and so every page and file
    list) is another version."""
    node = node22()
    if node is None:
        pytest.skip("needs Node >= 22.13 to build the site")
    root = tmp_path_factory.mktemp("deploys")
    out = {}
    for name, nodes in (("a", 20_000), ("b", 20_001)):
        subprocess.run([node, str(ROOT / "scripts" / "build_web.js"), "--out", str(root / name), "--nodes", str(nodes),
                        "--engine-wasm", "cdn"], check=True, capture_output=True)
        out[name] = root / name
    assert offline_list(out["a"])["version"] != offline_list(out["b"])["version"]
    return out


class _Handler(SimpleHTTPRequestHandler):
    """The server's current folder, never cached by the browser, each path asked for logged."""
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript",
                      ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".webp": "image/webp"}

    def __init__(self, request, client_address, server):
        super().__init__(request, client_address, server, directory=str(server.root))

    def do_GET(self):
        path = self.path.split("?")[0]
        self.server.log.append(path)
        if path == "/" and self.server.hang:      # a connection that has gone bad: the page never comes
            time.sleep(self.server.hang)
        if path in self.server.drop:              # the connection drops: no answer at all
            self.close_connection = True
            return
        # never a 304: the folders switched under it have files of one name and other bytes (by mtime it would answer
        # "not modified" for the older of two, which a real host's ETag doesn't)
        del self.headers["If-Modified-Since"]
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *_):
        pass


@pytest.fixture
def server(builds):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    srv.root, srv.log, srv.hang, srv.drop = builds["a"], [], 0, set()
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    srv.url = f"http://127.0.0.1:{srv.server_port}/"
    yield srv
    srv.shutdown()


@pytest.fixture(scope="module")
def pwr():
    with pw.sync_playwright() as p:
        yield p


def launch(pwr, name):
    try:
        if name == "chromium":
            return pwr.chromium.launch(args=CHROMIUM_ARGS)
        b = pwr.webkit.launch(env={**os.environ, "LIBGL_ALWAYS_SOFTWARE": "1"})
        b.new_page().close()
        return b
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no {name} to launch: {str(e).splitlines()[0]}")


def phone(pwr, name):
    b = launch(pwr, name)
    ctx = b.new_context(user_agent=LITE if name == "chromium" else IPHONE, viewport={"width": 390, "height": 844},
                        is_mobile=name == "chromium", has_touch=True)
    return b, ctx


KEPT = """async version => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!(r && r.active && r.active.state === 'activated') && (await caches.keys()).includes('blundr-offline-' + version);
}"""
ENGINE_KEPT = """async () => {
    const c = await caches.open('chess-review-engines');
    return (await c.keys()).map(r => r.url).filter(u => /stockfish-19-lite-single\\.wasm$/.test(u)).length === 1;
}"""
# the build this page is, the code versions it loaded (its own and its worker's are in the resource timings), and
# whether a service worker answers it
SEEN = """() => ({
    page: document.querySelector('meta[name=blundr-offline]').content,
    code: [...new Set(performance.getEntriesByType('resource').map(e => (/\\/v\\/([0-9a-f]+)\\//.exec(e.name) || [])[1]).filter(Boolean))],
    controlled: !!navigator.serviceWorker.controller,
})"""


def until(page, fn, arg=None, timeout_s=120):
    """fn (an async page function) polled until it is true: wait_for_function takes a promise for true."""
    for _ in range(timeout_s * 4):
        if page.evaluate(fn, arg):
            return
        page.wait_for_timeout(250)
    raise TimeoutError(f"still false after {timeout_s} s: {fn[:80]}")


def first_visit(page, url, version):
    """The first visit, until the build and the engine are kept: what an iPhone has after one launch online."""
    page.goto(url)
    page.wait_for_function(READY, timeout=60_000)
    if not page.evaluate("!!navigator.serviceWorker"):
        pytest.skip("this browser build has no service workers")
    until(page, KEPT, version)
    page.wait_for_function("!document.documentElement.classList.contains('engine-loading')", timeout=120_000)
    until(page, ENGINE_KEPT)


@pytest.mark.parametrize("name", ["chromium", "webkit"])
def test_once_opened_online_it_works_with_no_network(pwr, server, builds, name):
    a = offline_list(builds["a"])
    b, ctx = phone(pwr, name)
    try:
        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and print("console:", m.text[:300]))
        first_visit(page, server.url, a["version"])

        server.log.clear()
        if name == "chromium":
            ctx.set_offline(True)
        else:       # Playwright's WebKit fails any navigation while "offline", even one a service worker answers
            server.shutdown()
            server.server_close()       # nothing listens: refused, as with no network
        page.goto(server.url)
        page.wait_for_function(READY, timeout=60_000)
        seen = page.evaluate(SEEN)
        assert seen["controlled"] and seen["page"] == a["version"], seen

        # a puzzle: the daily one, and a pack's ladder drawn
        status, d = api(page, "api/puzzles/daily")
        assert status == 200 and d, d
        page.evaluate("location.hash = '#/packs/forks'")
        page.wait_for_selector(".scard.sel", timeout=30_000)

        # an endgame drill: dealt, the table's best move played, the defender's reply (endgames/ from the cache)
        status, d = api(page, "api/drills/next?ending=KQK")
        assert status == 200, d
        drill = d["drill"]
        status, line = api(page, "api/drills/line", {"ending": "KQK", "fen": drill["fen"]})
        assert status == 200 and line["moves"], line
        status, move = api(page, "api/drills/move", {"ending": "KQK", "level": drill["level"],
                                                     "fens": [drill["fen"], line["moves"][0]["fen"]]})
        assert status == 200 and "error" not in move, move

        # a pasted game reviewed by the lite engine (kept by web/engines.js, not twice)
        status, d = api(page, "api/pgn", {"pgn": PGN})
        assert status == 200, d
        slug = d["games"][0]
        status, d = api(page, f"api/p/pgn-pasted-games/analyse/{slug}", {})
        assert status == 200, d
        page.wait_for_timeout(500)
        st = wait_job(page, timeout_s=600)
        assert st["job"]["status"] == "done", st["job"]
        status, game = api(page, f"p/pgn-pasted-games/games/{slug}.json")
        assert status == 200 and all(m["label"] for m in game["moves"]), game.get("moves", [])[:3]
        page.evaluate("s => location.hash = '#/p/pgn-pasted-games/game/' + s", slug)
        page.wait_for_function("document.getElementById('crumb').textContent.length > 0", timeout=30_000)

        # what needs the network fails at once, and says why. Chromium only: in Playwright's WebKit the worker's
        # fetches pass its routes by, to the real chess.com, and its offline switch fails every navigation
        if name == "chromium":
            page.evaluate("location.hash = '#/'")
            page.wait_for_function(READY, timeout=30_000)
            t0 = time.monotonic()       # the add form's own submit (the phone's drawer slides in: no clicks to wait on)
            page.evaluate("() => { const f = document.getElementById('addform'); f.source.value = 'chesscom'; "
                          "f.username.value = 'someone'; f.requestSubmit(); }")
            toast(page, "couldn't reach api.chess.com", timeout=15_000)
            assert time.monotonic() - t0 < 15

        # nothing reached the server while offline but the browser's own check for a newer offline.js, which
        # Playwright's offline switch doesn't cover (in airplane mode it fails like the rest)
        assert [p for p in server.log if p != "/offline.js"] == [], server.log
    finally:
        ctx.close()
        b.close()


INSTALLED = """async () => {
    // the browser's own check (after the navigation) and ours: done once no new build has been installing for 2 s
    const r = await navigator.serviceWorker.getRegistration();
    await r.update().catch(() => {});
    for (let idle = 0; idle < 8 && !r.waiting;) {
        const w = r.installing;
        if (w) {
            idle = 0;
            await new Promise(done => {
                const f = () => ['installed', 'redundant', 'activated'].includes(w.state) && done();
                w.addEventListener('statechange', f); f();
            });
        } else {
            idle++;
            await new Promise(done => setTimeout(done, 250));
        }
    }
    return { waiting: !!r.waiting, caches: (await caches.keys()).filter(n => n.startsWith('blundr-offline-')).sort() };
}"""
CACHED_HASHES = """async version => {
    const c = await caches.open('blundr-offline-' + version);
    const out = {};
    for (const r of await c.keys()) out[new URL(r.url).pathname.slice(1)] = (await c.match(r)).headers.get('X-Blundr-Sha256');
    return out;
}"""


BOOTED = "document.documentElement.classList.contains('booted')"     # the first screen shown, whichever it is
READY_TO_RELOAD = "#web-loading .upd:not(.fix)"      # "A new version of Blundr is ready. Reload"
COULD_NOT = "#web-loading .upd.fix"                # "Couldn't update Blundr. Reload"


def test_a_deploy_installs_whole_and_no_page_mixes_two_builds(pwr, server, builds, tmp_path):
    a, b = offline_list(builds["a"]), offline_list(builds["b"])
    browser, ctx = phone(pwr, "chromium")
    try:
        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and print("console:", m.text[:300]))
        first_visit(page, server.url, a["version"])

        # a deploy half there, as a host mid-deploy might serve it: b's list with a's page, or a file of b's code not
        # what the list says. Never installed: a's stays, and nothing is offered. Only the second is noted as a
        # failure (a deploy still going out passes: the next launch tries again).
        b_code = next(k for k in b["files"] if k.startswith("v/")).split("/")[1]
        for n, spoil in enumerate([lambda d: shutil.copy(builds["a"] / "index.html", d / "index.html"),
                                   lambda d: (d / f"v/{b_code}/web/config.js").write_text("self.CR_CONFIG = {};\n")]):
            broken = tmp_path / f"broken{n}"
            shutil.copytree(builds["b"], broken)
            spoil(broken)
            server.root = broken
            page.goto(server.url)
            page.wait_for_function(READY, timeout=60_000)
            assert page.evaluate(SEEN)["page"] == a["version"]
            r = page.evaluate(INSTALLED)
            # a's cache, and for the lasting failure a note (the page then offers a fresh start: the next tests)
            assert r == {"waiting": False, "caches": sorted(["blundr-offline-" + a["version"]] + (["blundr-offline-failed"] if n else []))}, (n, r)
            assert page.locator(READY_TO_RELOAD).count() == 0

        # the real deploy: this load is still all a's, b installs alongside, and only what changed is downloaded. On
        # Settings, not a screen the page reloads on by itself (Home would go straight on to b: the next test)
        server.root = builds["b"]
        server.log.clear()
        page.goto("about:blank")
        page.goto(server.url + "#/settings")
        page.wait_for_function(BOOTED, timeout=60_000)
        seen = page.evaluate(SEEN)
        a_code = next(k for k in a["files"] if k.startswith("v/")).split("/")[1]
        assert a_code != b_code
        assert seen["page"] == a["version"] and seen["code"] == [a_code], seen
        r = page.evaluate(INSTALLED)
        assert r["waiting"] and r["caches"] == sorted(["blundr-offline-" + a["version"], "blundr-offline-" + b["version"]]), r
        assert "/puzzles.json" not in server.log and "/endgames/kqk.bin" not in server.log, server.log   # reused
        assert f"/v/{b_code}/web/shim.js" in server.log
        kept = page.evaluate(CACHED_HASHES, b["version"])
        assert set(kept) == set(b["files"]) and all(kept[k] == b["files"][k] for k in b["files"] if k), \
            [k for k in b["files"] if kept.get(k) != b["files"][k]]

        # a second tab on a, mid-drill. The first goes Home, a screen to reload on by itself, but the new build taking
        # over would reload the second too: it waits. Once the second leaves its drill for the drills list (a drill
        # left is given up, as any leaving is), both come back on b by themselves, no click
        other = ctx.new_page()
        other.goto(server.url + "#/drills/KQK")
        other.wait_for_function(f"{BOOTED} && !!dr.drill", timeout=60_000)
        assert other.evaluate(SEEN)["page"] == a["version"]
        page.wait_for_selector(READY_TO_RELOAD, timeout=30_000)
        until(other, "() => fresh.stale", timeout_s=30)
        other.evaluate("window.__kept = 1")
        go(page, "#/")
        stays(page, 3000)
        assert other.evaluate("window.__kept === 1 && !!dr.drill"), "a tab mid-drill reloaded"
        with page.expect_navigation(timeout=30_000), other.expect_navigation(timeout=30_000):
            go(other, "#/drills")
        toast(other, "Updated to the latest version")
        toast(page, "Updated to the latest version")
        for p in (page, other):
            p.wait_for_function(BOOTED, timeout=60_000)
            seen = p.evaluate(SEEN)
            assert seen["page"] == b["version"] and seen["code"] == [b_code] and seen["controlled"], seen
        assert page.evaluate("async () => (await caches.keys()).filter(n => n.startsWith('blundr-offline-'))") \
            == ["blundr-offline-" + b["version"]]

        # and with no network, b
        other.close()
        ctx.set_offline(True)
        page.goto(server.url)
        page.wait_for_function(READY, timeout=60_000)
        seen = page.evaluate(SEEN)
        assert seen["page"] == b["version"] and seen["code"] == [b_code], seen
    finally:
        ctx.close()
        browser.close()


TOAST_CLEARED = "document.getElementById('toast').textContent = ''"
NO_UPDATE_TOAST = "!/updated/i.test(document.getElementById('toast').textContent)"


def go(page, h):
    """The hash changed as a click would, and the screen given its route."""
    page.evaluate("h => { location.hash = h; }", h)
    page.wait_for_timeout(300)


def stays(page, ms=2500):
    """No reload for ms: the mark set now is still there."""
    page.evaluate("window.__kept = 1")
    page.wait_for_timeout(ms)
    assert page.evaluate("window.__kept === 1"), "the page reloaded"


@pytest.mark.parametrize("sw", ["service worker", "none"])
def test_a_deploy_reloads_by_itself_only_at_a_safe_moment(pwr, server, builds, sw):
    """A deploy while the page is open: mid-puzzle and mid-drill it says so once and stays; on the way onto a screen to
    rest on it reloads into the new build by itself and says so. With the service worker the reload goes through the
    new build taking over (a plain one would get the kept page again); without one (as an old browser, or the desktop's
    page if its stamp ever changed), a plain reload. A host that answers with the old page again right after can't make
    it reload in a loop."""
    a, b = offline_list(builds["a"]), offline_list(builds["b"])
    browser = launch(pwr, "chromium")
    ctx = browser.new_context(user_agent=LITE, viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                              service_workers="allow" if sw == "service worker" else "block")
    try:
        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and print("console:", m.text[:300]))
        loads = []
        page.on("load", lambda p: loads.append(p.url))
        if sw == "service worker":
            first_visit(page, server.url, a["version"])
            page.goto(server.url)
        else:
            page.goto(server.url)
        page.wait_for_function(READY, timeout=60_000)
        assert page.evaluate(SEEN)["page"] == a["version"]
        if sw == "none":
            assert not page.evaluate("!!navigator.serviceWorker && !!navigator.serviceWorker.controller")
        (builds["b"] / "index.html").touch()      # newer than a's whatever the builds' times: its Last-Modified differs
        server.root = builds["b"]
        # a library puzzle being solved: told once, no reload
        go(page, "#/puzzles")
        page.wait_for_function("!!state.game && !!state.game.puzzle && !pz.over", timeout=60_000)
        toast(page, "The app was updated", timeout=10_000)
        stays(page)
        # a drill (and on to another screen that isn't one to rest on): not told again, no reload
        page.evaluate(TOAST_CLEARED)
        go(page, "#/drills/KQK")
        page.wait_for_function("!!dr.drill", timeout=60_000)
        stays(page)
        assert page.evaluate(NO_UPDATE_TOAST)
        n = len(loads)
        # the drills list: a screen to rest on, so the reload (the drill left behind is given up, as any leaving is)
        with page.expect_event("load", timeout=120_000):
            go(page, "#/drills")
        page.wait_for_function(BOOTED, timeout=60_000)
        toast(page, "Updated to the latest version", timeout=10_000)
        assert len(loads) == n + 1
        assert page.evaluate(SEEN)["page"] == b["version"]
        assert page.url.endswith("#/drills")

        # no loop: the new page stays as it is on screens to rest on
        stays(page)
        go(page, "#/")
        go(page, "#/packs")
        stays(page)
        # an edge answering with the old page again: stale once more, but not reloaded by itself so soon after
        server.root = builds["a"]
        page.evaluate(TOAST_CLEARED)
        go(page, "#/")
        toast(page, "The app was updated", timeout=10_000)
        stays(page, 4000)
        assert len(loads) == n + 1, loads
    finally:
        ctx.close()
        browser.close()


@pytest.mark.parametrize("sw", ["service worker", "none"])
def test_a_reload_by_itself_never_lands_mid_puzzle_and_a_click_always_reloads(pwr, server, builds, sw):
    """The safe moment is asked again right before the reload goes (and before the new build takes over): Home, then a
    puzzle opened a quarter of a second later, while the reload is on its way, keeps the puzzle. The toast's click
    reloads whatever the screen, through the new build taking over when there is a service worker."""
    a, b = offline_list(builds["a"]), offline_list(builds["b"])
    browser = launch(pwr, "chromium")
    ctx = browser.new_context(user_agent=LITE, viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                              service_workers="allow" if sw == "service worker" else "block")
    try:
        page = ctx.new_page()
        loads = []
        page.on("load", lambda p: loads.append(p.url))
        if sw == "service worker":
            first_visit(page, server.url, a["version"])
        page.goto("about:blank")
        page.goto(server.url + "#/settings")
        page.wait_for_function(BOOTED, timeout=60_000)
        (builds["b"] / "index.html").touch()
        server.root = builds["b"]
        if sw == "service worker":
            # b installed and waiting while the page is on Settings (not a screen to reload on): the bar offers it.
            # Home, and a puzzle opened 250 ms later, while the reload by itself is on its way (asking the other
            # tabs, the new build taking over): the puzzle stays, the page with it
            page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
            page.wait_for_selector(READY_TO_RELOAD, timeout=60_000)
            n = len(loads)
            for attempt in range(3):
                page.evaluate("() => { location.hash = '#/'; setTimeout(() => { location.hash = '#/puzzles'; }, 250); }")
                page.wait_for_function("location.hash.startsWith('#/puzzles') && !!state.game && !!state.game.puzzle", timeout=60_000)
                stays(page, 3000)
                assert len(loads) == n, f"reloaded mid-puzzle (attempt {attempt}): {loads}"
                assert page.evaluate(SEEN)["page"] == a["version"]
                go(page, "#/settings")
            page.evaluate("fresh.via = false")       # the toast, which the bar's being up keeps away
        # mid-puzzle the toast's click reloads, into b (without a service worker the HEAD made the page stale)
        go(page, "#/puzzles")
        page.wait_for_function("!!state.game && !!state.game.puzzle", timeout=60_000)
        page.evaluate("fresh.stale = true; fresh.told = false; reloadIfSafe()")
        toast(page, "The app was updated", timeout=10_000)
        with page.expect_event("load", timeout=120_000):
            page.click("#toast")
        page.wait_for_function(BOOTED, timeout=60_000)
        toast(page, "Updated to the latest version", timeout=10_000)
        assert page.evaluate(SEEN)["page"] == b["version"]
        assert "#/puzzles" in page.url
    finally:
        ctx.close()
        browser.close()


def test_a_slow_network_does_not_hold_the_page_back(pwr, server, builds):
    """The page waits a few seconds at most for the network before the kept one is shown."""
    a = offline_list(builds["a"])
    browser, ctx = phone(pwr, "chromium")
    try:
        page = ctx.new_page()
        first_visit(page, server.url, a["version"])
        server.hang = 20
        t0 = time.monotonic()
        page.goto(server.url, wait_until="domcontentloaded", timeout=30_000)
        assert time.monotonic() - t0 < 10
        page.wait_for_function(READY, timeout=60_000)
        assert page.evaluate(SEEN)["page"] == a["version"]
    finally:
        ctx.close()
        browser.close()


def test_a_build_that_cannot_be_kept_offers_a_fresh_start(pwr, server, builds, tmp_path):
    """A newer build whose install fails while online (here: a file of its code not what its list says) isn't left
    to the console: the page says it couldn't update, then and on the next loads, and its Reload drops the service
    worker and the builds' caches (not the engine's) and comes back on the newer build from the network."""
    a, b = offline_list(builds["a"]), offline_list(builds["b"])
    b_code = next(k for k in b["files"] if k.startswith("v/")).split("/")[1]
    browser, ctx = phone(pwr, "chromium")
    try:
        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and print("console:", m.text[:300]))
        first_visit(page, server.url, a["version"])
        broken = tmp_path / "broken"
        shutil.copytree(builds["b"], broken)
        (broken / f"v/{b_code}/web/config.js").write_text("self.CR_CONFIG = {};\n")
        server.root = broken
        page.goto(server.url)
        page.wait_for_function(READY, timeout=60_000)
        assert page.evaluate(INSTALLED) == {"waiting": False, "caches": sorted(["blundr-offline-" + a["version"], "blundr-offline-failed"])}
        page.wait_for_selector(COULD_NOT, timeout=30_000)           # told as it happened
        assert "Couldn't update Blundr" in page.text_content("#web-loading")
        page.goto(server.url)
        page.wait_for_function(READY, timeout=60_000)
        assert page.evaluate(SEEN)["page"] == a["version"]
        page.wait_for_selector(COULD_NOT, timeout=30_000)           # and on the next load, from what was kept

        server.root = builds["b"]                                    # the host has it right now
        with page.expect_navigation(timeout=30_000):
            page.click(COULD_NOT)
        page.wait_for_function(READY, timeout=60_000)
        seen = page.evaluate(SEEN)
        assert seen["page"] == b["version"] and seen["code"] == [b_code] and not seen["controlled"], seen
        until(page, KEPT, b["version"])                              # and it keeps itself again
        names = page.evaluate("caches.keys()")
        assert "chess-review-engines" in names and [n for n in names if n.startswith("blundr-offline-")] == ["blundr-offline-" + b["version"]], names
        assert page.locator(COULD_NOT).count() == 0
    finally:
        ctx.close()
        browser.close()


NOTE = """version => caches.open('blundr-offline-failed').then(c => c.put(new URL('update-failed', location.href).href,
    new Response(JSON.stringify({ type: 'blundr-update-failed', version, reason: 'a test' }))))"""


def test_a_failure_note_never_costs_offline_use(pwr, server, builds):
    """A failed update noted, then the network gone: no prompt offline, and a prompt taken with no network leaves the
    kept build as it is (it says the update needs the internet) and Blundr still opens offline."""
    a = offline_list(builds["a"])
    browser, ctx = phone(pwr, "chromium")
    try:
        page = ctx.new_page()
        first_visit(page, server.url, a["version"])
        page.evaluate(NOTE, "0123456789ab")                       # a newer build that couldn't be kept
        page.goto(server.url)
        page.wait_for_function(READY, timeout=60_000)
        page.wait_for_selector(COULD_NOT, timeout=30_000)       # online: offered

        ctx.set_offline(True)                                   # the network goes with the prompt up: taken anyway
        page.click(COULD_NOT)
        toast(page, "Updating Blundr needs the internet", timeout=15_000)
        assert page.evaluate(SEEN)["page"] == a["version"]
        until(page, KEPT, a["version"], timeout_s=5)            # the service worker and the build still there

        page.goto(server.url)                                   # an offline launch with the note kept: no prompt
        page.wait_for_function(READY, timeout=60_000)
        seen = page.evaluate(SEEN)
        assert seen["controlled"] and seen["page"] == a["version"], seen
        assert "blundr-offline-failed" in page.evaluate("caches.keys()")
        page.wait_for_timeout(2000)
        assert page.locator(COULD_NOT).count() == 0
        status, d = api(page, "api/puzzles/daily")
        assert status == 200 and d
    finally:
        ctx.close()
        browser.close()


def test_a_dropped_connection_while_installing_leaves_no_note(pwr, server, builds):
    a, b = offline_list(builds["a"]), offline_list(builds["b"])
    b_code = next(k for k in b["files"] if k.startswith("v/")).split("/")[1]
    browser, ctx = phone(pwr, "chromium")
    try:
        page = ctx.new_page()
        first_visit(page, server.url, a["version"])
        server.root, server.drop = builds["b"], {f"/v/{b_code}/web/config.js"}
        page.goto(server.url)
        page.wait_for_function(READY, timeout=60_000)
        r = page.evaluate(INSTALLED)
        assert r == {"waiting": False, "caches": ["blundr-offline-" + a["version"]]}, r
        assert f"/v/{b_code}/web/config.js" in server.log
        assert page.locator(COULD_NOT).count() == 0
        server.drop = set()                                      # the next launch tries again, and keeps it
        page.goto(server.url)
        page.wait_for_function(READY, timeout=60_000)
        assert page.evaluate(INSTALLED)["waiting"]
    finally:
        ctx.close()
        browser.close()
