# Vendored libraries

`chessops.js` is [chessops](https://github.com/niklasf/chessops) **0.15.1** (lichess's chess library,
GPL-3.0-or-later) with its one dependency, `@badrap/result` 0.3.1 (MIT), bundled into a single ES module. The same
file is imported by the browser (no bundler) and by Node. It is generated: rebuild it with
`scripts/vendor_chessops.sh` (needs npm), never edit it by hand.

Besides chessops' own index it exports `castlingSide` and `normalizeMove`, which `js/core/chess.js` needs to
translate python-chess style castling moves (`e1g1`) to chessops' king-takes-rook form.
