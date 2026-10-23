# js/

The JavaScript port of chess-review (plan and status in `docs/js-port.md`). Plain ES modules, no build step: the
browser and Node import the same files.

```
js/core/      no I/O, runs anywhere: fen, pov, accuracy, critical, book, explain, facts, classify, analyse
              (UCI info parsing), chess.js (python-chess semantics over chessops), py.js (Python's rounding,
              sums and formatting), config
js/vendor/    chessops 0.15.1, bundled by scripts/vendor_chessops.sh (never edit by hand)
js/server/    later: the routes of serve.Handler and the job runner
js/web/       later: the browser adapters and the worker that replaces Pyodide
js/desktop/   later: Electron
js/parity.js  helpers for replaying the parity dumps
```

## Tests

`npm test` (Node 20 or newer) runs every `js/**/*.test.js`. Most of them replay `tests/parity/*.json`: inputs and
outputs of the Python functions, which the JS has to match field for field (floats at 1e-9 relative, everything
else exactly).

The dumps come from Python. Regenerate them after changing a ported module's logic:

```
.venv/bin/python scripts/dump_parity.py            # tests/parity/*.json (committed)
.venv/bin/python scripts/dump_parity.py --local    # also your own games, to tests/parity/local/ (gitignored)
```

`js/core/local.test.js` replays the local dumps when they exist and is skipped otherwise.
