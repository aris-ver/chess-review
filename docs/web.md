# Blundr: chess-review in the browser

**Blundr** (blundr.gr) is the free web version of chess-review, for friends and anyone else. The web build
shows that name in the title, the header and the shared puzzle-of-the-day result (`scripts/build_web.py`
renames them), while the desktop app stays "Chess Review". The engine and the Python code run on each visitor's
computer, so hosting stays near €0. The desktop app stays as it is and remains the fast option.

## Measured (i7-10750H, 6 cores, 2026-10-21)

One 68-position rapid game, 1M nodes, MultiPV 3:

| engine                         | time   | agrees with native SF19          |
|--------------------------------|--------|----------------------------------|
| native SF19, 6 engines         | 38.5 s | -                                |
| browser full net, 6 workers    | 88 s   | all 3 lines, 68/68 positions     |
| browser full net, 12 workers   | 88 s   | (hyperthreads add nothing)       |
| browser lite net, 6 workers    | 49 s   | best move on 39/68 only          |

The unchanged `analyse.write_results`, `db.connect` and `classify.classify_all` ran in Pyodide and, fed
with browser SF19 evals, classified all 67 moves field for field like the desktop app. Pyodide's first
load takes about 15 s; `book.load` takes 8 s there (3.8 s native), so the book's keys are precomputed.

## Shape

```
 page (main thread)                       Python worker (Pyodide)                 engine workers
 ──────────────────                       ───────────────────────                 ──────────────
 chess_review/static/index.html           chess_review, unchanged                 stockfish-19-single.js
   + web/shim.js: fetch("api/…")   ──►    web/bridge.py: serve.Handler    ──►     one per physical core,
     and fetch("p/…") go to the            with in-memory request/response         Threads=1, Hash=64,
     worker instead of the network         web/runner.py: Runner on asyncio        MultiPV 3, 1M nodes
                                           /data on IndexedDB (IDBFS)              ucinewgame per position
```

- **The page** is `chess_review/static/index.html`, as the desktop serves it. The web build adds one
  `<script src="web/shim.js">`; the shim wraps `window.fetch` so the page's relative `api/…` and `p/…`
  requests become messages to the Python worker. Everything else (themes, sounds) is a static file.
- **The Python worker** runs the existing package in Pyodide 314.0.7 (it ships DuckDB 1.5.1 and pyarrow 22;
  python-chess 1.11.2 has no wheel on PyPI, so the build makes one). It answers requests with `serve.Handler`
  itself: a request is fed to `do_GET`/`do_POST` through in-memory `rfile`/`wfile` and the raw HTTP response
  is handed back to the shim. So every route, file under `p/<id>/` and error message is the desktop's own,
  with no JavaScript copy of the logic. On the main thread Pyodide would freeze the page, hence the worker.
- **What touches the outside world** gets a browser stand-in, and only that:
  - `Runner` starts threads and `Analyser` a process pool, neither of which exists in Pyodide. `web/runner.py`
    is a `Runner` whose jobs are asyncio tasks, and its analyser sends FENs to the engine workers and feeds
    their `info` lines through python-chess's own parser into `analyse.evaluate_multipv`, as in the test.
    The job bodies (`pending_keys`, `write_results`, `site.write_game`, `classify.build`, ...) are the same calls.
  - Fetching games: chess.com and lichess both send `Access-Control-Allow-Origin: *`. Pyodide's `requests`
    goes over synchronous XHR, which a worker may use, so `ingest.py` should run as it is.
  - Files: `DATA` is `/data` in Pyodide's file system, mounted on IndexedDB and synced after every request that
    writes and after every batch of evals. Reviewed games and the eval cache never leave the browser.
  - `/api/fetch_image` (screenshot reader) and `/api/update` (desktop updater) have no browser equivalent;
    the web build hides those buttons.
- **Engines**: npm `stockfish@19.0.1`.
  - `stockfish-19-lite-single` (1.8 MB) loads at once, for the sandbox, trying moves and a puzzle's
    "why not" reply.
  - `stockfish-19-single` (99 MB) downloads in the background with a progress bar and is cached by the
    browser. Game reviews and personal-puzzle builds wait for it and use only it: lite disagrees on 29 of 68
    best moves, which would make reviews disagree with the desktop.
  - One worker per physical core (`hardwareConcurrency / 2`), each `Threads=1`, `Hash=64`, MultiPV 3,
    1M nodes, `ucinewgame` before every position, FEN = `fen_key + " 0 1"` (`fen.board_from_key`).
    Same settings as `analyse.py`, so the eval cache means the same thing in both apps.
  - Single-threaded builds need no `SharedArrayBuffer`, hence no COOP/COEP headers.
