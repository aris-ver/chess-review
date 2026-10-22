# Blundr: chess-review in the browser

**Blundr** (blundr.gr) is the free web version of chess-review, for friends and anyone else. Since v0.6.0 the
Windows app is called Blundr too (`Blundr.exe`; its folder, zips and data folder keep the chess-review name, so
installed copies update and keep their data). The engine and the Python code run on each visitor's
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
- **The Python worker** runs the existing package in Pyodide 314.0.7 (it ships DuckDB 1.5.1, the one
  binary package the app uses; python-chess 1.11.2 has no wheel on PyPI, so the build makes one). It answers requests with `serve.Handler`
  itself: a request is fed to `do_GET`/`do_POST` through in-memory `rfile`/`wfile` and the raw HTTP response
  is handed back to the shim. So every route, file under `p/<id>/` and error message is the desktop's own,
  with no JavaScript copy of the logic. On the main thread Pyodide would freeze the page, hence the worker.
- **What touches the outside world** gets a browser stand-in, and only that:
  - `Runner` starts threads and `Analyser` a process pool, neither of which exists in Pyodide. `web/runner.py`
    is a `Runner` whose jobs are asyncio tasks, and its analyser sends FENs to the engine workers and feeds
    their `info` lines through python-chess's own parser into `analyse.evaluate_multipv`, as in the test.
    The job bodies (`pending_keys`, `write_results`, `site.write_game`, `classify.build`, ...) are the same calls.
  - Fetching games: chess.com and lichess both send `Access-Control-Allow-Origin: *`. `ingest.py`'s fetches are
    generators of the requests they want made; the desktop makes them with `requests` (`ingest.run`), the web
    runner with the browser's `fetch`, awaited (`chess_web.runner.drive`). Pyodide's `requests` would do them over
    synchronous XHR, which blocks the worker for the whole fetch: no status poll answered, the page stuck at
    "fetching 0/0" for minutes and then missing the job's end. Every request has a timeout (and a streamed lichess
    export one per read), so a fetch always ends, and a failure is the job's error, shown on the page. Only "no such
    player" removes the profile; after any other failure, opening it fetches again.
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
  download (GitHub Releases). The notice shows while Python and the engine load (the engine with a progress bar;
  its size comes from `config.js`, as unpkg sends no `Content-Length`), and again for as long as a game is being
  analysed or waits to be. `web/shim.js` reads the `api/status` answers the page polls. Its × closes it, and the
  speed note and the lit "Download the app" button stay off from then on (localStorage); later visits still show
  the loading lines.

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

Load order: Pyodide starts loading the moment the page opens, then DuckDB, then the 99 MB engine, so
none of them share the bandwidth. The page draws at once (the home tiles' covers don't wait for the profile list).

A reload downloads next to nothing (jsDelivr sends a year's `Cache-Control`; the site's files come back as 304s),
but Pyodide compiles every package's WebAssembly again at each visit. Measured 2026-10-22 on blundr.gr, all from
cache: 12.2 s before the first `api/` answer, of which pyarrow ~3 s, pandas ~3 s (pulled in by pyarrow, never
imported), DuckDB 1.2 s, numpy 1 s, the runtime 1.8 s. So:

- Python starts without DuckDB. `web/py/chess_web/later.py` puts a placeholder module in its place, so
  `chess_review` imports as it is; the home screen, the puzzles and the settings answer without it (the puzzle
  pack ships as `puzzles.json`). A request that reaches it raises `NotLoaded`; the worker waits for
  the package and asks again. POSTs other than settings and puzzle results wait for it up front, so none runs
  twice. For the placeholder, the modules whose signatures name DuckDB types have
  `from __future__ import annotations`.
- pyarrow is gone (below), so pandas and numpy with it.

Reload of the local build after that: status, profiles and puzzles answer at 3.6 s; DuckDB and pyarrow are in
at about 8–9 s, when a pasted game or a review goes through.

