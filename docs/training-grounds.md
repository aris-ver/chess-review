# Develop your instinct: endgame drills

Drafted 2026-11-16. v1, v1.1, v2 and the clock are built (phases 1 to 6). The numbers in the level and clock tables
are starting points, to be tuned from real attempts.

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
**v1.1**: KBBK, KBNK. They're rare in real games, so they come after. Built in phase 4.
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

## Mate drills (KQRK, KRRK, KQK, KRK, KBBK, KBNK)

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
|      | 2 | 10-13 | +9  | shown  |
|      | 3 | 12-16 | +6  | hidden |
|      | 4 | 15-18 | +4  | hidden |
|      | 5 | 17-19 | +3  | hidden |
| KBNK | 1 | 8-12, king in or next to a corner the bishop controls | +15 | shown |
|      | 2 | 19-24, king in or next to a wrong corner | +10 | shown |
|      | 3 | 18-24 | +8  | hidden |
|      | 4 | 24-30 | +6  | hidden |
|      | 5 | 28-33 | +4  | hidden |

KQRK and KRRK have only 3 levels: their mates are short, so there's little room for more. The top level is never
slack +0: perfect play is unreasonable even for strong players. KBNK's budget stays under the 50-move rule at every
level (37 moves at most, at level 5). KBNK level 2 starts at mate in 19 because no position with the
king in or next to a wrong corner is any shorter: driving it out of there is the long part. KBBK deals only bishops
on opposite colours; on one colour they can't mate.

### Start positions

Random squares repeat themselves in disguise: a mirrored or rotated position teaches nothing new. So:

1. Keep every legal position whose DTM is in the level's band, with white to move and black not in check.
2. Sort them into buckets by the black king's zone (centre 4x4, middle ring, edge, corner) and, for KBNK from
   level 3, by whether it's nearer a right corner or a wrong one (levels 1 and 2 fix the corner themselves). Use the
   buckets in turn, then pick at random inside one.
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
| `js/core/drill-clock.js` (+ test) | the clock tiers table, the clock for a start, the timed levels (phase 6) |
| `worker/src/store.js`, `index.js` | the account's files: `drill_timed.jsonl` behind the `drill_clock` flag (phase 6) |
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
6. The clock: timed levels above each ending's top level, the clock on the page, time per move in the record and the
   review, a second sync file for timed attempts. Spec: `.coordination/p6-spec.md`.

## Rook endings (v2)

Rook and pawn against rook, the most common endings in real games. Lucena is how to win (shelter your king from
checks and promote), Philidor is how to draw (keep your rook on the right rank). They have 5 pieces, too many for a
table of our own, and Stockfish's eval is no good as a move-by-move judge here (drawn positions often show +0.5 to
+1.5, won ones +2 to +5). So Stockfish only plays, and the attempt is graded by its outcome. All offline at runtime.

The user is always white: Lucena is white king, rook and pawn against king and rook (Stockfish defends), Philidor
white king and rook against king, rook and pawn (Stockfish attacks). The cards say "Lucena" and "Philidor", each with
a plain line under it ("win rook and pawn against rook", "hold rook against rook and pawn").

