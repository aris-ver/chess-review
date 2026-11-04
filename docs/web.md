# Blundr: chess-review in the browser

**Blundr** (blundr.gr) is the free web version of chess-review, for friends and anyone else. Since v0.6.0 the
Windows app is called Blundr too (`Blundr.exe`; its folder, zips and data folder keep the chess-review name, so
installed copies update and keep their data). The engine and the server code run on each visitor's computer, so
hosting stays near €0. The desktop app remains the fast option.

Since the JS port's step 5 ([js-port.md](js-port.md)) the browser runs the same JavaScript server as the desktop
(`js/server`), not Python: no Pyodide, no DuckDB, nothing to start but ES modules and SQLite's WASM build. Pyodide
loads once more only in a browser that still holds the Python build's data, to move it over (below).

## Measured (i7-10750H, 6 cores, 2026-10-21)

One 68-position rapid game, 1M nodes, MultiPV 3:

| engine                         | time   | agrees with native SF19          |
|--------------------------------|--------|----------------------------------|
| native SF19, 6 engines         | 38.5 s | -                                |
| browser full net, 6 workers    | 88 s   | all 3 lines, 68/68 positions     |
| browser full net, 12 workers   | 88 s   | (hyperthreads add nothing)       |
| browser lite net, 6 workers    | 49 s   | best move on 39/68 only          |

`tests/test_web_browser.py` checks it end to end: a pasted game reviewed in the browser with the full WASM engine gets
the labels (and best moves) the desktop's server gives it with native Stockfish at the same node count.

## Startup: the phone bench

`scripts/bench_web_startup.py [--dist web-dist] [--runs 5]`: a local build in headless Chromium under WSL, Android user
agent (lite engine), reloaded with everything cached; it times the worker's first `api/` answer and, asked as soon as
the page has loaded, a pasted game (`POST api/pgn`) and its Analyse (`POST api/p/<id>/analyse/<game>`). Medians of 5
reloads, 2026-10-24:

| build                          | first api answer | pasted game answered | Analyse accepted |
|--------------------------------|------------------|----------------------|------------------|
| Python (Pyodide), ba18a8a      | 4.15 s           | 7.64 s               | 7.72 s           |
| JS (this build)                | 0.37 s           | 0.69 s               | 0.70 s           |

(The Python build's figure was ~14 s before its own tuning, see [js-port.md](js-port.md); the 4 s above is after
dropping pyarrow and loading DuckDB late.)

## Shape

```
 page (main thread)                 tab worker (one per tab)              engine workers (the leader's)
 ──────────────────                 ────────────────────────              ─────────────────────────────
 chess_review/static/index.html     js/web/worker.js                      stockfish-19-single.js
   + web/shim.js: fetch("api/…") ─►   tabs.js: leader or relay      ─►    one per physical core,
     and fetch("p/…") go to the       leader: app.js = js/server's         Threads=1, Hash=64,
     worker instead of the network    serve() over SQLite WASM (OPFS),     MultiPV 3, 1M nodes
                                      OPFS files, fetch, web/engines.js    ucinewgame per position
```

- **The page** is `chess_review/static/index.html`, as the desktop serves it, plus one `<script src="v/<version>/web/shim.js">`.
  The shim wraps `window.fetch` so the page's relative `api/…` and `p/…` requests become messages to the tab's worker
  (`js/web/worker.js`, a module worker). Everything else (themes, sounds) is a static file.
- **The server** is `js/server` unchanged: `serve()` builds the router and job runner over an `env` that
  `js/web/app.js` makes from the browser's adapters, as `js/desktop/main.js` does from the data folder:
  - `store`: `Store` over `webSqlite()` (`js/web/db.js`): SQLite's WASM build with the databases in OPFS through the
    "opfs-sahpool" VFS (no COOP/COEP headers needed). Without OPFS (some private windows) it falls back to memory and
    says so in the console: nothing is kept that visit.
  - `files`: `opfsFiles('data')` (`js/server/profiles-files.js`): meta.json, raw/, pgn/, the review files under
    site/, settings, sync's files.
  - `fetch`: the browser's. chess.com and lichess both send `Access-Control-Allow-Origin: *`; no User-Agent is set
    (that would cost a CORS preflight).
  - `pack`, `packs`: `puzzles.json` and `packs.json` beside the site. The pack (8 MB of JSON, ~2 MB as sent) is fetched
    alongside the start; puzzle requests and POSTs wait for it, the rest doesn't.
  - the opening book from `book_keys.txt` (`loadBook`).
  - no `account` (the page calls the Cloudflare Worker for `/account/*` itself) and no `updater`.
