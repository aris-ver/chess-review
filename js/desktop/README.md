# js/desktop/

The Electron app (docs/js-port.md, round 1 `electron`).

- `main.js`: the main process, in `launcher.py`'s place. One "Blundr" window (1400×900, min 900×600) on a server at
  127.0.0.1:8123 (or a free port), a failure page if it can't start, logs to `DATA/app.log`. `DATA` is
  `config.DATA`'s folder (`%LOCALAPPDATA%\chess-review` packaged, `data/` in a checkout, `$CHESS_REVIEW_DATA` first).
- `server.js`: serves `chess_review/static` (index.html with `pieces.json` in place of `/*__PIECES__*/`, as
  `site.write_static` does). `api/`, `account/` and `p/` answer a 503 placeholder until js/server (round 3) is
  passed in as `makeServer({ api })`.
- `engines.js`: native Stockfish pool, `js/core/engine.js`'s `EnginePool` (`size`, `name`, `load()`,
  `search(fen, nodes, multipv=3) → info lines`, `close()`). Tests replay the recorded python-chess searches exactly.
- `build.js`: `npm run build:windows` on Windows → `packaging/dist/Blundr-electron-windows.zip` (portable folder
  `Blundr/`, `resources/app.asar`, `resources/bin/stockfish.exe`, `resources/build.json`). CI:
  `.github/workflows/electron-windows.yml`, manual only.

Run from a checkout: `npm ci`, then `npm run desktop`.

## Updater plan (not built)

Releases keep coming from GitHub Releases. `resources/build.json` holds `{version, runtime}`, where `runtime` is
`electron-<version>`: what only a full download can change.

- **Small update:** a release also carries `blundr-app-<runtime>.asar` (just `app.asar`, a few MB). If its runtime
  matches the install's, the app downloads it to `DATA/update`, and after the app exits a small PowerShell script
  (as `updater.write_apply_script` does) copies it over `resources/app.asar` via a `.new` rename, then restarts
  `Blundr.exe`. Stockfish changes ride with full updates only.
- **Full update:** `Blundr-windows.zip` (the Electron build under the `Blundr/` root). Unpacked into `DATA/update/stage`;
  the script moves the old install folder's contents aside, moves the new ones in, restores on failure, restarts.
- **The bridge:** the last Python release's updater must take the Electron zip as a full download. Its `unpack()`
  today rejects it (no `_internal/chess_review`, no `python3*.dll`) and its full apply only swaps `_internal` and the
  exes. So that release needs an `electron` kind: check for `resources/app.asar`, replace the whole folder's
  contents (dropping `_internal` and the legacy exe names) and start `Blundr.exe`. It also writes its data to
  SQLite first (step 6), so the Electron app finds it.
