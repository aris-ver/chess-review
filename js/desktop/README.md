# js/desktop/

The Electron app for Windows (docs/js-port.md, step 6): js/server on 127.0.0.1 with native Stockfish and the data on
disk, the page (`chess_review/static`) in one window.

- `main.js`: the main process, in `launcher.py`'s place. One "Blundr" window (1400×900, min 900×600) on a server at
  127.0.0.1:8123 (or a free port), a failure page if it can't start, logs to `DATA/app.log`. `DATA` is
  `config.DATA`'s folder (`%LOCALAPPDATA%\chess-review` packaged, `data/` in a checkout, `$CHESS_REVIEW_DATA` first).
  It passes js/server its `env`: store, files, profiles, account, `pack`/`packs` (puzzles.json and packs.json in
  app.asar), `updater`. Idle engines quit after 10 minutes (`reap_idle`). At start (packaged, Windows) the old exe
  names are deleted and the downloaded-file mark is cleared from the app's binaries (`launcher.js`); the first start
  after the Python app copies its WebView2 localStorage (pinned profiles, switches) into Electron's profile.
- `handover.js`: nothing in DATA is opened until the data checks out. Python data (evals.duckdb, the jsonl, a
  profile's parquet) without `sqlite-export.json` → a page saying it hasn't been converted (run Blundr 0.7 once);
  an export for a newer schema, or one whose row counts don't match the marker (js/server/migrate.js `verify`, run on
  a temporary copy so the bridge can still export again) → a page listing what's missing. Either way nothing is
  written. A pass is remembered in `DATA/sqlite-accepted.json` (with the marker's time); later starts don't count.
- `server.js`: serves the page (index.html with `pieces.json` in place of `/*__PIECES__*/`) and hands `api/`,
  `account/` and `p/` to js/server's router; `account/` only from the app's own page (Host/Origin check).
- `engines.js`: native Stockfish pool, `js/core/engine.js`'s `EnginePool`: one process per physical core (half the
  logical ones, as `analyse.default_workers`), Threads=1, Hash=64. `reapIdle(ms)` closes it when unused.
- `book.js`: the opening book's keys from the lichess TSVs, as `book.load()` makes them (checked equal: 7854 keys).
  build.js ships them as `book_keys.txt` in app.asar; a checkout reads `DATA/book/*.tsv` at start;
  `DATA/book_keys.txt` overrides both.
- `update.js`: the desktop half of the updater (below).
- `build.js`: `npm run build:windows` on Windows → `packaging/dist/Blundr-windows.zip` (portable folder `Blundr/`:
  `Blundr.exe`, `resources/app.asar`, `resources/bin/stockfish.exe`, `resources/build.json`) and
  `packaging/dist/blundr-app-<runtime>.asar`. app.asar holds js/, the page, `puzzle_packs/puzzles.json` (from
  `packaging/build/puzzles.json`, which `packaging/puzzles_json.py` writes from the parquet pack when missing:
  `$PYTHON` or `python` with requirements.txt), `puzzle_packs/packs.json` and `book_keys.txt` (from
  `packaging/assets/book`, `data/book` or lichess). Staged under `%LOCALAPPDATA%\chess-review-build\electron`.

Run from a checkout: `npm ci`, `python packaging/puzzles_json.py` once, then `npm run desktop`.

## Updater

Releases come from GitHub Releases (`js/server/updater.js`'s `Updater` with `ELECTRON_ASSETS`). `resources/build.json`
holds `{version, runtime}`, where `runtime` is `electron-<version>`: what only a full download can change.

- **Small update:** `blundr-app-<runtime>.asar`, when its runtime is the install's. Streamed to `DATA/update`,
  checked to be this app's asar (its header lists `package.json` and `js/desktop/main.js`), staged as
  `update/stage/Blundr/resources/app.asar` with a new `build.json` (the release's version, the same runtime).
- **Full update:** `Blundr-windows.zip`. Its entries must all be under `Blundr/`; unpacked with Windows' tar into
  `update/stage`, then checked for `Blundr.exe`, an app.asar of this app and `build.json`.
- **Applying** (`POST /api/update/apply`): `DATA/update/apply.ps1` (BOM, CRLF) is written and started through
  `cmd /c start` (a detached PowerShell has no console and runs nothing), and the window closes 0.5 s later. The
  script waits for the app's pid, then: small → each staged file over the install's through a `.new` rename; full →
  the install folder's contents moved into `.blundr-old`, the stage's copied in, the old ones put back if that
  fails, `.blundr-old` deleted. The old exe names go, `DATA/update.log` says what happened, and `Blundr.exe`
  starts again whatever happened.
- `BLUNDR_UPDATE_API=http://127.0.0.1:<port>/releases` serves GitHub's releases API from elsewhere (a test release).
- The downloaded asar goes through Electron's `original-fs`: its own `fs` treats an `.asar` file as a folder.

## The bridge (v0.7.0, the last Python release)

- `migrate_sqlite.ENABLED` is on: every start of the Python app exports its data to the SQLite files (a no-op while
  nothing changed), `.accounts/<who>/` workspaces included (sync's layout: their own `progress.sqlite` and
  `profiles/<id>/games.sqlite`).
- `chess_review/updater.py`: a release with a `blundr-app-*.asar` asset is an Electron release. Its
  `Blundr-windows.zip` is taken as an `electron` update (shown as a full download): unpacked if it has
  `Blundr/Blundr.exe` and `Blundr/resources/app.asar`; on apply the data is exported once more
  (`export_for_electron`; if that fails nothing changes and the page shows why), then the script replaces the whole
  install folder's contents as the full Electron update does (`_internal` and the old exe names go) and starts
  `Blundr.exe`.
- Older Pythons only know the `chess-review-*.zip` names, so every Electron release re-attaches the bridge
  release's (`.github/workflows/windows-release.yml`): an older install updates to the bridge first, which then
  takes the Electron zip. An older install whose runtime doesn't match the bridge's and that knows
  `Blundr-windows.zip` (v0.6.1) would take the Electron zip and refuse it ("does not look like a chess-review
  build"); it has to download the bridge or the new app by hand.

## Release build

`.github/workflows/windows-release.yml` builds one app per tag, by its version: `v0.x` the Python app, `v1+` the
Electron app (Blundr-windows.zip, blundr-app-<runtime>.asar, and the bridge's chess-review-*.zip again). A manual run
asks which app and only uploads a workflow artifact.