- **Answers** go back as `{type: 'response', id, status, headers: [[k, v]], body}`. `/api/eval_stream` (the sandbox's
  live engine) is a `response` with `stream: true`, then `chunk`s of NDJSON and an `end`; the shim hands the page a
  `ReadableStream`. When the page aborts the fetch or cancels the stream, the shim sends `abort` and the engine stops.
- `/api/fetch_image` (screenshot reader) and `/api/update` (desktop updater) have no browser equivalent; the web
  build hides those buttons. The page's synchronous `XMLHttpRequest` for `api/settings` is answered `null` by the shim
  (localStorage is the one store on the web).

### Several tabs, one database

The sahpool VFS opens its files with OPFS sync access handles, which only a dedicated worker can create and only one
holder at a time can keep. So every tab starts its own worker and the workers elect a leader with **Web Locks**
(`js/web/tabs.js`):

- The worker holding the lock `blundr-leader` opens the databases and runs the server, the job runner and the
  engines; it answers its own page directly and the other tabs over a `BroadcastChannel('blundr')`. The others relay
  their page's requests to it and its answers back.
- Each worker also holds `blundr-tab:<id>` for its life. The leader waits on that lock to learn that a tab went away
  and stops what it was doing for it (an open eval stream holds an engine).
- When the leader's tab closes, its lock goes, the next worker in the queue opens the databases, announces itself,
  and the other tabs send again whatever was still unanswered (the leader skips a request it has already taken). A
  stream the old leader was sending ends. A job that was running in the closed tab is lost (Analyse again); builds of
  personal puzzles carry on, as after a reload.
- The loading lines (`progress` messages) go to every tab; a tab that opens later gets the latest ones.

Why not a SharedWorker: it cannot create OPFS sync access handles (only dedicated workers can, and the pool needs
them), and Chrome on Android has long had none. Web Locks and BroadcastChannel exist, in dedicated workers too,
in every browser that has the sahpool VFS (Safari 16.4+, Chrome 102+, Firefox 111+). Without Web Locks a worker
simply leads; a second tab then fails to open the pool. Known limit: iOS suspends background tabs, so a foreground tab
whose leader is a suspended background tab waits until iOS discards or resumes it.

### The one-time move from the Python build

The Python build kept DATA in Pyodide's IDBFS, an IndexedDB database named `/data`. Before the `Store` opens
anything, the leader calls `migrateOnce` (`js/web/legacy.js`):

