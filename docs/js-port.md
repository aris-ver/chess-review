# Porting chess-review to JavaScript

Decided 2026-10-23: the whole project, Blundr on the web and the Windows app, moves from Python to JavaScript,
one step at a time. Why: on a phone, Blundr spends 15–20 s starting Python before it answers anything, and only
about 0.3 s of that is compiling WebAssembly (measured below). Plain JavaScript starts in well under a second.

## Measured before the port (2026-10-23)

Local build in headless Chromium under WSL, Android user agent (lite engine). That setup is about 4× slower than
the i7-10750H in real Chrome, so it stands in for a mid-range phone. Reload, everything from cache:

| step                                        | time           |
|---------------------------------------------|----------------|
| downloads                                   | done by 1–2 s  |
| compiling pyodide.asm.wasm                  | 0.3 s          |
| `loadPyodide()` (interpreter start)         | 4–8 s          |
| `import chess_review.serve`                 | 3.6 s: requests 1.4–2.1, http.server 0.6–1.2, python-chess 0.6–0.8, ours ~1 |
| Python's first answer                       | ~14 s          |
| DuckDB in (Analyse, a pasted game)          | +6 s, so ~20 s |

These are the numbers to beat. Measure the JS build the same way at step 5.

## Decisions

- **Plain JavaScript ES modules**, no build step, like `web/` and the page: the same files run in the browser
  and in Node. JSDoc where types help.