- **Start positions** are made at dev time by `scripts/build_rook_starts.js` into `js/core/rook-starts.js`: seeded
  setups in four families per ending, each checked against the lichess tablebase (Lucena 'win', Philidor 'draw', and
  at least one of the user's first moves changes the result). Dealt mirrored left and right at random, never one of
  the last 30 dealt at that level.
- **The opponent** is Stockfish on an engine of its own (Hash 16, `go nodes 200000`, the game's moves sent so it sees
  repetitions), so a review never delays a reply. Desktop: one native engine; desktop browsers: one full-net WASM
  engine. Phones get none this phase: the two cards say "Needs a computer" and nothing is downloaded.
- **Grading** (`js/core/rook-drills.js`) is by outcome. Anything down to 4 pieces is read from our tables (KQK, KRK,
  KPK, KQRK, KRRK, KQKR, KRKR). Lucena is solved when, after the promotion, Stockfish's own search sees itself mated
  ('promoted'), or a table says white wins ('won'); it fails on a draw (pawn lost, rook lost, repetition, 50-move
  rule, stalemate), on running out of moves (budget = the start's moves to promote + the level's slack, 8/6/5/4), or
  when the new piece hasn't won 10 moves after the promotion. Philidor is held after 30 moves, by taking the pawn or
  the rook, by stalemate, repetition or the 50-move rule; it fails when the pawn promotes and isn't taken at once,
  or a table says black wins.
- **The page** counts down instead of the mate counter: "Promote the pawn: N moves left", after the promotion "Keep
  the new queen: N moves left", Philidor "Hold the draw: N more moves". A reply out for more than 300 ms shows
  "Stockfish is thinking".
- **The review** (POST /api/drills/hint) is approximate and always says so ("This is an estimate from a deeper
  engine search, not a tablebase."). Every position where the user was to move (the last 20 moves) is searched again
  at 400,000 nodes on the analysis pool, all at once; the move after which the score fell most (scores held to
  +-500, so a win kept by a slower move is no mistake) is "Probably here", if it fell 100 or more; otherwise "No
  single move stands out". A named hint when the move matches one: Lucena, the rook stopped cutting the black king
  off, the king left its shelter before the rook was on the 4th rank, the pawn was left hanging; Philidor, the rook
  left the 3rd rank before the pawn reached it, the pawn reached the 3rd rank and the rook didn't go to the far end,
  the king left the pawn's path. "The engine's line from here" plays Stockfish's line (8 plies) from a chosen move.
  The move list shows at once, without a distance column, and the hint fills in when it lands (about 1 s on a
  desktop).
- **Levels**: four per ending, by family (Lucena: bridge, cut first, pawn on the 6th, pawn on the 5th; Philidor:
  third rank, go behind, get there in time, king off the path).

## The clock (phase 6)

Once an ending is mastered without a clock, time is the next difficulty. Real games give a total clock, not a limit
per move, and a cap per move punishes the one move worth thinking about. So a timed drill has a total clock with an
increment, like a game.

**Levels.** Each ending gets timed levels above its top level: Clock 1, 2 and 3 for the eight table endings, Clock 1
and 2 for Lucena and Philidor. They deal the top level's positions with its budget; only the clock changes. The
rules are the same (3 solves in the last 4 up, 2 fails in a row down), so two fails on Clock 1 go back to the top
level without a clock. In the record a timed level is a level number above the top (KQK's Clock 1 is level 6).
Three of the last four solved at the top level move the ending on to Clock 1; this is worked out when the first
Clock 1 attempt comes (or at the end of the record), so a record made before the clock replays to the level it had,
and a player who had already qualified at a top level opens on Clock 1.

**Size of the clock.** `base = clock moves x seconds a move` for the tier (at least 10 s), plus an increment after
each of your moves. Clock moves are the start's move budget for the mate drills and Lucena, and a fixed count where
there is no budget: KPK 20, KPK-hold 20 (the moves to hold), Philidor 30. KPK's 20 is the 90th percentile of the
moves to promotion along the table's line at its top level, over 200 deals (median 15, longest 26).

| Endings | Tier | Seconds a move | Increment |
|---------|------|----------------|-----------|
| Mate drills, KPK, KPK-hold | Clock 1 | 4 | 1 s |
|                            | Clock 2 | 3 | 1 s |
|                            | Clock 3 | 2 | 1 s |
| Lucena, Philidor           | Clock 1 | 6 | 2 s |
|                            | Clock 2 | 4 | 2 s |

For example KQK's top level has a budget of 10 or 11 moves, so Clock 1 is 40 to 44 s plus 1 s a move, and Clock 3 is
20 to 22 s plus 1 s a move. KBNK's Clock 3 is 64 to 74 s for up to 37 moves. All in one table in
`js/core/drill-clock.js`, to be tuned.

**Only your turns count.** Your clock runs from the moment the board takes your move (the reply drawn and its
animation done) to the moment you make it. The defender's reply, Stockfish's thinking, the route's time and the
animations never count. The page keeps the clock: on the web and on desktop the "server" is on the same device and
holds no state between moves, and only the page knows when the board was ready. The record route checks that the
clock settings match the table and that the times add up.

**Running out** ends the attempt with a new fail, 'time'. Hiding the tab or the window pauses the clock and covers
the board with a "Paused" card until you come back and tap "Go on". Leaving, reloading or giving up is 'abandoned',
as now, with the times so far.

**On the screen.** The clock sits before the move count above the board (m:ss, then tenths under 10 s, amber under
10 s, red under 5 s), at a fixed width so nothing around the board moves. Wherever a level is named, a timed one is
"Clock 2 of 3"; the level pips go on with the tiers as outlined pips, filled once reached; the clock star is a small
clock beside the star. The level news says "On the clock: 4 s a move.", "A faster clock: 3 s a move.", "Off the
clock for now." and "Clock star earned: solved on the fastest clock."

**Marks.** The star keeps its meaning: solved at the top level without a clock. A second mark, the clock star, is
for a solve on the last clock tier while the ending is there.

**Record.** A timed attempt also stores its clock (tier, base and increment in ms), the time of each of your moves,
and how often the clock was paused. Untimed attempts are stored and synced exactly as before. Timed attempts sync in
a file of their own, `drill_timed.jsonl`, behind a client flag of its own, so an older app never sees them and
can't strip or delete them.

**Review.** After a timed attempt the move list shows the seconds each move took, and marks the long ones: at least
twice the attempt's median and 2 s over it (3 moves or more). A line under the result says how the clock went
("42 s of 52 used, 2.1 s a move; the longest was move 7, 9.4 s."). A solve says the time left, a 'time' fail the
move it ran out on.

**Sync and release.** `drill_timed.jsonl` is a new account file, and the Worker only takes it from a client that
says `drill_clock: true`. So the Worker goes out first: a new app against the old Worker gets a 400 for the file
once it has a timed attempt, and its sync stalls (nothing is lost) until the Worker is deployed. An older app on a
device that later ran the new one (a downgrade) never sees the timed file; if it ever writes a timed row's stripped
copy into `drill_attempts.jsonl`, the new app drops that line as it reads the account and takes it off on its next
sync. Local databases go to schema 6 (three columns on drill_attempts); D1 needs no migration.

**Tuning.** Today's `ms` is the whole attempt from the deal, replies and animations included (about 0.5 s a move).
From the untimed top level's solved attempts, `ms / moves_used` less that overhead gives a first idea of how fast
players move: Clock 1 near the 75th percentile, Clock 3 near the 25th. After two weeks of timed play, read each tier's
solve rate, its share of 'time' fails and the clock left on solves, and adjust the table. Each row keeps the clock it
was played with, so a change touches no old data.

## Open decisions

None at the moment. Decided for phase 6 (2026-11-17): the tier numbers as in the table, tuned after two weeks; a
player already qualified at a top level opens on Clock 1; a hidden tab pauses the clock and covers the board; the
rook endings get two tiers, the others three.

## Risks

- Position picking and the review screen are the parts that decide whether this trains instinct or turns into a
  game. Test them by playing, not just with unit tests.
- Drills like these exist on lichess (Practice) and chess.com (Drills). The idea is fine. Use our own positions,
  layout and wording, and copy neither.
- Building tables on a slow phone: covered by the measurement in phase 1.
