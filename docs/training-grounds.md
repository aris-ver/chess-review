# Develop your instinct: endgame drills

Drafted 2026-11-16. A plan, nothing built yet. The numbers in the level tables are starting points, to be tuned
from real attempts.

## Goal

Build endgame instinct: finding the right moves in positions you have never seen, not memorising a few setups. You
play a basic ending against a defender that resists properly, within a move budget, from a fresh position every
time. After a miss you get a short review, then a different position.

It's aimed first at lower-rated players, who know they're winning but mate by checking until the king runs out of
squares, and run out of clock or stalemate on the way.

## Decided (2026-11-16)

- **Its own tab, called "Develop your instinct".**
- **The user always plays white.** The patterns are the same from either side, so a random colour adds nothing for
  this training.
- **The defender is stubborn from level 1.** It always plays the move that keeps mate furthest away. Good habits from
  the start, and a real opponent's mistakes then feel like a gift.
- **The mate counter is shown on the easy levels** and hidden from level 3.
- **Two-piece mates come first**: queen and rook, and two rooks. They're the easiest entry and the cure for "check
  until it's dead".

## Principles

- **The budget and the start position set the difficulty.** The defender is the same at every level.
- **Every attempt starts from a new position.** A fail never repeats the position you just missed.
- **A short review after every fail**, with the mate distance after each of your moves and the moves where you lost
  ground marked. Feedback is what turns trial and error into instinct.
- **Exact grading.** Every v1 ending has at most 4 pieces, so each drill is graded from a complete table of every
  position: how many moves to mate, or whether it's a draw.
- **One page for both apps**, in the shared page, like everything else.

## Scope

**v1**, in the order the tab shows them: KQRK, KRRK, KQK, KRK, KPK (attack and defence).
**v1.1**: KBBK, KBNK. They're rare in real games, so they come after.
**v2**: rook endings (Lucena, Philidor), graded by outcome. See "Rook endings (v2)".

## Tables

`js/core/endgame-table.js`, pure JS that runs in the browser and in Node:

- A retrograde generator: start from every mate position and work backwards to fill in the distance to mate (DTM)
  for every position, for each side to move. Positions where the defender can take a piece get the result of the
  smaller ending (KQRK with the rook taken is KQK), or a draw.
- Index: for pawnless endings, 8-fold symmetry with the white king in the 10-square triangle; for KPK, a left-right
  mirror with the pawn on 48 squares. One byte per position.
- **3 pieces** (KQK, KRK, KPK): about 82k positions each, built at runtime in a web worker. KPK needs KQK first: a
  promotion is scored by looking up the KQK table with the defender to move, so a queen taken at once is a draw.
- **4 pieces** (KQRK, KRRK, KBBK, KBNK): about 5.2M positions each. Built by `scripts/build_endgame_tables.js` in
  Node and shipped as gzipped `.bin` files. KQRK and KRRK are mostly short mates, so they compress very well.
- Checks (tests): the longest mates must match the known values (KQK 10, KRK 16, KQRK 6, KRRK 7, KBBK 19,
  KBNK 33 moves), and the counts of positions that are mated, stalemated or drawn must be stable. The build script
  also spot-checks about 200 random positions against the lichess tablebase API once, at build time, never at
  runtime.
- Measure the 3-piece build on a mid-range phone. If it takes more than about 300 ms, ship those tables too.

## Mate drills (KQRK, KRRK, KQK, KRK, later KBBK and KBNK)

**Attempt.** The user plays white and has to mate within the budget:
`budget = DTM of the start position + slack`.

**Defender.** It reads the table and plays the move that keeps mate furthest away, picking at random among equally
good moves for variety. It always takes a piece left hanging next to its king.

**Fails.** Budget used up, stalemate, a piece lost, threefold repetition, or the 50-move rule.

**Mate counter.** On levels 1 and 2 the board shows "mate in N" live, as a guide. From level 3 it's hidden, so the
player has to feel the progress.

**After each move**, recorded silently: the change in DTM. Kinds of move:
- best: the distance dropped by 1
- slack: the distance stayed or dropped less than it could have
- lost ground: the distance went up by 2 or more
- threw it away: the position became a draw

**Review** (after a fail, optional after a solve): the move list with DTM after each move, and the move that lost
the most marked ("the king got out of the box here, +3"). "Best from here" plays the table's line from that move.
Then "Next position". After a solve: "Mate in 12, the fastest was 9."

### Levels

| Ending | Level | Start DTM | Slack | Counter |
|--------|-------|-----------|-------|---------|
| KQRK | 1 | 2-3   | +8  | shown  |
|      | 2 | 3-4   | +5  | shown  |
|      | 3 | 4-6   | +2  | hidden |
| KRRK | 1 | 2-4   | +8  | shown  |
|      | 2 | 4-5   | +5  | shown  |
|      | 3 | 5-7   | +2  | hidden |
| KQK  | 1 | 3-5   | +10 | shown  |
|      | 2 | 5-7   | +6  | shown  |
|      | 3 | 6-8   | +4  | hidden |
|      | 4 | 8-10  | +3  | hidden |
|      | 5 | 9-10  | +1  | hidden |
| KRK  | 1 | 5-8   | +12 | shown  |
|      | 2 | 8-11  | +8  | shown  |
|      | 3 | 10-13 | +6  | hidden |
|      | 4 | 12-15 | +4  | hidden |
|      | 5 | 14-16 | +2  | hidden |
| KBBK | 1 | 6-10  | +12 | shown  |
|      | 3 | 12-16 | +6  | hidden |
|      | 5 | 17-19 | +3  | hidden |
| KBNK | 1 | 8-12, king already in a corner the bishop controls | +15 | shown |
|      | 2 | 12-18, king in the wrong corner | +10 | shown |
|      | 3 | 18-24 | +8  | hidden |
|      | 4 | 24-30 | +6  | hidden |
|      | 5 | 28-33 | +4  | hidden |

