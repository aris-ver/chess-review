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
   (`build_puzzle_pack.py`, the sound synth) may stay Python.

Steps 1, 2 and 3 can partly run side by side (different modules); step 4 needs them, and 5 and 6 need 4.

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
