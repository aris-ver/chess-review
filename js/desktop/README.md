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
  `packaging/dist/blundr-app-<runtime>.asar`. app.asar holds js/, the page, `puzzle_packs/puzzles.json` and
  `puzzle_packs/packs.json` (from `chess_review/puzzle_packs/`) and `book_keys.txt` (from `packaging/assets/book`,
  `data/book` or lichess). Staged under `%LOCALAPPDATA%\chess-review-build\electron`.

Run from a checkout: `npm ci`, then `npm run desktop` (`bash scripts/fetch_book.sh` once for the opening book).

## Updater

Releases come from GitHub Releases (`js/server/updater.js`'s `Updater` with `ELECTRON_ASSETS`). `resources/build.json`
holds `{version, runtime}`, where `runtime` is `electron-<version>`: what only a full download can change.

- **Small update:** `blundr-app-<runtime>.asar`, when its runtime is the install's. Streamed to `DATA/update`,
  checked to be this app's asar (its header lists `package.json` and `js/desktop/main.js`), staged as
  `update/stage/Blundr/resources/app.asar` with a new `build.json` (the release's version, the same runtime).
- **Full update:** `Blundr-windows.zip`. Its entries must all be under `Blundr/`; unpacked with Windows' tar into
  `update/stage`, then checked for `Blundr.exe`, an app.asar of this app and `build.json`.
- **By itself** (`auto`, this build's Updater only; the page still works with one without): a check (`GET
  /api/update`: at launch, on the way to Home, as the window comes back into sight; at most once an hour) that finds
  a newer release starts its download at once. One download at a time; one that fails shows in the banner and is
  tried again at the next check. A newer release than the staged one replaces it: the stage goes as its download
  starts; one pulled after its download (GitHub's latest older than it again) is dropped at the next check. The banner
  then says "<version> will install when you close Blundr", with *Restart now* and What's new.
- **On quit:** when the window closes with an update staged, `window-all-closed` writes and starts the script with no
  relaunch (`Updater.applyOnQuit`: never throws, waits on nothing but writing a file and starting `cmd`), then shuts
  down as before. A job running doesn't hold it back: closing stops it anyway. The next launch is the new version.
  Not when Windows is ending the session (shutdown, restart, sign-out: the window's `query-session-end` and
  `session-end`; `powerMonitor`'s `shutdown` elsewhere), which may kill the script mid-swap: the update waits for the
  next close. Nor a stage that is no longer an update (not newer than this version, or newer than the latest release
  seen): it is dropped.
- **One copy per data folder:** `requestSingleInstanceLock` (keyed on `DATA/electron`); starting Blundr again brings
  the open window to the front. Two copies would share the databases and `DATA/update`, and closing one would swap
  the install under the other. (`listen()`'s other port is for something else on 8123.)
- **Applying** (*Restart now*, `POST /api/update/apply`): `DATA/update/apply.ps1` (BOM, CRLF) is written and started
  through `cmd /c start` (a detached PowerShell has no console and runs nothing), and the window closes 0.5 s later.
  Applied once: the state is then `applying` (the banner says it is installing), so neither a second click nor the
  quit after it applies again, and no download starts. The script logs `installing <version> (<kind>[, on quit])`,
  waits until no process runs from the install folder (the app's, its helpers', another copy's: by path, so a reused
  pid can't fool it; one still there after two minutes and nothing changes: `FAILED: Blundr was still running`, or
  `another copy of Blundr is running from this folder`), then: small → each staged file over the install's through a
  `.new` rename; full → the install folder's contents moved into `.blundr-old`, the stage's copied in, the old ones
  put back if that fails, `.blundr-old` deleted. The old exe names go, `DATA/update.log` says what happened, and after
  *Restart now* `Blundr.exe` starts again whatever happened.
- **A swap cut off** (the script killed): `.blundr-old/.state` says how far a full swap got (`moving`, `copying`,
  `done`). The next script, before anything else, puts the old files back where it stopped in `moving` or `copying`,
  and keeps the new ones after `done`. At launch a `done` one is deleted; any other is left (and logged) for the next
  script, as the running app's files can't be moved.
- **While a script works** (`DATA/update-applying.json`, `{pid, at}`: written by the app as it starts the script, then
  by the script with its own pid, deleted when it ends; stale after 10 minutes or once that process is gone, 30 s'
  grace for the app's): a launch neither downloads (that would wipe the stage being copied from) nor applies.
- **A failed install** (the last `installing` in `DATA/update.log` followed by a `FAILED:` line, for a version newer
  than the one running): shown at launch under the banner, and that version isn't downloaded by itself again (or
  every launch would fetch it and fail on quit); *Download update* still fetches it, and a newer release downloads by
  itself as usual.
- `BLUNDR_UPDATE_API=http://127.0.0.1:<port>/releases` serves GitHub's releases API from elsewhere (a test release).
- The downloaded asar goes through Electron's `original-fs`: its own `fs` treats an `.asar` file as a folder.

## The bridge (v0.7.0, the last Python release)

The Python app is gone from the repo (docs/js-port.md, step 7); its source is in git history and in the
v0.7.0 tag. What the bridge did:


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

`.github/workflows/windows-release.yml` builds the Electron app on a `v1+` tag (Blundr-windows.zip,
blundr-app-<runtime>.asar, and the bridge's chess-review-*.zip again) and refuses a `v0.x` tag: no Python release
comes after the bridge. A manual run only uploads a workflow artifact.
