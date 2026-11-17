# Phase 6 spec: the clock

Branch claude/instinct-clock (worktree .claude/worktrees/instinct-clock, from main 75989f6). Product rules:
docs/training-grounds.md "The clock (phase 6)". Earlier specs: p2 (record, progression, star, sync flag), p3
(stateless move route, page), p5 (rook drills). One build round; the open questions at the end go to the user first.

Do not touch js/web/worker.js, web/*.js or scripts/vendor_*.sh: the main checkout has another session's uncommitted
work there. Nothing in this phase needs them. Before merging, check main for a SCHEMA_VERSION bump by anyone else.

## Decisions

1. **The page keeps the clock; the server sizes it and checks it.** The move route is stateless (p3) and, on the
   web, runs in the tabs' worker in the same browser; on desktop on 127.0.0.1. There is no remote party to cheat,
   the record is the user's own, and only the page knows when the reply was drawn and the board took input. A
   server clock from request times would count the 350 ms reply delay, the 180 ms animation and Stockfish's search,
   and the stateless route would still need the page to send its times. So: GET /next returns the clock for the
   dealt start, the page times the user's turns with performance.now(), and POST /attempt refuses a clock that
   doesn't match the table or times that don't add up. The move route does not change.
2. **Timed levels are level numbers above the top** (KQK Clock 1 = level 6). One ladder, one progression function.
   They deal the top level's positions (`dealLevel`), with its budget and slack.
3. **Timed rows sync in their own file**, `drill_timed.jsonl`, behind a new client flag `drill_clock`. Untimed rows
   keep their exact old line in drill_attempts.jsonl. An older app (v1.1.x, or the web page cached by the service
   worker) never sees a timed row, so it can't strip the new keys and send the stripped line back, nor delete it
   (the phase 2 bug class). Rejected: new keys on drill_attempts.jsonl lines (old clients' lineRow drops unknown
   keys, readLines then differs from the base and the sync removes the full line); per-move times on untimed rows
   (same problem, and `ms` already gives a first tuning signal).
4. **Promotion to Clock 1 is lazy in the replay** (see Progression), so an old record replays to exactly the level
   and star it has today.

## Files
- js/core/drill-clock.js (new, pure) + js/core/drill-clock.test.js.
- js/core/drills.js: nothing but a comment pointing at drill-clock.js (LEVELS unchanged).
- js/server/db.js: DRILL_CLOCK_COLUMNS, DRILL_ROW, SCHEMA_VERSION 6, UPGRADES step 6.
- js/server/drills.js: RESULTS gain 'time', COLUMNS, attempts() order, progress(), status(), parseAttempt(),
  record(), nextDrill(), parseMove() (dealLevel), topLevel split.
- js/server/routes-drills.js: header comment (drill.clock, status fields); `next` level bound uses the full ladder.
- js/server/sync.js: KEYS.drill_timed, locate() with a row filter, readLines/writeLines/deleteLines, libraryFiles,
  tidy.
- worker/src/store.js, worker/src/index.js: the file name, isTimedDrills, the `drill_clock` flag.
- chess_review/static/account.js: send `drill_clock: true`.
- chess_review/static/index.html (both apps): clock, pause cover, 'time', review times, level names, clock star.
- Tests: drill-clock.test.js, drills.test.js, routes-drills.test.js, worker/test/account.test.js; fast.test.js (or
  wherever schema 5 is asserted) to 6.
- docs/training-grounds.md "The clock (phase 6)": update to what was built.

## drill-clock.js

```js
// seconds a move per tier, and the increment after each user move; the only place to tune
export const CLOCK_TIERS = {
  table: { perMove: [4, 3, 2], inc: 1 },     // the mate drills, KPK, KPK-hold
  rook:  { perMove: [6, 4],    inc: 2 },     // Lucena, Philidor
};
export const CLOCK_MOVES = { KPK: 12, 'KPK-hold': HOLD_MOVES, Philidor: HOLD_ROOK };   // no budget: a fixed count
export const MIN_BASE = 10;                  // seconds
```
- `untimedTop(ending)` = LEVELS[ending].length; `tiers(ending)` = the tier list's length (3 or 2);
  `ladderTop(ending)` = untimedTop + tiers.
- `tierOf(ending, level)` = 0 for level <= untimedTop, else level - untimedTop (RangeError above ladderTop).
- `dealLevel(ending, level)` = min(level, untimedTop): the level whose band, slack and ROOK_STARTS are dealt.
- `clockFor(ending, level, { budget })` -> null for an untimed level, else `{ tier, base_ms, inc_ms }`:
  moves = CLOCK_MOVES[ending] ?? budget (mate drills and Lucena have one; a null budget there is a RangeError);
  base_ms = max(MIN_BASE, moves * perMove[tier - 1]) * 1000, inc_ms = inc * 1000. Integers.
- `replayClock(clock, moveMs)` -> the ms left after each turn (left -= ms; then += inc for a move made), used by
  parseAttempt. The page (an inline script, no module imports) keeps its own running value while playing, with the
  same rule; a test in drill-clock.test.js pins the rule both follow.

Sizes this gives (base, plus the increment per move):

| Ending (top budget) | Clock 1 | Clock 2 | Clock 3 |
|---------------------|---------|---------|---------|
| KQRK (6-8)  | 24-32 s +1 | 18-24 s +1 | 12-16 s +1 |
| KRRK (7-9)  | 28-36 s +1 | 21-27 s +1 | 14-18 s +1 |
| KQK (10-11) | 40-44 s +1 | 30-33 s +1 | 20-22 s +1 |
| KRK (16-18) | 64-72 s +1 | 48-54 s +1 | 32-36 s +1 |
| KBBK (20-22) | 80-88 s +1 | 60-66 s +1 | 40-44 s +1 |
| KBNK (32-37) | 128-148 s +1 | 96-111 s +1 | 64-74 s +1 |
| KPK (12)    | 48 s +1 | 36 s +1 | 24 s +1 |
| KPK-hold (20) | 80 s +1 | 60 s +1 | 40 s +1 |
| Lucena (promote + 8, about 18-25) | 108-150 s +2 | 72-100 s +2 | |
| Philidor (30) | 180 s +2 | 120 s +2 | |

The builder confirms the budget ranges from LEVELS and ROOK_STARTS (Lucena L4's promote + 8) and measures KPK's
moves to promotion along the table line at level 4 over 200 deals: if its p90 is above 12, set CLOCK_MOVES.KPK to
that p90 and say so.

## Schema (db.js)

The precedent is SOLVED_SCHEMA + SOLVED_CLEAN: the table made at step 5 stays as it is, and step 6 adds the columns
to every database that has it, new or old, so both have the same schema text.
- `DRILL_CLOCK_COLUMNS = [['clock', 'JSON'], ['move_ms', 'JSON'], ['paused', 'INTEGER']]`;
  `DRILL_ROW = [...DRILL_ATTEMPTS_SCHEMA, ...DRILL_CLOCK_COLUMNS]`.
- clock: `{tier, base_ms, inc_ms}` or NULL (untimed). move_ms: `[int]`, the think time of each user turn, or NULL.
  paused: how many times the clock was paused, or NULL.
- SCHEMA_VERSION 6; UPGRADES `[6, db => { if (hasTable(db, 'drill_attempts')) for each missing column ALTER TABLE
  drill_attempts ADD COLUMN }]`. Update the version comment.
- An older app on a schema 6 database (a downgrade): Store only upgrades when v < SCHEMA_VERSION, so it opens; its
  queries name their columns. Its sync would export timed rows into drill_attempts.jsonl without their clock: see
  Sync, "downgrade guard".
- D1 (web accounts): no migration. The Worker keeps lines as text per file; only the file name check changes.
  MAX_LINE is 2000 bytes; a timed line with 40 moves is about 450. parseAttempt caps move_ms at 150 entries.

## Progression (server/drills.js)

- `topLevel(ending)` now means ladderTop (levels the record may hold); add `untimedTop` from drill-clock.js. Every
  current caller of topLevel is checked: parseAttempt and parseMove level bounds use ladderTop; the star uses
  untimedTop.
- `attempts()` orders by `ts, seq` (was seq). Writing one sync file reinserts its rows with new seqs, so seq alone no
  longer interleaves timed and untimed rows; ts is what the sync merge orders by anyway. COLUMNS gains the three.
- RESULTS: every kind's failed list gains 'time'. parseAttempt allows 'time' only at a timed level.
- `progress(ending, rows)` -> `{level, top, tiers, star, clock_star, run}` with top = untimedTop (unchanged meaning):
  - as today for every level, except the step from untimedTop to Clock 1: when the run at untimedTop has 3 solved,
    set `ready` instead of moving. While ready, a row at untimedTop is handled as before (the run slides, ready is
    worked out again, 2 fails go down); a row at untimedTop + 1 first moves up (run cleared) and is then counted
    there. At the end, ready means level = untimedTop + 1 with run [].
    This keeps every record made before phase 6 replaying to the level it has today (it has no rows above the top),
    while a player who qualifies lands on Clock 1.
  - star: as today, a solve counted at untimedTop. clock_star: a solve counted at ladderTop. Both sticky.
  - a row with clock NULL above untimedTop, or with a clock at or below it, is skipped (not a row this version
    could have written: a stripped copy, see Sync).
  - rows with the same id: the first by (ts, seq) is kept; the sync guard should make this unreachable, but status
    counts must never double.
- `status()` adds `tiers`, `clock_star`, `tier` (tierOf the level), and `clock` per recent row is not needed.
- `nextDrill`: `row = levelOf(ending, dealLevel(ending, at))`, pickStart at dealLevel, drill gains
  `clock: clockFor(ending, at, {budget: start.budget})` (null when untimed) and `level: at`. counter is false on
  timed levels (the top's is false already; assert it).
- `parseMove`: level bound ladderTop, band and rook start prefix from dealLevel. Nothing else (no clock there).

## parseAttempt (the plausibility check)

Untimed level: clock, move_ms and paused must be absent or null (else 400). Timed level:
- dtm and budget as today; for a mate drill also budget === dtm + the top's slack (the clock is sized from it).
- clock deep-equal to clockFor(ending, level, {budget}) (400 "clock: {..} for this start").
- move_ms an array of integers 0..3,600,000, at most 150. Length: moves_used for every result except 'time', where
  it is moves_used + 1 (the last entry is the turn the clock ran out on). 'abandoned' may also be moves_used + 1 (a
  turn under way when left).
- replayClock: no turn of a made move ends below -250 ms; for 'time' the last turn ends within 250 ms of 0.
- sum(move_ms) <= ms + 250 (ms required, the attempt's wall time, which includes everything the clock doesn't).
- paused integer 0..1000.
Store clock and move_ms as given (JSON columns), paused as is.

## Sync (sync.js, the Worker, account.js)

- `KEYS.drill_timed = [...KEYS.drill_attempts, 'clock', 'move_ms', 'paused']`. rowLine/lineRow work on a key list
  per file kind, the table stays drill_attempts; check pyDumps writes the nested object and array as puzzle_daily's
  marks does, and that a JSON column comes back decoded (Db DECODE) before rowLine.
- `locate('drill_timed.jsonl')` -> `{db: PROGRESS, table: 'drill_attempts', keys: 'drill_timed', where: 'clock IS
  NOT NULL'}`; drill_attempts.jsonl gets `where: 'clock IS NULL'`. readLines, writeLines (DELETE ... WHERE <where>,
  then insert) and deleteLines use it, as puzzle_attempts uses archive. SCHEMAS.drill_attempts becomes DRILL_ROW.
- libraryFiles: drill_timed.jsonl when there are timed rows. tidy: oncePer('id') for it, sorted by ts as the rest.
  switch/release (moveLines over libraryFiles) and the guest hand-over then carry it with no more change.
- **Downgrade guard**: writeLines('drill_attempts.jsonl') drops any line whose level is above untimedTop of a known
  ending or whose result is 'time' (an older app's stripped copy of a timed row). Since readLines then doesn't give
  it back, the next delta removes it from the account. An older app that keeps re-adding it only causes churn.
- Worker store.js: FILE regex gains `drill_timed`; `isTimedDrills = f => f === 'drill_timed.jsonl'`; progress()
  and the POST filter hide it unless `drill_clock` (GET ?drill_clock=1, POST body drill_clock: true), exactly as
  `drills`. index.js header comment.
- account.js: `{ ...d, own_puzzles: true, drills: true, drill_clock: true }`.
- **Release order**: Worker first. A new client against the old Worker gets 400 "not a puzzle-progress file" once it
  has a timed attempt, which stalls the whole sync until the Worker is deployed (no data loss). Say so in HANDOFF.

## Page (chess_review/static/index.html, both apps)

Clock state in `dr`: `clock` (the drill's), `left` (ms), `turnAt` (performance.now() when the turn began, null while
not the user's turn), `moveMs` [], `paused` 0, a timer. All in one small block of functions: `clockStart()`,
`clockStop()` (returns the turn's ms and adds the increment), `clockLeft()`, `clockFlag()`.
- **When it runs.** The turn starts when the board takes a move: at startDrill once the board is drawn, and after
  each reply in drillMove's setTimeout once the reply is on the board, plus the piece animation (the `.pc`
  transition, 180 ms: start the turn from `transitionend` of the moved piece, or 180 ms after `go()` if none fires).
  It ends at the top of drillMove (before applyMove and the POST). During the POST, the 350 ms reply delay,
  "Stockfish is thinking" and the animation it is stopped. A refused move (the board taken back) restarts the turn
  with the time it had, no increment.
- **Flag.** A setTimeout for exactly `left`, and drillMove checks clockLeft() first: at 0 or below the move is not
  taken. On flag: input off (cancel a drag in progress), moveMs gets the remaining time of that turn, then the same
  path as giveUpDrill with result 'time' (the review built from dr.answers, as 'abandoned' does; zero moves gives an
  empty review). recordDrill sends clock, move_ms, paused for a timed drill and nothing new for an untimed one.
- **Hidden.** On visibilitychange to hidden during the user's turn: stop the turn (no increment), paused++. On
  return: cover the board (a "Paused" card over it, the existing pzover style, button "Go on") and restart the turn
  on the tap. Not during the reply (the clock is stopped then anyway).
- **Leave, reload, Give up, Escape**: 'abandoned' as today, with the times so far (pagehide already records). No
  resume after a reload.
- **Display.** In `.pzhead`, a `.dclock` before `.cnt`: `m:ss` above 10 s, `s.t` at or under 10 s, amber under
  10 s, `var(--c-miss)` under 5 s; tabular-nums and a fixed min-width so the stats area never changes width (the
  phone layout forbids rows around the board changing size). Update every 250 ms, every 100 ms under 10 s, from
  performance.now(), never by counting ticks. Phone (portrait, under 900 px): it sits in the "stats" area next to
  the title, 15px bold; wide: 22px. The player rows are hidden on phones in puzzle mode, so not there.
- **Names.** One helper for every place a level is shown: "Level 3 of 5" for untimed, "Clock 2 of 3" for timed
  (title, box head, drillSide, cards, home tile and Continue strip, drillLevelNews). Grep for `level ${` and
  `of ${` and `.top` in the drill code: none may say "level 6 of 5". Cards and drillSide: the untimed pips as now,
  then the tier pips as outlined pips (filled once reached); the clock star beside the star, a small clock icon in
  the star's colour (an inline SVG in the page's icon set, not an emoji). drillSide goal lines: at the top level
  "Three of four solved: on to the clock"; on a tier "Three of four solved: a faster clock"; on the last tier
  "The fastest clock: solve one for the clock star". Level news: "On the clock: 4 s a move.", "A faster clock: 3 s
  a move.", "Off the clock for now.", "Clock star earned: solved on the fastest clock."
- **End card and summary** for 'time': headline "Out of time"; summary "The clock ran out on move N." (or "before
  your first move"). Solves on a timed drill add "M:SS left." to the summary.
- **Review.** Timed drills: a time column in `.drow` (`4.2s`, 12px, muted), long moves bold in amber with the title
  "Long think". Long = at least 2 x the median of the attempt's turns and at least 2 s over it, with 3 turns or
  more. Rook rows get the column too. A line above the list: "42 s of 52 used, 2.1 s a move; the longest was move 7,
  9.4 s." (the base plus increments as the total). Check `.drow` at 360 px wide: if the kind badge and the time
  don't fit, drop the distance column's words to the short form there, not the time.
- Own wording and layout; nothing copied from chess.com or lichess clocks (no two-clock bar, no their colours).

## Edge cases
- Practice levels (?level=N, API only; no UI): a timed level not yet reached can be dealt and recorded, and moves
  nothing, as today.
- Hints: none during play (Best from here, the engine line and the rook hint are review only). Stepping back
  through the moves during a turn is allowed and the clock runs.
- Skip before the first move: not counted, as today (the clock is discarded).
- The drill ends on the user's move (mate, budget, a throw): the turn's time is recorded, the clock stops.
- Clock out with a move's POST in flight cannot happen: the turn ended at the move.
- An attempt refused by parseAttempt (400) is logged by the page and lost, as today; the clock checks have the 250 ms
  slack so rounding never trips them.
- Changing CLOCK_TIERS later: a page and server always ship together (web worker and page from one build, Electron
  one bundle), so a deal and its record agree. Old rows keep their stored clock.

## Tests
- drill-clock.test.js: every ending's tiers and sizes against the table above (from LEVELS and ROOK_STARTS),
  MIN_BASE, dealLevel/tierOf/ladderTop, RangeErrors, replayClock with and without a flag.
- drills.test.js progression: (1) a property test over 2,000 random untimed records per ending: level and star equal
  today's progress() (copy main's function into the test as the oracle) except when today's ends at the top with 3
  of the last 4 solved, where the new one is Clock 1 with run []; (2) S S F S at the top then a Clock 1 row: counted
  at Clock 1; (3) ready, then F F at the top: down; (4) two fails at Clock 1: back to the top, run cleared; (5) the
  star and clock star sticky, a practice solve at the last tier earns neither; (6) a NULL-clock row above the top and
  a duplicate id are skipped.
- parseAttempt: timed bodies accepted; refused for a wrong clock, a clock on an untimed level, 'time' untimed,
  move_ms wrong length, a turn below zero, 'time' with time left, sum over ms, over 150 entries, non-integers.
- record and nextDrill: a timed deal at the top level's band with drill.clock; the row's JSON columns round trip.
- db: schema 5 database (with rows) to 6 equals a fresh 6 on node:sqlite and SQLite WASM; rows kept.
- sync: (1) an untimed row's line is byte-identical to the schema 5 line (golden string from main); (2) timed rows
  only in drill_timed.jsonl, untimed only in drill_attempts.jsonl; writing one file leaves the other's rows; (3) two
  stores round trip both files and their levels agree with interleaved ts; (4) an old client (a Sync whose merge
  never sees drill_timed.jsonl) sends no remove for timed rows; (5) the downgrade guard: a stripped timed line in
  drill_attempts.jsonl is dropped, removed on the next delta, and the level doesn't change; (6) libraryFiles lists
  the new file; (7) the existing "unknown ending survives" test still passes.
- routes-drills.test.js: next at a timed level (clock, band), attempt with a timed body, status fields, 'time'.
- worker/test/account.test.js: drill_timed.jsonl accepted, hidden from an app without drill_clock (one with drills
  only included), its removes ignored, shown with the flag.

## Done
- `npm test` green (Node 22 from ~/.nvm, `js/run-tests.js`), worker vitest green; rerun Python parity with
  PARITY_UPDATE=1 only if a frozen dump changed, and say which.
- Electron (borrow instinct-p3's electron binary, temp CHESS_REVIEW_DATA, CDP from Node's WebSocket; see
  electron-check-wsl in memory and p5-r4-handover.md): seed KQK to its top level and ready by POSTing solved
  attempts built from /next (3 per level), then: one Clock 1 solve played with the /line moves at about 1 s a turn
  (record shows the clock, move_ms of about 1,000 each, star unchanged); one 'time' fail by waiting (end card, review
  with times, the turn that ran out); one pause (set document hidden via Runtime.evaluate and fire visibilitychange,
  check the cover and that the clock didn't move); 2 fails on Clock 1 back to level 5; one Lucena Clock 1 move to
  see Stockfish's search leave the clock alone (left before the move minus think time, unchanged by the reply).
- Web build (`node scripts/build_web.js --serve`), headless Chromium at 390x844, isMobile, hasTouch, Android UA, CPU
  throttled 4x (Emulation.setCPUThrottlingRate): the same Clock 1 solve and 'time' fail; screenshots of the clock
  under 10 s, the end card and the review; no horizontal scroll (scrollWidth 390), the board doesn't move as the
  clock turns amber.
- **Phone input latency.** Moves by tap-tap with CDP Input.dispatchTouchEvent. An injected capture listener logs
  performance.now() at touchstart of the second tap; compare with the turn end the page records: p90 under 50 ms
  over 20 moves on the throttled phone. Also log the gap from the reply's arrival to the turn start (should be about
  the 180 ms animation, never counted). Then play KQK Clock 3 and KBNK Clock 3 by script at 1.5 s a turn with the
  table's moves: both must solve with time left; report the clock left. Report how it felt in one line if the user
  tries Clock 3 on a real phone (ask them; it is the only real check of tap speed).
- Screenshots and a hand-over (p6-build-handover.md) in the coordinator's notes folder; docs updated.

## Open questions for the user (with my recommendation)
1. Tier numbers: 4/3/2 s a move + 1 s for the table endings, 6/4 s + 2 s for Lucena and Philidor, a 10 s floor.
   Recommend as is, tuned after two weeks.
2. A player already at a top level with 3 of the last 4 solved opens on Clock 1 after the update. Recommend yes
   (they earned it; no record changes). The alternative is 3 fresh solves at the top after the update, which needs a
   cut-off date in the replay.
3. Hidden tab: pause and cover the board (recommend: phones get calls and notifications), or let it run as a real
   game does.
4. Rook endings get 2 timed tiers, the others 3. Recommend yes: 30-move Philidor at 2 s a move trains nothing.

## Risks
- The clock on a phone is only as fair as the tap handling: measure, don't assume (Done, phone latency).
- KBNK Clock 3 may be near impossible for most; that's the top of the hardest ending. Watch its solve rate first.
- The ts order change in attempts(): a local record with a clock that jumped back could replay differently. Low;
  the sync merge already orders by ts.
