# Phase 1 spec: endgame tables and drills core

From the Fable planner, 2026-11-16. Numbers measured with a throwaway prototype in Node 22.

## Findings
- Maxima (moves, white to move): KQK 10, KRK 16, KPK 28, KQRK 6, KRRK 7, KBBK 19, KBNK 33. Plies = 2N-1.
- Black-to-move values in KQRK/KRRK are longer (black takes a piece, KRK continues, up to 32 plies). Assert maxima on
  white-to-move entries only.
- chess.js (wraps js/vendor/chessops.js) is too slow for generation: use a dedicated square-array generator inside
  endgame-table.js. chess.js only in tests and drills.js.
- Prototype timings: KQK 228 ms, KRK 329 ms, KPK 789 ms, KQRK 8.7 s, KRRK 10.6 s (KBBK 44 s, KBNK 73 s).
- White-to-move-only storage, illegal entries filled with the previous byte, gzip 9: KQRK 156 KB, KRRK 166 KB,
  KQK 5 KB, KRK 6.6 KB.
- Tests: `npm test` = `node js/run-tests.js` = `node --test` over js/**/*.test.js. One file:
  `~/.nvm/versions/node/v22.23.4/bin/node --test js/core/endgame-table.test.js`.
- Lichess: `GET https://tablebase.lichess.ovh/standard?fen=<FEN, spaces as _>` returns category, dtz, dtm (signed
  plies for side to move, nullable), checkmate, stalemate, moves[].

## Decisions
1. Ship all five tables (KQK, KRK, KPK, KQRK, KRRK) as white-to-move-only gzipped .bin. generate() still works
   anywhere; tests use it.
2. Don't commit .bin files. Build into data/endgames/ (gitignored); cold build about 22 s. Export
   `ensureTables(dir)` from the script: skip when files exist and a stamp matches (hash of endgame-table.js plus
   format version). Phase 3 calls it from build_web.js and js/desktop/build.js.
3. No extra worker. Tables load lazily per ending on the server side (web app worker, Electron main).
4. File names: endgames/kqrk.bin, krrk.bin, kqk.bin, krk.bin, kpk.bin. They pass BLOCKED_NAME.
5. Phase 1 leaves build_web.js, js/desktop/build.js, paths.js and worker.js untouched.

## js/core/endgame-table.js (pure, no imports)
Squares 0..63, a1 = 0. Ending names 'KQK','KRK','KPK','KQRK','KRRK' (later 'KBBK','KBNK'); piece order as in the name.

Index (white to move only):
- Pawnless: `((tri(wk)*64 + bk)*64 + p1)[*64 + p2]`; one of 8 symmetries puts wk in the 10-square triangle
  (file <= 3, rank <= file). Sizes 40,960 and 2,621,440.
- KPK: `(pawnIdx*64 + wk)*64 + bk`, pawnIdx = (rank-1)*4 + file, mirrored left-right when the pawn is on files e-h.
  Size 98,304.
- Diagonal duplicates and swapped identical rooks stay redundant on purpose (every index evaluated forward).

Byte: 0 = draw, 1..33 = mate in N moves. Illegal entries hold the previous byte, so probe checks legality itself
(overlap, adjacent kings, black in check with white to move).

File: gzip of an 8-byte header ('EGT1' plus the name padded to 4 chars) and the payload.

Black to move by a one-ply search: no legal moves gives mate or stalemate; otherwise the max over king moves of the
white-to-move value; a capture looks up the smaller table (KQRK to KQK or KRK, KRRK to KRK), or draw when only kings
remain; any drawing move makes it a draw.

Generation (both sides in scratch arrays, plies+1 internally): init illegal, mates, stalemates; then levels L = 1, 2,
...: odd L resolves white-to-move entries with a successor lost in <= L-1 plies; even L resolves black-to-move
entries whose moves are all resolved with max <= L-1. Capture successors read the sub-table; promotions (queen and
rook only) read KQK and KRK with black to move. Stop after two idle sweeps and L > sub-tables' max plus 3. Pawn:
single and double push, no en passant.

Exports:
- `generate(name, subs) -> { name, data: Uint8Array, stats }`,
  stats = { maxMoves, wins, drawsW, lossesB, drawsB, mates, stalemates, illegal, hist }
- `DEPENDS = { KQK: [], KRK: [], KPK: ['KQK','KRK'], KQRK: ['KQK','KRK'], KRRK: ['KRK'] }`
- `pack(table) -> Uint8Array` (ungzipped), `unpack(bytes) -> table`, `async gunzip(bytes)` (DecompressionStream)
- `probe(tables, pos) -> { result: 'win'|'draw'|'loss'|'mate'|'stalemate'|'illegal', dtm }`,
  pos = { name, wk, bk, pieces: [sq], turn: 'w'|'b' }; dtm = moves white still needs (0 for mate)