- **The puzzle library** (`chess_review/puzzle_packs/`, 1.6 MB) is static data in the Python file system.
  The puzzle of the day already comes from the date, so it needs no server.

## Hosting

- One **Cloudflare Worker** (`worker/`, free plan) serves `web-dist/` as static assets and runs code only for
  `/account/*` ([accounts.md](accounts.md)). Static requests are free and unmetered, but an asset may be 25 MiB at most.
- The 99 MB engine comes from **unpkg**, the npm CDN: `https://unpkg.com/stockfish@19.0.1/bin/stockfish-19-single.wasm`
  (`build_web.py --engine-wasm cdn`, versioned with the npm download). unpkg serves npm files of any size, with
  `Access-Control-Allow-Origin: *` and a year's `Cache-Control`; jsDelivr refuses a file that big (403). The page keeps
  it in Cache Storage after the first visit. R2 would also do, but it has to be enabled in the dashboard first and the
  file uploaded by hand at every engine update.
- Pyodide itself from its CDN (jsDelivr); self-host it later if the CDN is a worry.
- `scripts/build_web.py` assembles `web-dist/`: the page with the shim tag, `web/`, a zip of `chess_review/`
  plus the book keys and puzzle packs, the python-chess wheel and the lite engine. `python scripts/build_web.py
  --serve` serves it locally.
- The page says that the browser analyses about 2× slower than the desktop app and links the Windows
  download (GitHub Releases). The notice shows while Python and the engine load, and again for as long as a
  game is being analysed or waits to be. `web/shim.js` reads the `api/status` answers the page polls.

### Deploying to blundr.gr

1. **Move the domain's DNS to Cloudflare (you, at the registrar).** Cloudflare Registrar doesn't sell `.gr`,
   so blundr.gr stays at its Greek registrar. Add blundr.gr to a Cloudflare account on the free plan.
   Cloudflare then shows two nameservers. At the registrar, replace blundr.gr's nameservers with those two.
   Cloudflare marks the zone active once the change has spread, usually within hours and at most about 48 h.
   Nothing else changes at the registrar, and the domain is still renewed there.
2. The rest (database, email, Google, build, Worker, domains) is in [accounts.md](accounts.md#deploy). blundr.gr went
   live that way on 2026-10-22.

## Accounts (optional)

Guests can use everything. An account only keeps puzzle progress (puzzle rating and attempts, pack progress,
the daily streak, the personal-puzzle review schedule) across browsers. Reviewed games and the eval cache
stay in the browser. Built on **one Cloudflare Worker + D1** (`worker/`), which also serves the static site, with
sign-in through Lichess or Google. The privacy policy and terms are drafts to be checked. Design, local run and
deployment: [accounts.md](accounts.md).

## First slice (branch `web`)

```
python scripts/build_web.py --serve      # then open http://127.0.0.1:8200/
```

- `web/shim.js` (page), `web/py-worker.js` (a *module* worker: Chrome refuses `importScripts` of Pyodide from
  its CDN into a classic one), `web/engines.js` (pool), `web/py/chess_web/` (`bridge.py`, `runner.py`).
- Desktop changes: `serve.Runner` got `_spawn`, `_ended`, `_work`, `_failed` hooks (same behaviour) so
  `WebRunner` can run jobs as asyncio tasks. `tests/test_web_bridge.py` drives the bridge and `WebRunner` on
  CPython with a native Stockfish that hands back raw `info` lines, as the WASM pool does.
- Measured 2026-10-21 in Chrome, i7-10750H: Python ready in ~20 s on the first visit (Pyodide, DuckDB,
  pyarrow from jsDelivr, then cached). Pasted the 68-position benchmark game and pressed Analyse: done in
  125 s (6 engines; the bare engine benchmark was 88 s, so the gap is writing the review after each batch
  and syncing IndexedDB, worth tuning). **All 67 labels identical to the desktop app with SF19.** The review
  is still there after a reload (IndexedDB).
- Adding a chess.com profile reached chess.com from the worker (`requests` over synchronous XHR got the
  archive list), but chess.com answered 404 for the first month to every client that day, curl included,
  so that path is not verified yet.

Load order: Pyodide starts loading the moment the page opens and the engine downloads alongside it. The page
draws at once, but every `api/` request waits for Python, puzzles included, about 20 s on a first visit.
A puzzle visitor could skip that wait if the puzzle routes (static data plus attempts) were answered before
Python is up. That is a later step, and it would mean JavaScript for those routes.

Not yet: the sandbox and puzzle engine replies (lite engine, `/api/eval`, `/api/explore`, `/api/eval_stream`),
personal-puzzle builds and `analyse_all` (async versions of those jobs), the new-games scan, hiding the
desktop-only buttons (screenshot reader, updater), ingest not blocking the worker (async fetch).
