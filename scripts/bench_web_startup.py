"""The phone bench (docs/js-port.md, "Measured before the port"): a local build in headless Chromium under WSL with an
Android user agent (so the lite engine), reloaded with everything cached. That setup is about 4x slower than the
i7-10750H in real Chrome, so it stands in for a mid-range phone.

    python scripts/bench_web_startup.py [--dist web-dist] [--runs 5]

Each run is a reload after a first visit (which fills the HTTP cache, Cache Storage and the browser's database). Times
are from the navigation's start, in seconds:
  api      the worker's first answer to any api/ request (the page waits for it to draw the home screen)
  pasted   POST api/pgn of a game answered (the Python build: once DuckDB is in), asked as soon as the page has loaded
  analyse  POST api/p/<id>/analyse/<game> answered (the job queued)
Works on the Python (Pyodide) build as well as the JS one: it only listens to the page's worker messages.
"""

import argparse
import functools
import statistics
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36"
# WSLg's GPU makes headless Chromium draw no frames (tests/test_web_browser.py): off
ARGS = ["--disable-gpu", "--disable-software-rasterizer"]
PGN = (ROOT / "tests" / "fixtures" / "clocks.pgn").read_text().split("\n\n[Event")[0]

# the first message from the worker that answers a request (both builds' shims set worker.onmessage)
WATCH = """(() => {
  const W = window.Worker;
  window.__bench = { api: null };
  window.Worker = function (url, opts) {
    const w = new W(url, opts);
    w.addEventListener('message', e => {
      if (e.data && e.data.type === 'response' && window.__bench.api === null) window.__bench.api = performance.now();
    });
    return w;
  };
  window.Worker.prototype = W.prototype;
})();"""

ACT = """async pgn => {
  const post = async (path, body) => { const r = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
                                       return [r.status, await r.json(), performance.now()]; };
  const [s1, d, tPgn] = await post('api/pgn', { pgn });
  if (s1 !== 200) return { error: JSON.stringify(d) };
  const [s2, j, tAnalyse] = await post(`api/p/${d.profile.id}/analyse/${d.games[0]}`, {});
  await post('api/stop', {});
  return { pasted: tPgn, analyse: tAnalyse, status: s2 };
}"""


def serve(dist: Path):
    from build_web import _Handler
    quiet = type("Quiet", (_Handler,), {"log_message": lambda *_: None})
    srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(quiet, directory=str(dist)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}/"


def visit(page, url, timeout=180_000) -> dict:
    page.goto(url)
    page.wait_for_function("window.__bench && window.__bench.api !== null", timeout=timeout)
    out = page.evaluate(ACT, PGN)
    out["api"] = page.evaluate("window.__bench.api")
    return {k: (v / 1000 if isinstance(v, (int, float)) and k != "status" else v) for k, v in out.items()}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dist", type=Path, default=ROOT / "web-dist", help="a built site (scripts/build_web.py)")
    p.add_argument("--runs", type=int, default=5)
    args = p.parse_args()
    from playwright.sync_api import sync_playwright
    srv, url = serve(args.dist.resolve())
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=ARGS)
        ctx = browser.new_context(user_agent=ANDROID, viewport={"width": 412, "height": 915})
        ctx.add_init_script(WATCH)
        page = ctx.new_page()
        first = visit(page, url)
        print(f"first visit: api {first['api']:.2f} s, pasted {first.get('pasted', 0):.2f} s, analyse {first.get('analyse', 0):.2f} s")
        page.wait_for_timeout(3000)     # the Python build writes IndexedDB half a second after a change
        runs = []
        for i in range(args.runs):
            r = visit(page, url)
            if "error" in r:
                raise SystemExit(f"run {i}: {r['error']}")
            runs.append(r)
            print(f"reload {i + 1}: api {r['api']:.2f} s, pasted {r['pasted']:.2f} s, analyse {r['analyse']:.2f} s")
            page.wait_for_timeout(3000)
        for k in ("api", "pasted", "analyse"):
            xs = [r[k] for r in runs]
            print(f"{k:8} median {statistics.median(xs):.2f} s  (min {min(xs):.2f}, max {max(xs):.2f})")
        browser.close()
    srv.shutdown()


if __name__ == "__main__":
    main()