KQRK and KRRK have only 3 levels: their mates are short, so there's little room for more. (KBBK levels 2 and 4 sit
between their neighbours.) The top level is never slack +0: perfect play is unreasonable even for strong players.
KBNK's budget stays under the 50-move rule at every level.

### Start positions

Random squares repeat themselves in disguise: a mirrored or rotated position teaches nothing new. So:

1. Keep every legal position whose DTM is in the level's band, with white to move and black not in check.
2. Sort them into buckets by the black king's zone (centre 4x4, middle ring, edge, corner) and, for KBNK, by whether
   it's near the right corner or the wrong one. Use the buckets in turn, then pick at random inside one.
3. Store the last 50 positions in their symmetry-normalised form and never deal one of those again.

## KPK drills

Same tables, a different goal:

- **Attack**: promote and win, as white. Positions are chosen where few moves win (opposition, key squares). The
  difficulty is how many only-moves the position needs, from 1 up to 4 or more.
- **Defence**: the user has white's lone king against a black king and pawn, and must hold the draw (the pawn taken,
  stalemate, or 20 moves held). The engine attacks perfectly. White always moves up the board, as in the rest of the
  tab.
- **Grading**: a move that changes the result (a win thrown into a draw, or a draw into a loss) ends the attempt at
  once and opens the review. That's the clearest signal for this ending.
- No move budget. The levels are the only-move counts.

## Progression and storage

- Each ending has its own level. 3 solves in the last 4 attempts moves you up a level. 2 fails in a row moves you
  down (never below 1). An ending gets a star when its top level is reached.
- `drill_attempts` table (db.js): `{id, ts, ending, level, fen, dtm, budget, moves_used, result, ms, worst_loss}`.
  It's synced the same way puzzle_attempts is, so web accounts and the desktop app keep it.
- The level is worked out from the record, like the puzzle rating, never stored separately.
- Logged attempts are the data for tuning the level tables after a couple of weeks of use.

## Files

| File | What |
|------|------|
| `js/core/endgame-table.js` (+ test) | generator, index, probe |
| `js/core/drills.js` (+ test) | level tables, position picker, defender, grading, budget, kinds of move |
| `scripts/build_endgame_tables.js` | 4-piece `.bin` files, the lichess spot check |
| `js/server/drills.js`, `routes-drills.js` (+ tests) | record, progression, next drill; modelled on puzzles.js |
| `js/server/db.js`, `sync.js` | drill_attempts schema and sync |
| `chess_review/static/index.html` | "Develop your instinct" tab: a card for each ending with level and star, the drill board, review |
| packaging and web deploy | ship the `.bin` files (names safe from ad blockers, no "analyse" and the like) |

There's no Python version of this, so it needs no parity tests. Check that the tab label fits on a phone; the tab
bar may need a shorter label there.

## Phases (one session each, committed at the end of each)

1. Tables: the 3-piece runtime build, the offline build for KQRK and KRRK, `drills.js`, and their tests. Check the
   maxima and the phone build time.
2. Storage, sync, routes, progression.
3. Page: the tab, drill board, mate counter, review, ending cards. Web and desktop. Phone layout.
4. KBBK and KBNK: their tables, shipping, levels.
5. v2: rook endings (KQKR table, position script with Syzygy checks, outcome grading, Stockfish review).

## Rook endings (v2)

Rook and pawn against rook, the most common endings in real games. Lucena is how to win (shelter your king from
checks and promote), Philidor is how to draw (keep your rook on the right rank). They have 5 pieces, too many for a
table of our own, and Stockfish's eval is no good as a move-by-move judge here (drawn positions often show +0.5 to
+1.5, won ones +2 to +5). So Stockfish only plays, and the attempt is graded by its outcome. All offline at runtime.

- **Start positions** are made at build time: a script varies Lucena and Philidor setups and checks each one
  against the Syzygy tablebases on the dev machine. Only positions verified as won (Lucena) or drawn (Philidor)
  ship.
- **The opponent** is Stockfish at full strength (the full net, never the lite one).
- **Lucena** succeeds when the pawn promotes and the queen survives. That's queen against rook, a 4-piece ending, so
  a KQKR table of our own finishes the grading exactly. It fails on a draw (pawn lost, repetition, 50-move rule).
- **Philidor** succeeds when you take the pawn, reach rook against rook, or hold 30 moves. It fails if the pawn
  promotes.
- **The review** after a fail is approximate and says so: a deeper Stockfish pass over the game points at the likely
  mistake ("probably here: the rook left the 6th rank").
- Levels: how far the setup is from the textbook position (Lucena: the king still has to cross; Philidor: the
  attacker's king is already near the 6th rank), and for Lucena a move budget.

Built after v1. At low ratings the basic mates and KPK cost more games.

## Open decisions

None at the moment.

## Risks

- Position picking and the review screen are the parts that decide whether this trains instinct or turns into a
  game. Test them by playing, not just with unit tests.
- Drills like these exist on lichess (Practice) and chess.com (Drills). The idea is fine. Use our own positions,
  layout and wording, and copy neither.
- Building tables on a slow phone: covered by the measurement in phase 1.
