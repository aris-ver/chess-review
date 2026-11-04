# Vendored libraries

`chessops.js` is [chessops](https://github.com/niklasf/chessops) **0.15.1** (lichess's chess library,
GPL-3.0-or-later) with its one dependency, `@badrap/result` 0.3.1 (MIT), bundled into a single ES module. The same
file is imported by the browser (no bundler) and by Node. It is generated: rebuild it with
`scripts/vendor_chessops.sh` (needs npm), never edit it by hand.

`sqlite-wasm/` is SQLite's own WebAssembly build, [@sqlite.org/sqlite-wasm](https://github.com/sqlite/sqlite-wasm)
**3.53.4-build2** (SQLite 3.53.4, public domain; the npm wrapper Apache-2.0): `sqlite3.mjs` (the package's
`dist/index.mjs`), `sqlite3.wasm` beside it, and `sqlite3-opfs-async-proxy.js`, which the "opfs" VFS loads (we use
"opfs-sahpool", which needs no proxy; it is kept so the module finds what it may ask for). Copied unchanged by
`scripts/vendor_sqlite_wasm.sh`; `js/web/db.js` loads it.

Besides chessops' own index it exports `castlingSide` and `normalizeMove`, which `js/core/chess.js` needs to
translate python-chess style castling moves (`e1g1`) to chessops' king-takes-rook form.