- `fromFen(fen) -> pos | null`, `toFen(pos)`, `canonical(pos) -> key` (min index over symmetries, rooks sorted)
- `blackMoves(tables, pos) -> [{ to, capture, result, dtm }]`,
  `whiteMoves(tables, pos) -> [{ piece, from, to, promotion, result, dtm }]`

## scripts/build_endgame_tables.js
- `node scripts/build_endgame_tables.js [names...] [--out data/endgames] [--check[=200]] [--force]`; default list is
  one array (phase 4 adds two names).
- Builds dependencies first, asserts maxima and counts below (fail on mismatch), writes with gzipSync level 9.
- `--check`: seeded-random legal positions of both sides to move, sequential, ~150 ms apart, generic User-Agent, 60 s
  wait on HTTP 429. Compare category; when dtm != null compare |dtm| with 2N-1 (white to move) or 2M (black to move).
  Never called from tests, ensureTables or CI.

## js/core/drills.js (imports chess.js and endgame-table.js; pure; rng = Math.random injectable)
- `LEVELS = { KQRK: [{ lo, hi, slack, counter }], ... }` from docs/training-grounds.md. KPK: levels 1 to 4 by
  only-move count (4 means 4 or more).
- `ENDINGS` in tab order; `zone(sq) -> 'corner'|'edge'|'ring'|'centre'` (4, 24, 20, 16 squares).
- `candidates(tables, ending, level) -> { corner: Uint32Array, ... }` of canonical indices, memoised.
- `pickStart(tables, ending, level, { rng, recent, turn }) -> { fen, dtm, budget, key }`: bucket is
  nonEmpty[turn % k]; keys in recent (last 50) skipped; a random symmetry applied for display (8 pawnless, mirror
  only for KPK).
- `positionKey(fen)`; `budget(dtm, slack)`.
- `defenderMove(tables, fen, rng) -> uci`: a capture if one is legal, else a drawing move, else max dtm, random ties.
- `kindOfMove(dtmBefore, after)`: 'best' after.dtm == before-1; 'slack' 1 or 2 more than that; 'lost' 3 or more
  more; 'threw' draw or stalemate.
- `status(state) -> null | 'solved' | 'budget' | 'stalemate' | 'piece_lost' | 'repetition' | 'fifty'`,
  state = { fens, movesUsed, budget }.
- `review(tables, fens) -> [{ dtm, kind, loss }]` plus worst; `bestLine(tables, fen)`.
- KPK: `onlyMoves(tables, fen)`, `kpkGrade(before, after) -> 'ok'|'threw'`, `kpkAttackerMove(tables, fen, rng)`.
  Defence drill flips colours and ranks before probing; success = pawn taken, stalemate, or 20 moves held.

## Tests (node:test, node:assert/strict)
js/core/endgame-table.test.js generates KQK, KRK, KPK once (~1.4 s):
- Maxima 10, 16, 28.
- KQK: 22,589 white-to-move wins; 55 mates; 132 stalemates; hist 1:375, 2:805, 10:2.
- KRK: 27,352 wins; 32 mates; 9 stalemates; 199 at mate in 16.
- KPK: 62,480 white-to-move wins + 48,802 black-to-move losses = 111,282 (matches Stockfish's bitbase); 11 stalemates.
- Spot positions, white to move: Ke1 Qd1 Ke8 mate in 8; Ke1 Ra1 Ke8 mate in 12; Ke1 Pe2 Ke8 mate in 22;
  Ke6 Pe5 Ke8 mate in 11 (12 black to move); Ke5 Pe4 Ke7 draw (14 black to move); Ka1 Pa2 Ka8 draw.
- All 8 symmetries probe equal; pack/unpack round trip; 500 seeded positions agree with chess.js on legality, mate,
  stalemate, one-ply consistency.
- 4-piece only when ENDGAME_FULL=1 (~20 s): KQRK max 6, 1,080,257 wins, 35,617 mates, 12 at mate in 6. KRRK max 7,
  1,299,964 wins, 22,644 mates, 4,186 at mate in 7. Ke1 Qd1 Ra1 Ke8 and Ke1 Ra1 Rh1 Ke8 both mate in 2.

js/core/drills.test.js (3-piece tables, seeded RNG): band and bucket rotation, no repeats across 50, defender
prefers a capture, kindOfMove cases, every status fail, a perfect-play KRK game solving in exactly dtm moves.

Counts are tied to this index scheme.

## Risks
- --check on black-to-move positions with a capture: assumption that lichess dtm counts through captures the same way.
- Phase 4 KBBK/KBNK about 2 min to build; cache or optimise then.
- A checkout without data/endgames needs the script once; phase 3 gives a clear error.
- New files LF, no em dashes, header comment in the style of js/server/puzzles.js. Optionally `*.bin binary` in
  .gitattributes.
