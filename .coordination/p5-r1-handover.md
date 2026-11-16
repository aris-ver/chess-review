# Phase 5 round 1 hand-over: KQKR and KRKR tables

Branch `claude/instinct-p5-tables` (worktree `.claude/worktrees/instinct-p5-tables`), from 3a229ae. Not pushed, not
merged.

## What changed
- `js/core/endgame-table.js`: black pieces. Names 'K<white>K<black>' ('KQKR', 'KRKR'; the old names unchanged),
  black's pieces after white's in `pieces` and in the index (same 8-fold symmetry, 2,621,440 entries each). A byte is
  N = white mates in N, 0 = white does not win (documented at the top, with how "does black win" is asked by
  flipping). generate(): two-sided legality (white to move: black's king not attacked, white may be in check; black
  to move: white's king not attacked), white captures of the black rook read the sub table black to move (a cached
  per-sub array of plies built with probe, the same thing promoPlies does), sliders stop on the rook with the capture
  included, black's moves are king plus rook moves, fully legal (pins checked in blackGen), a black capture of white's
  last piece is not a win (every material with white's lone king is DRAWN), white with no legal move is 0 (counted
  as matedW or stalemates). probe(), blackMoves() (now also returns `piece` and `from`), toFen(), canonical() handle
  black pieces. fromFen() accepts black pieces when white has one too (still null for more than 4 pieces, and still
  null for black material against a lone white king, so the KPK-hold flip in drills.js and routes-drills.js works as
  before). whiteMoves() throws for tables with a black piece (not needed until a queen-against-rook mate drill).
  DEPENDS: KQKR ['KQK'], KRKR ['KRK']. stats gain maxIndex and matedW.
- `scripts/build_endgame_tables.js`: KQKR, KRKR in NAMES (so build_web.js and desktop build.js ship them), EXPECT
  for both, the log prints the longest mate's position, the lichess check maps categories as the spec says.
- `js/core/endgame-table.test.js`: a fast test (400 random legal positions per table against chess.js: legality
  both ways, black's moves from and to, mate, stalemate, white to move in check; index round trip, symmetries,
  fromFen/toFen; hand-made diagonal and file pins, rook takes queen, black to move with white in check illegal), and
  a data test on data/endgames (top of the histograms, the longest mates and lichess's first move from them, the
  facing-rooks flip, rook takes queen, queen takes rook into KQK), skipped when the files are missing.
- Comments: build_web.js table size, CI cache step build time (deploy-web.yml, windows-release.yml). The CI cache
  key already hashes endgame-table.js and build_endgame_tables.js, so no key change was needed.

## Measured (WSL, Node 22.23.4)
| table | build | gzipped | longest mate | wins (w to move) | mates (black) | matedW | stalemates |
| --- | --- | --- | --- | --- | --- | --- | --- |
| KQKR | 43.3 s | 748,146 B | 35 | 1,385,461 | 1,698 | 402 | 0 |
| KRKR | 36.8 s | 262,913 B | 19 | 490,657 | 743 | 826 | 0 |

All nine cold: 151.2 s, 117 MB peak RSS. The seven old tables came out byte-identical to the p4 files. All nine
gzipped: 2.33 MB (was 1.32 MB). Both are well under the 1.5 MB stop line; build times are under the spec's estimate
(KQKR 60 to 150 s), not over.

## lichess
- KQKR longest, `8/8/8/8/2r5/8/2k5/K6Q w - - 0 1`: lichess category win, dtm 69, dtz 59; its first move Qb1+ gives
  dtm -68 (our black-to-move 34). Confirms 35 moves DTM.
- KRKR longest, `8/8/8/8/8/1R6/6r1/K1k5 w - - 0 1`: category win, dtm 37, dtz 5; Rb1+ then dtm -36. 19 moves.
- `--check=400` (KQKR, KRKR, 200 each, both sides to move, seeded): "checked 400 positions, 0 mismatches", dtm
  compared too wherever lichess gave one. EXPECT then filled from the build and confirmed by a second build.

## Tests
`npm test`: 318 tests, 316 pass, 0 fail, 2 skipped (main: 314 pass, 2 skipped; the 2 new tests both run when
data/endgames is there). The skips are the ENDGAME_FULL 4-piece generation and MIGRATE_DATA, as on main. To get
the engine and parity tests running in a fresh worktree, symlink bin/ and tests/parity/local from the main checkout.

## Checking from this worktree
It was made with Windows git, so git from WSL fails here ("not a git repository" on the //wsl.localhost gitdir); use
Windows git with `-c safe.directory=*`. Copy data/endgames from instinct-p4 and rebuild (the stamp changed), or run
`node scripts/build_endgame_tables.js` (about 2.5 minutes cold).

## Open
- The tables can't say whether black wins a KQKR position (a 0 covers it); round 3 only needs "does white win" and
  the flipped KRKR / KRKQ probes, as the spec's grading reads.
- whiteMoves and bestLine for black-piece tables are not done (spec: not needed now).