**No pyarrow** (branch `drop-pyarrow`, 2026-10-22). It only turned query results into dicts and wrote the three
parquet files. Now `chess_review/db.py` does both with DuckDB: `dicts()` builds rows from `cursor.description` and
`fetchall()`, and `write_parquet()` writes the rows as one JSON array to a file beside the target and has DuckDB
`COPY` it to parquet through `read_json` with the schema's columns (binding them as parameters takes minutes). The
schemas are `(name, SQL type)` tuples (`GAMES_SCHEMA`, `POSITIONS_SCHEMA`, `MOVES_SCHEMA`). Normalising and
classifying two real profiles with `main` and with the branch gave the same Arrow schemas and the same rows. The
web heavy stage is `loadPackage('duckdb')` alone: 13 MB less on a first visit (pyarrow 10 MB, numpy 3 MB).
Reloads of the local build: Python's first answer at 3.4–4.5 s, a POST that waits for DuckDB answered at
4.7–6.2 s (was 8–9 s locally, 9.4–9.7 s on blundr.gr), so actions are possible about 1.3 s after Python. A pasted
game reviewed end to end in the browser, labels written. `scripts/build_puzzle_pack.py` still uses pyarrow (to read
the zstd CSV and write the pack); it is a build tool, not part of the app.

Then:

- **The home screen from the last visit.** `web/shim.js` keeps Python's last answers to `api/profiles` and
  `api/puzzles/{packs,themes,sources}` in localStorage and hands them back at once while Python loads. The request
  still goes to Python, and if its answer differs, the home screen is drawn again (a `hashchange`). Only Python's
  own answers are kept, so no logic is copied into JavaScript. Measured on a reload of the local build: the profiles
  show at 0.2–0.4 s, Python's answer comes at 3.4 s, and a stale copy is replaced as soon as it does.
  Now also a profile's `games.json`, its `api/profiles/<id>/unseen` and each game's review file under
  `p/`, all in Cache Storage (`blundr-kept`; games.json is 150 KB a profile): a profile or a review opened by a reload
  shows at ~0.4 s instead of ~3.6 s. When Python's answer differs, or is gone (a deleted profile), the screen it was
  asked for is drawn again. Not the puzzles, which change with the date or at random.

Measured on blundr.gr on 2026-10-22 (before pyarrow was dropped), all from cache: Python's first answer at
3.6–4.5 s; DuckDB and pyarrow in at 9.4–9.7 s, the engine ready from Cache Storage at 8–10 s. Only actions wait for those (Analyse, Refresh games, a
new profile, a pasted game): showing a profile or a review needs Python alone. Other findings:

- The page's synchronous `XMLHttpRequest` for `api/settings` went past the shim to the network (404). The shim now
  answers it with "no server copy" (`null`): on the web localStorage is the one store, so nothing is sent to Python.
- The stale-page check (`HEAD index.html`) got a 307 on blundr.gr and no `Last-Modified`, so it did nothing at the
  cost of two requests per route change. It now asks for `.` and takes `ETag` as well, and stops asking a server
  that sends neither.
- blundr.gr sends HTML without an `ETag` (JS and JSON have one), so the 84 KB page comes again in full at every
  reload. Likely a Cloudflare zone feature that rewrites HTML (Email Address Obfuscation, Automatic HTTPS Rewrites
  or the like): with it off, the page is a 304 and the stale-page check works on the web too.
- **A smaller `app.zip`.** It was 2.5 MB on the critical path of a first visit, mostly the puzzle pack. Now it's
  240 KB: the pack is `puzzles.json` beside it (about 2 MB as sent compressed), which the worker fetches alongside
  Python and writes into `/app`. A request that reaches the pack first raises `PackNotLoaded` (a `NotLoaded`) and
  waits for that file alone; puzzle POSTs wait for it up front. `chess_review/sound_packs/` (the themes' sound
  sources) is no longer in the zip.

Not yet: the sandbox and puzzle engine replies (lite engine, `/api/eval`, `/api/explore`, `/api/eval_stream`),
personal-puzzle builds and `analyse_all` (async versions of those jobs), the new-games scan, hiding the
desktop-only buttons (screenshot reader, updater), ingest not blocking the worker (async fetch).
