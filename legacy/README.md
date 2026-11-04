# legacy/

The last Python in the apps, frozen. A browser that used Blundr before the JS port has its data in Pyodide's
IndexedDB; the first time it comes back, `js/web/legacy.js` loads Pyodide from its CDN with python-chess's wheel and
`legacy/app.zip`, runs the Python app's export to SQLite on that data, and never loads any of it again
(`docs/web.md`, "The one-time move from the Python build").

- `chess_review/`: `__init__.py`, `config.py`, `fen.py`, `migrate_sqlite.py` as the bridge release (v0.7.0) had them:
  what `scripts/build_web.js` zips into `web-dist/legacy/app.zip`. Don't edit them: browsers' old data was written
  by this code's sibling modules, and the export is what `js/server/migrate.js` checks against.
- `chess-1.11.2-py3-none-any.whl`: python-chess for Pyodide (PyPI has only its sdist), copied to `web-dist/legacy/`.
- `make_fixture.py`: a data folder as the Python build left it, for `js/server/migrate.test.js` and
  `tests/test_web_browser.py` (needs duckdb).

Dropping the move: delete this folder, `js/web/legacy.js` and the `legacy` entry `build_web.js` writes into
`web/config.js`.