1. Nothing to do when `data/pyodide-migration.json` says it's done, or when there's no IndexedDB `/data`
   (`indexedDB.databases()`, or an aborted open where that's missing).
2. Otherwise Pyodide loads from its CDN (`legacy.pyodide` in `web/config.js`, the version that wrote the data) with
   python-chess's wheel and `legacy/app.zip`, which holds only `chess_review/migrate_sqlite.py` and what it imports
   (zipped by the build from the repo's `legacy/`, where they and the wheel are frozen).
   `/data` is mounted and synced in.
3. `migratePyodide` (`js/web/migrate.js`) runs the export into Pyodide's memory, imports each SQLite file into the
   pool, checks them against the export's counts and copies the other files (meta.json, raw/, pgn/, site/, settings…)
   into OPFS, skipping `web-cache/`, logs and `serve.pid`; the marker `sqlite-export.json` is written last.
4. Then every game is classified again once from the cached evals (`reclassifyAll`: site, classify, aggregates; the
   JS fingerprints games its own way), and the server starts.
5. `pyodide-migration.json` records the outcome. A failure is tried again on the next two visits, then given up.
   IndexedDB is left as it was; deleting it is for later.

`legacy/` and Pyodide's URL are fetched by no other browser. The Python app is gone from the repo (step 7), so
`legacy/` keeps what the move needs, frozen: `chess_review/{__init__,config,fen,migrate_sqlite}.py` as the last Python
release had them, python-chess 1.11.2's wheel (PyPI has only its sdist), and `make_fixture.py`, a data folder as the
Python build left it, for the tests. Dropping the move means deleting `legacy/`, `js/web/legacy.js` and the `legacy`
entry in `web/config.js`; browsers that never came back since the switch would then start empty.

## Engines

npm `stockfish@19.0.1`, run by the leader as a pool of Web Workers (`web/engines.js`), the engine interface
`js/core/engine.js` describes (`search`, `stream`, `load`, `name`, `size`).

- Computers: `stockfish-19-single` (99 MB), one worker per physical core (`hardwareConcurrency / 2`), each
  `Threads=1`, `Hash=64`, MultiPV 3, 1M nodes, `ucinewgame` before every position: the same settings as the desktop,
  so the eval cache means the same thing in both apps. It downloads once the server answers (it would only share the
  bandwidth with what the page waits for), with a progress bar, and stays in Cache Storage.
- Phones and tablets (the shim decides: iOS, iPadOS, Android, "Mobi"): one `stockfish-19-lite-single` (2 MB, a smaller
  net) with `Hash=16`; the full engine compiled once per core is more memory than iOS gives a tab. Its evals differ
  a little from the full engine's; evals never leave the browser, so the two never mix.
- Single-threaded builds need no `SharedArrayBuffer`, hence no COOP/COEP headers.

## Hosting

- One **Cloudflare Worker** (`worker/`, free plan) serves `web-dist/` as static assets and runs code only for
  `/account/*` ([accounts.md](accounts.md)). Static requests are free and unmetered, but an asset may be 25 MiB at most.
- The 99 MB engine comes from **unpkg**, the npm CDN: `https://unpkg.com/stockfish@19.0.1/bin/stockfish-19-single.wasm`
  (`build_web.js --engine-wasm cdn`). unpkg serves npm files of any size, with `Access-Control-Allow-Origin: *` and a
  year's `Cache-Control`; jsDelivr refuses a file that big (403).
- `scripts/build_web.js` assembles `web-dist/`: the page with the shim tag, `v/<version>/` (the code: `web/` shim,
  engines and config, and `js/` core, server minus the Node adapters, web, vendor: chessops and SQLite WASM; no
  tests), `web/engine/`, `book_keys.txt`, `puzzles.json`, `packs.json` and `legacy/`. `node scripts/build_web.js
  --serve` serves it locally on port 8200 with the headers blundr.gr sends (`_headers`, ETags, gzip; `--log` prints
  each request).
- **The code loads as it is, with no bundler** (about 45 modules), and fast: `<version>` is a hash of the code, so
  `_headers` lets browsers keep `/v/*` a year (`immutable`) and a returning visitor asks for none of it; only
  `index.html` (and the other files outside `v/`) is asked again every visit, so a deploy shows at once. The build
  also lists every module the worker fetches as it starts (its static imports, SQLite's `import()` and WASM), and the
  page's head asks for them all at once: on a first visit they arrive together instead of one round trip per level of
  imports. On a phone (Slow 4G, 4× CPU) the worker's first word came after 5.4 s on a first visit and 4.4 s on a
  return (47 revalidations), now after 2.7 s and 1.2 s (none).
- **Security headers** (`_headers` `/*`, written by the build, which `--serve` sends too): HSTS for a year on
  blundr.gr only (no `includeSubDomains`, no `preload` until every subdomain is known to be on https: preload is slow
  to take back), `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, no framing (`X-Frame-Options: DENY`
  and `frame-ancestors 'none'`), and a `Permissions-Policy` that turns off camera, microphone, location and the other
  devices. The `Content-Security-Policy` is made per build: scripts only from the site, the page's two inline scripts
  by their SHA-256 (no `'unsafe-inline'` for scripts), WebAssembly by `'wasm-unsafe-eval'` (never `'unsafe-eval'`) and
  Pyodide's folder for the one-time move; fetches only to the site, the chess.com and lichess APIs, the engine's unpkg
  URL and Pyodide's folder. Styles may be inline (the page and the shim set them everywhere). The sign-in's trip to
  Lichess or Google is a navigation, which the policy doesn't limit. A new place the app fetches from needs adding in
  `csp()`, or the browser blocks it (the console says so). The desktop app serves the same page without these.
- **The engine is checked**: the build bakes the SHA-256 of npm's own copy of the `.wasm` into `config.js`
  (`engineSha256`, `engineLiteSha256`), and `web/engines.js` hashes the downloaded bytes (`crypto.subtle`) before
  keeping or running them. A file from unpkg that doesn't match is refused, the reason in the console, as a failed
  engine load; a kept copy that doesn't match is dropped and downloaded again.
- **A tab open across a deploy** keeps its worker, which has loaded all its code. The site keeps only the latest
  version, so if such a page's worker fails to start (its version is gone, 404), the shim reloads the page once,
  which brings the new version.
- The page says that the browser analyses about 2× slower than the desktop app and links the Windows download
  (GitHub Releases). The notice shows while the app and the engine load, and again while a game is analysed or waits
  to be; its × turns the speed note off for good (localStorage).
- **The home screen from the last visit**: the shim keeps the server's last answers to `api/profiles`,
  `api/puzzles/{packs,themes,sources}`, a profile's `games.json` and `unseen`, and each review file, in Cache Storage
  (`blundr-kept`), and hands them back at once while the app starts; if the real answer differs, the screen is drawn
  again. A sync switch or release (a log in, a log out) empties it.

### Deploying to blundr.gr

1. **Move the domain's DNS to Cloudflare (you, at the registrar).** Cloudflare Registrar doesn't sell `.gr`,
   so blundr.gr stays at its Greek registrar. Add blundr.gr to a Cloudflare account on the free plan.
   Cloudflare then shows two nameservers. At the registrar, replace blundr.gr's nameservers with those two.
   Cloudflare marks the zone active once the change has spread, usually within hours and at most about 48 h.
2. The rest (database, email, Google, build, Worker, domains) is in [accounts.md](accounts.md#deploy). blundr.gr went
   live that way on 2026-10-22. `.github/workflows/deploy-web.yml` builds and deploys on pushes to main that touch
   `chess_review/`, `js/`, `web/`, `worker/` or the build script.

Findings from the live site that still hold: blundr.gr sent HTML without an `ETag` (JS and JSON have one), so the
page came in full at every reload, likely a Cloudflare zone feature that rewrites HTML (Email Address Obfuscation,
Automatic HTTPS Rewrites); with it off, the page is a 304. The stale-page check asks for `.` and takes `ETag` as well
as `Last-Modified`.

## Accounts (optional)

Guests can use everything. An account only keeps puzzle progress (puzzle rating and attempts, pack progress,
the daily streak, the personal-puzzle review schedule) across browsers. Reviewed games and the eval cache
stay in the browser. Built on **one Cloudflare Worker + D1** (`worker/`), which also serves the static site, with
sign-in through Lichess or Google. The page calls `/account/*` on the Worker itself and syncs through the local
`api/sync/*` routes, which move the databases table by table on the web (`Sync.copyDb`; checked on SQLite WASM in
`js/web/app.test.js`). Design, local run and deployment: [accounts.md](accounts.md).

## Tests

- `npm test`: `js/web/tabs.test.js` (leader election, relaying, a leader going, streams stopped when their tab goes,
  over fake Web Locks and channel), `js/web/app.test.js` (the server as messages on SQLite WASM, eval_stream, the
  migration's skip/once/retry logic, sync's database copy).
- `pytest tests/test_web_browser.py` (Python, Playwright, headless Chromium with the GPU off: under WSL it otherwise
  draws no frames and the page waits forever on its board image; it builds the site with Node ≥ 22.13 first): profiles
  from chess.com and lichess a page at a time, failures, a reload keeping the data, two tabs and the second taking
  over, the move from a seeded Python IndexedDB (`legacy/make_fixture.py`'s data; needs duckdb and the network for
  Pyodide) and a WASM review against the desktop's labels (needs bin/stockfish).
