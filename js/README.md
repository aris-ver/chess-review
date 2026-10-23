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
              classify; later the routes of serve.Handler and the job runner
js/web/       db.js (the SQLite WASM driver, databases in OPFS); later the worker that replaces Pyodide
js/desktop/   later: Electron
js/parity.js  helpers for replaying the parity dumps
```

## Tests

`npm test` (Node 22.13 or newer, for `node:sqlite`) runs every `js/**/*.test.js`. Ubuntu's apt Node is 20, so in WSL
use nvm's (`nvm install 22`, then `. ~/.nvm/nvm.sh` in a shell that doesn't load `.bashrc`). Most of them replay `tests/parity/*.json`: inputs and
outputs of the Python functions, which the JS has to match field for field (floats at 1e-9 relative, everything
else exactly).

The dumps come from Python. Regenerate them after changing a ported module's logic:

```
.venv/bin/python scripts/dump_parity.py            # tests/parity/*.json (committed)
.venv/bin/python scripts/dump_parity.py --local    # also your own games, to tests/parity/local/ (gitignored)
```

`js/core/local.test.js` replays the local dumps when they exist and is skipped otherwise.

The storage has its own dump, the Python database code (normalise's parquet, the evals cache, `pending_keys`,
`classify.build`, `load_multipv`, `profiles.summary`) run in a scratch data directory, which
`js/server/db-parity.test.js` replays on both SQLite drivers:

```
.venv/bin/python scripts/dump_storage_parity.py           # tests/parity/storage.json (after dump_parity.py)
.venv/bin/python scripts/dump_storage_parity.py --local   # also tests/parity/local/storage-<id>.json
```

From a worktree, which has no `data/` or `bin/`, point it at the main checkout's:
`STOCKFISH=../../../bin/stockfish .venv/bin/python scripts/dump_storage_parity.py --data ../../../data`.