- **chessops** (lichess's chess library) replaces python-chess: FEN, SAN, legal moves, attacks and PGN with
  comments (the clocks). One vendored ESM bundle, so the web build stays without a bundler.
- **SQLite** replaces DuckDB/Parquet: SQLite WASM (~1 MB, a database in OPFS) on the web, `node:sqlite` on the
  desktop (Node ≥ 22.13, which current Electron ships). One SQL dialect, so the queries in `aggregates.py`,
  `analyse.py` and `db.py` port almost as they are. Existing data is migrated once (steps 5 and 6).
- **Electron** for the Windows app. The ported server runs in Electron's Node with native Stockfish and the data on
  disk, as Python does now, and the window shows the same page. The zip grows by about 80 MB. Updates that change
  only the app code stay small (only `app.asar` changes).
- **The page stays as it is.** `chess_review/static/index.html` and `account.js` already are JavaScript and keep
  asking for `api/…` and `p/…`. Only what answers those requests changes.
- **Parity is the test.** Each ported module is checked against the Python one on the same inputs, field for field,
  before anything switches over. The labels must stay those of the desktop app: the logic and thresholds are
  copied as they are, not refitted along the way.

## Layout

```
js/core/     no I/O: fen, pov, accuracy, critical, book, explain, facts, classify, analyse (MultiPV → evals),
             normalise, puzzles, packs, own_puzzles, explore, aggregates. Runs anywhere.
js/server/   the routes of serve.Handler as handle(method, path, body) → { status, headers, body },
             the job runner (analysis queue, status), profiles, site (review files), ingest, sync, account.
             Talks to the outside through small adapters: db, files, fetch, engine pool.
js/web/      the browser's adapters (SQLite WASM in OPFS, WASM Stockfish pool) and the worker that replaces
             web/py-worker.js.
js/desktop/  Electron: main process, the HTTP server on 127.0.0.1 around js/server, native Stockfish
             processes, the updater.
```

## Steps

Python keeps shipping both apps until step 5 (web) and step 6 (desktop). Each step is one session (or more) and
ends in commits on `main` with its tests passing.

0. **Foundations.** The `js/` layout, `node:test` as the runner (`npm test` at the root), chessops vendored.
   A parity harness: `scripts/dump_parity.py` runs the Python functions over the fixtures (`tests/fixtures`,
   `tests/golden`) and writes their inputs and outputs to `tests/parity/*.json`, and the JS tests replay them.
1. **The pure core.** fen, pov, accuracy, critical, book (from `book_keys.txt`), explain, facts, classify, and
   `analyse.evaluate_multipv` with the UCI `info` parsing that python-chess does now. Done when every golden game
   classifies field for field as in Python.
2. **Games in.** normalise (PGN → game, position and move rows), export, and ingest's chess.com and lichess
   requests (the request generators become async functions over an injected `fetch`).
3. **Storage and the rest of the logic.** The SQLite schema (games, positions, moves, the eval cache, puzzle
   progress) behind one `db` interface with two implementations; then aggregates, profiles, site, puzzles, packs,
   own_puzzles, explore.
4. **The server.** `serve.Handler`'s routes in `js/server`, and the job runner. A route-level parity test runs the
   Python handler and the JS one on the same data and compares the answers.
5. **The web switch.** The JS worker replaces Pyodide. Existing browser data (Pyodide's IndexedDB) is converted
   once: if it's there, the old Python stack loads one last time, exports it and is never loaded again. Measure
   startup with the phone bench, deploy blundr.gr, remove Pyodide from `build_web.py`.
6. **The desktop switch.** Electron around `js/server`: the window, native Stockfish (one process per physical
   core, as `analyse.py` does), the account and sync, the updater, the release build in CI. The last Python release
   is the bridge: it writes its data to the SQLite file with Python's own `sqlite3`, and its updater fetches the
   Electron build as a full download. The memory notes on releases (push the tag alone, desktop notes in a draft)
   still apply.
7. **Retire Python.** Delete `chess_review/*.py`, `launcher.py`, `web/py`, the PyInstaller packaging and the
   Python tests that have JS twins; update README, `docs/web.md` and `docs/accounts.md`. Build-only scripts
   (`build_puzzle_pack.py`, the sound synth) may stay Python. Done (see Status).

Steps 1, 2 and 3 can partly run side by side (different modules); step 4 needs them, and 5 and 6 need 4.

## Who does what

Almost every Python module imports `db` and `profiles`, so storage comes first and the rest is grouped around it.
Each line below is one session. Sessions in a round run side by side, each in its own worktree and branch
(`js-port/<name>`), and touch only their own files. The coordinating session checks each branch (`npm test`,
`pytest`), merges it into `main` and then starts the sessions that waited for it. A session doesn't edit this file;
it reports what it did, and the coordinator updates **Status**.

| round | session        | what                                                                                 | needs        |
|-------|----------------|--------------------------------------------------------------------------------------|--------------|
| 1     | `storage`      | SQLite schema, the `db` interface (`node:sqlite`, SQLite WASM in OPFS), profiles, the database halves of analyse and classify | steps 0–1 |
| 1     | `games-in`     | normalise as rows (no writes yet), ingest over an injected `fetch`, export            | steps 0–1    |
| 1     | `electron`     | Electron shell, native Stockfish pool, the engine interface, a CI zip build           | steps 0–1    |
| 2     | `aggregates`   | aggregates; normalise and ingest wired to the database                                | storage, games-in |
| 2     | `site`         | site (review files), explore                                                          | storage      |
| 2     | `puzzles`      | puzzles, packs, own_puzzles                                                           | storage      |
| 2     | `migration`    | desktop DuckDB/Parquet → SQLite (bridge release), Pyodide IndexedDB → SQLite          | storage      |
| 3a    | `router`       | router, job runner, route parity test, profile/game/analysis routes                   | round 2      |
| 3b    | `routes-puzzles` | puzzle and own-puzzle routes                                                        | router       |
| 3b    | `routes-rest`  | account, sync, settings and the rest of `serve.py`                                    | router       |
| 4     | `web-switch`   | step 5                                                                                | round 3      |
| 4     | `desktop-switch` | step 6                                                                              | round 3, electron |
| 5     | `retire`       | step 7                                                                                | round 4      |

## Status

**Steps 0 and 1 are done (2026-10-23).** chessops 0.15.1 is vendored as `js/vendor/chessops.js` by
`scripts/vendor_chessops.sh`. `npm test` replays the parity dumps, `tests/golden/clocks.json` and (when dumped
with `--local`) all 249 of the local games: the JS matches Python field for field. Floats are compared at 1e-9
relative, because V8's `Math.exp` and `Math.log` differ from libm in the last bits; everything else matches
exactly.

`js/core/chess.js` puts python-chess's semantics on top of chessops where they differ: moves are generated in
python-chess's order, castling is written king-to-square (`e1g1`, not chessops' king-takes-rook `e1h1`), and an en
passant square only counts on the rank python-chess accepts (chessops allows it from the wrong rank on a board
whose turn was flipped; a regression case for that is in `scripts/dump_parity.py`'s `EXTRA_LINES`).

**Round 1 is done and merged (2026-10-23).** `npm test` (Node ≥ 22.13) and `pytest` pass on `main`.
- `storage`: `js/server/db.js` (`Store`, drivers `nodeSqlite` in `db-node.js` and `webSqlite` in `js/web/db.js`),
  `profiles.js`, the database halves of analyse and classify. Matches Python row for row (`dump_storage_parity.py`).
  Not ported yet: `migrate_legacy` and the CLI's `resolve`.
- `games-in`: `js/core/normalise.js` (rows, no writes) and `js/server/ingest.js` over an injected `fetch`. Two
  deliberate differences: a standard game with an unreadable FEN tag is skipped (Python fails the whole build), and a
  `Retry-After` that isn't whole seconds falls back to the normal backoff. `export.py` is DuckDB `COPY` SQL only.
- `electron`: `js/desktop/` (window, `makeServer({ api })`, the native pool), the engine interface in
  `js/core/engine.js` (which `web/engines.js` already matches), a manual-only Windows zip workflow (not run yet) and the
  updater plan in `js/desktop/README.md`. Still to port from `launcher.py`: seeding the book, removing old exe names,
  clearing the downloaded-file mark. The last Python release needs an "electron" update type.

**Decided 2026-10-23:**
- **Several tabs on the web share one worker:** the databases are opened once (a SharedWorker, or a leader tab
  elected with Web Locks), and every tab works fully. That's for `web-switch`.
- **The JS fingerprints games its own way**, so every game is reclassified once after the switch. That's
  classification only, from cached evals.

**Round 2 is done and merged (2026-10-23).** `npm test` and `pytest` pass on `main`. Everything matches Python on the
fixtures and on the two local profiles.
- `aggregates`: `js/server/aggregates.js`, `export.js` (CSV byte for byte as DuckDB's `COPY`), and `games.js`, the
  fetch-to-rows functions round 3 calls (`fetchProfile`, `refreshProfile`, `addPgn`, …). `profiles.js` gained
  `resolve` and `migrateLegacy`. Where SQLite differs from DuckDB (rounding done in JS, `NULLS LAST`, `any_value`), the
  code says so.
- `site`: `js/server/site.js` (games.json and the review files; `JSON.stringify` output, so `50` where Python wrote
  `50.0`, and the page reads both the same) and `explore.js` (`Explorer`, with `position(fen)` for `/api/eval`).
- `puzzles`: `js/server/puzzles.js`, `packs.js`, `own-puzzles.js`. Packs are read through `read` functions.
- `migration`: `chess_review/migrate_sqlite.py` (off by default: `ENABLED` or `CHESS_REVIEW_SQLITE_EXPORT=1`),
  `js/web/migrate.js` (`migratePyodide`) and `js/server/migrate.js` (`readMarker`, `verify`). Not yet run in a real
  browser.

**Round 3a is done and merged (2026-10-23).** `npm test` and `pytest` pass on `main` (the Playwright tests in
`tests/test_web_browser.py` time out in WSL on `main` too, before and after the merge, so they're the environment).
- `router`: `js/server/jobs.js` (the job runner: queue, `api/status`, progress, the new-games badge, builds
  bookkeeping, analyse, analyse_all, ingest, older, refresh) and `js/server/router.js` (`Router.handle`, `serve()`,
  `fillPieces`). `stream(fen, multipv)` in both engine pools runs `go infinite`; its `return()` sends `stop`. The
  desktop answers through the router (`js/desktop/server.js`, `main.js`). `scripts/dump_router_parity.py` →
  `tests/parity/router.json`: 68 requests answer as `serve.Handler` does.

**Round 3b is done and merged (2026-10-23); step 4 is done.** No route answers 501 any more. `npm test` and
`pytest` pass on `main`. The routes beyond `router.js` live in their own modules, which `router.js` asks first
(`ROUTES`), each with a `work` table of job kinds merged into the Runner's; the helpers they share are in
`js/server/http.js`.
- `routes-puzzles`: `js/server/routes-puzzles.js`, every `/api/puzzles/*` route and the `build` and `puzzles` jobs
  (`extendPuzzles`). `scripts/dump_routes_puzzles_parity.py` → `tests/parity/routes-puzzles.json` (95 steps, with a
  frozen clock and a library sample). A non-object JSON body reads as missing keys (Python: a 500).
- `routes-rest`: `js/server/routes-rest.js` with `account.js`, `sync.js`, `settings.js` and `updater.js`: `/account/*`,
  `/api/sync/*`, `/api/fetch_image`, `/api/settings`, `/api/update*`. `scripts/dump_routes_rest_parity.py` →
  `tests/parity/routes-rest.json` (131 steps, every outside service faked). Sync files are stored as rows and written
  out as Python's `json.dumps` lines; `.accounts/<who>/` holds DATA's own SQLite layout. The account's Host/Origin
  check is in `js/desktop/server.js` (the router doesn't see headers). A sync switch clears the own-puzzle cache
  (`serve()` wraps `env.onSwitch`).

What the apps must pass in `env` (desktop-switch, web-switch): `pack` (`new Pack(read puzzles.json)`), `packs`
(`new Packs(read packs.json)`), optionally `ownPuzzles` and `rng`; `account` (the desktop already does); `updater`
(desktop only; disabled until given); `onSwitch` if the app keeps caches of its own.

**Decided for round 4 (2026-10-23):** the coordinator pushes `main` (which deploys blundr.gr) once `web-switch` is
merged and its checks and phone bench pass. The bridge Python release is v0.7.0 (v0.6.0 and v0.6.1 exist already)
and the first Electron release v1.0.0; the coordinator tags each one, alone, after asking the user. Tests run headless
Playwright in WSL and the Electron build on the Windows PC, with a temp data folder or a copy of the real one, never
the real `%LOCALAPPDATA%\chess-review`.

**`web-switch` is done and merged (2026-10-24); step 5 is done once blundr.gr is deployed.** `npm test` and the
full `pytest` pass on `main`, the browser tests included: they hung in WSL because Chromium found WSLg's GPU and never
drew a frame, and run with `--disable-gpu --disable-software-rasterizer` now. `js/web/worker.js` replaces Pyodide;
tabs elect a leader with Web Locks (`js/web/tabs.js`; a SharedWorker can't open OPFS sync handles, and Android
Chrome has none) and relay over a BroadcastChannel; `js/web/legacy.js` moves the old Pyodide data once, loading a
4-file `legacy/app.zip` and Pyodide from the CDN that one time, then reclassifies every game. Phone bench
(`scripts/bench_web_startup.py`, medians of 5 cached reloads): first answer 0.39 s, Analyse accepted 0.73 s, against
4.15 s and 7.72 s for the Python build of today (the ~14/20 s above were before its own tuning). Not checked on a
real phone yet; a job running in a leader tab that closes is lost (builds resume); `retire` must keep the frozen
`legacy/app.zip` or drop the migration.

**After the web deploy (2026-10-24).** Two browsers stayed on "Loading Blundr". One had a frozen tab holding the
leader's lock; the other's ad blocker blocked `/js/core/analyse.js` (privacy lists block any `analyse.js`), so the
worker never loaded. Fixed: start-up never waits silently any more (a tab that hears no leader in 8 s, storage that
doesn't open in 30 s, a move step over 180 s, a worker that doesn't start: each says why, naming a file that didn't
load); the modules are `js/core/evals.js` and `js/server/eval-cache.js` now, and `build_web.py` refuses `js/` file names
those lists match. The site also serves `/favicon.ico` (the dark-green knight, which stays Blundr's icon).

**v0.7.0, the bridge, is released (2026-10-24).** Its runtime fingerprint moved (it bundles `sqlite3`), so v0.6.1
installs take it as a full download; v0.6.1 installs still on it when v1.0.0 comes out must download by hand, so
v1.0.0 waits a few days.

**`desktop-switch` is done and merged (2026-10-23); step 6 waits only for its two tags.** `npm test` and `pytest`
pass on `main`. Electron has everything the Python app had (puzzles and packs, the book as `book_keys.txt` in the
asar, idle engines reaped, one Stockfish per core, the updater with small `.asar` and full-zip updates, the data
check in `js/desktop/handover.js`). The bridge (`migrate_sqlite` on; an `electron` update kind in `updater.py`) and
one release workflow (`windows-release.yml`: tags v0.x build Python, v1+ Electron with the bridge's zips attached
again; manual runs publish nothing). Checked on the Windows PC from the built zip with temp data and a copy of the
real data, including both update kinds and the bridge swapping a Python install for Electron. Release steps and
what to check after each: `js/desktop/README.md`. Still open: a real provider sign-in through the system browser, a
frozen-exe bridge run (it was tested from source), the first CI run; v0.6.1 installs whose runtime differs from the
bridge's have to download Electron by hand.

**Step 7 is done (2026-10-24): Python is retired.** Gone: `chess_review/*.py`, `launcher.py`, `web/py`, the
PyInstaller packaging (`packaging/` keeps only the icon), the Python tests with JS twins, the parity dump scripts,
`requirements.txt`, `restart_server.sh` and `mem.sh` (the Python server's). The parity dumps in `tests/parity` stay,
frozen: the JS is the reference now. Everything is in git history (`e8e547f` is the last commit with it).
- `scripts/build_web.js` replaces `build_web.py`: the same `web-dist/` byte for byte except index.html's pieces JSON,
  now spaced as the desktop's (`JSON.stringify`). `npm run build:web`, `--serve`, `--engine-wasm cdn` as before.
- The puzzle library is `chess_review/puzzle_packs/puzzles.json` (one puzzle a line) in place of `lichess.parquet`,
  the rows the web build already shipped, so neither build needs Python or a Parquet reader. The picking rules for the
  packs (`packs.build`, `daily_list`) moved to `scripts/pack_rules.py`; rebuilding gives the same `packs.json`.
- `legacy/` keeps the one-time move of old browser data working: the four modules `legacy/app.zip` holds, frozen as
  v0.7.0 had them, python-chess's wheel, and `make_fixture.py` (a Python build's data folder, for
  `js/server/migrate.test.js` and the browser test). The build zips them; Pyodide still comes from its CDN.
- `windows-release.yml` builds only Electron (`v1+` tags; a `v0.x` tag fails); the bridge's zips are attached again
  as before. `deploy-web.yml` tests with `npm test` and builds with Node, no Python.
- Still Python, build-only: `build_puzzle_pack.py`, `build_puzzle_packs.py` (pyarrow, for the `.zst`), the themes
  import and sound scripts, `bench_web_startup.py` and `tests/test_web_browser.py` / `test_web_shim.py` (Playwright;
  they test the JS app in a real browser and have no JS twin).

Open, for the sessions named:
- `desktop-switch` (the parts above that are done are kept for the record): the updater, `env.updater = new Updater({ installed, platform, assets: ELECTRON_ASSETS, apply,
  unpack })`, where `apply` writes the PowerShell swap script (`write_apply_script`) and quits once the answer is out,
  and the download streams to disk instead of being buffered; migrating Python's `.accounts/<who>/` workspaces (jsonl,
  parquet) to the SQLite layout; a real provider sign-in through the system browser back to `/account/callback`.
- `web-switch`: sync's table-by-table database copy is tested only on `node:sqlite`; check it on SQLite WASM in OPFS.
  The account routes aren't needed there (the page calls the Worker itself).
- `desktop-switch`: the opening book (the JS desktop reads only `DATA/book_keys.txt`; ship or build it, as
  `scripts/build_web.py` does); `reap_idle` (idle engines are never closed); Python's explorer interrupts a running
  stream when a new search comes, while the JS pool queues it (one engine per open stream).
- `desktop-switch`: `puzzles.json` and `packs.json` for the desktop build; turn the export on in the bridge release and
  run it once more before the "electron" update; Electron accepts the data only when `verify` passes; sync moves the
  SQLite files into `.accounts/<who>/`.
- `web-switch`: call `migratePyodide` before the `Store` opens anything (old data shows as an IndexedDB database named
  `/data`), keeping a legacy `app.zip` and the Pyodide CDN for that one load; test it in a real browser.
