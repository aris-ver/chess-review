# js/

The JavaScript port of chess-review (plan and status in `docs/js-port.md`). Plain ES modules, no build step: the
browser and Node import the same files.

```
js/core/      no I/O, runs anywhere: fen, pov, accuracy, critical, book, explain, facts, classify, analyse
              (UCI info parsing), chess.js (python-chess semantics over chessops), py.js (Python's rounding,
              sums and formatting), config
js/vendor/    chessops 0.15.1, bundled by scripts/vendor_chessops.sh, and SQLite WASM 3.53.4 by
              scripts/vendor_sqlite_wasm.sh (never edit by hand)
js/server/    db (the SQLite schema and one interface; db-node.js is the node:sqlite driver), profiles (over a
              files adapter: profiles-files.js, profiles-files-node.js), the database halves of analyse and
              classify, the routes (router.js, routes-*.js) and the job runner
js/web/       the worker (worker.js), its tabs, the browser adapters (SQLite WASM in OPFS, WASM Stockfish)
js/desktop/   Electron (README.md there)
js/parity.js  helpers for replaying the parity dumps
```

## Tests

`npm test` (Node 22.13 or newer, for `node:sqlite`) runs every `js/**/*.test.js`. Ubuntu's apt Node is 20, so in WSL
use nvm's (`nvm install 22`, then `. ~/.nvm/nvm.sh` in a shell that doesn't load `.bashrc`). Most of them replay `tests/parity/*.json`: inputs and
outputs of the Python functions, which the JS had to match field for field (floats at 1e-9 relative, everything
else exactly).

The dumps came from the Python app, which is gone (docs/js-port.md, step 7), so they are frozen: the JS is now the
reference, and a change to a ported module's logic updates the expected values in the dump with it. The dump
scripts (`scripts/dump_parity.py`, `scripts/dump_storage_parity.py`, the route dumps) and the Python modules they ran
are in git history: `git show e8e547f:scripts/dump_parity.py`.

`js/core/local.test.js` and the other "your profiles" tests replay local dumps of your own games
(`tests/parity/local/`, gitignored) when an old checkout has them, and are skipped otherwise.

`js/server/migrate.test.js` runs the Python app's export (`legacy/`, frozen: the one-time move of old data still
needs it) when a venv with duckdb and python-chess is found (`.venv` up the tree, or `$PYTHON`); skipped otherwise.

Comments naming `chess_review/<module>.py`, `serve.Handler`, `web/py/...` or a `scripts/dump_*.py` say where the code
was ported from; the Python is in git history (`git show e8e547f:<path>`), except `legacy/`'s, which still runs.
