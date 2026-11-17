# Phase 6 hand-over: the clock

Branch `claude/instinct-clock` (worktree `.claude/worktrees/instinct-clock`), from main 75989f6. Not pushed, not
merged. Spec: `p6-spec.md`; design: `docs/training-grounds.md` "The clock (phase 6)", now written to what was built.
The open questions went as the planner recommended (tiers as written, qualified players open on Clock 1, a hidden
tab pauses and covers the board, 2 tiers for the rook endings and 3 for the rest).

## Commits
- 05a7437 server side: drill-clock.js, schema 6, progression, parseAttempt checks, nextDrill/parseMove, sync files,
  Worker flag, account.js flag, tests; the spec.
- 57a0ad7 page (both apps, the shared index.html), `per_move` in the status, the doc.
- this note.

## Files
- `js/core/drill-clock.js` (new, pure) + test: CLOCK_TIERS, CLOCK_MOVES, MIN_BASE, untimedTop, tiers, ladderTop,
  tierOf, dealLevel, clockFor, replayClock (each turn's end before its increment), perMove.
- `js/core/drills.js`: a comment only.
- `js/server/db.js`: DRILL_CLOCK_COLUMNS (clock JSON, move_ms JSON, paused INTEGER), DRILL_ROW, SCHEMA_VERSION 6,
  UPGRADES step 6 (ALTER TABLE for each missing column).
- `js/server/drills.js`: RESULTS gain 'time'; topLevel = ladderTop, untimedTop re-exported; COLUMNS; attempts() by
  `ts, seq`; counted() (first row per id, clock must fit the level); progress() with the lazy "ready" step to
  Clock 1, clock_star; status() adds tiers, tier, per_move, clock_star (played/solved/recent from counted rows);
  parseAttempt + checkClock; record stores the three columns; nextDrill deals dealLevel, adds `clock`, counter false
  above the top; parseMove uses dealLevel.
- `js/server/routes-drills.js`: header comment only (the `next` bound already used topLevel, now the full ladder).
- `js/server/sync.js`: KEYS.drill_timed; locate() gives keys and where; readLines/writeLines/deleteLines pick rows
  with rowsOf(); libraryFiles lists drill_timed.jsonl when there are timed rows; tidy oncePer('id') for it; the
  downgrade guard in writeLines(drill_attempts.jsonl). rowLine's first argument is now the key list name.
- `worker/src/store.js`, `worker/src/index.js`: FILE regex, isTimedDrills, the `drill_clock` flag (GET
  ?drill_clock=1, POST body), progress() filter.
- `chess_review/static/account.js`: sends `drill_clock: true`.
- `chess_review/static/index.html`: the clock block (clockReset/Left/Start/Stop/Commit/Times/Check/Flag/Tick,
  clockAfterReply), the pause cover (pzover 'dpause', "Go on"; stepping through the moves leaves it on, Escape or a tap off the card goes on), endDrillHere() for
  'abandoned' and 'time', drillLevelName/drillPips/drillStars/CLOCK_ICON, the review's time column and clock line,
  level news, end summary, "How levels work".
- Tests: drill-clock.test.js (new), drills.test.js, routes-drills.test.js, sync.test.js and fast.test.js (schema 6,
  locate shape), worker/test/account.test.js.

## Schema and sync
- Local: schema 6, three nullable columns on drill_attempts; a schema 5 database (with rows) upgrades to the same
  schema text as a fresh one on node:sqlite and SQLite WASM (tested). An older app opens a schema 6 database (its
  queries name their columns).
- Account: new file `drill_timed.jsonl`, behind `drill_clock`. Untimed lines are byte-identical to schema 5's
  (golden test). D1: no migration.
- **Release order: Worker first.** A new app against the old Worker gets 400 "not a puzzle-progress file" once it
  has a timed attempt; its whole sync stalls until the Worker is out (nothing lost). Then the web push, then desktop.
- Before merging: check main for another SCHEMA_VERSION bump.

## Verified
- `npm test` 369 tests, 351 pass, 0 fail, 18 skipped (main before: 352, 334, 18; the same skips). Worker vitest
  40/40. pytest 38 passed, 1 skipped (one run had `test_only_the_stage_in_focus_opens_its_puzzles` time out; it passed
  alone and in the next full run: flaky, not drills). No frozen parity dump changed.
- KPK clock moves measured: p90 of moves to promotion along the table line at level 4 over 200 deals is 20 (median
  15, max 26), so CLOCK_MOVES.KPK = 20, not 12 (KPK clocks 80/60/40 s).
- Web build, headless Chromium (Playwright from the WSL npx cache) at 390x844, isMobile, hasTouch, Android UA, CPU
  4x throttled, moves by CDP touch taps:
  - KQK seeded to the top with 3 of 4 solved (POSTs from /next) opens on Clock 1 (status level 6, tier 1).
  - Clock 1 solve at about 1 s a turn: move_ms 1053-1069 each, paused 0, star kept, run [true]; summary "0:40 left".
  - Pause: document.hidden faked + visibilitychange: clock 40,099 ms before, the same 3 s later and after return;
    paused 1; the cover shows "Paused" over a covered board; "Go on" restarts the turn. Given up: 'abandoned' with
    the turn under way as the extra move_ms entry.
  - 'time' by waiting: move_ms [77, 40923] (the last turn takes exactly what was left), "Out of time", "The clock
    ran out on move 2.", "Off the clock for now." (two fails on Clock 1: back to level 5). The clock turned `low`
    under 10 s and `crit` under 5 s; the board's rect was the same at all three; scrollWidth 390.
  - Latency: pointerdown of the second tap (a touch pointer) to the turn's end: 0-2 ms over 47 moves (p90 about
    1 ms). No DOM `touchstart` reached the capture listener in headless Chromium, so pointerdown stood in for it.
    The reply drawn to the turn start: 177-181 ms every time (the slide).
  - KQK Clock 3 (20 s +1) at 1.5 s a turn: solved in 9, 13.8 s left. KBNK Clock 3 (66 s +1, budget 33) at 1.5 s a
    turn: solved in 29, 48.4 s left, clock star earned and shown.
  - Cards and home at 390 px: tier pips outlined, "Clock 1/3", Continue "Queen · Clock 1 of 3".
- Electron 44.9.3 (instinct-p3's binary, temp CHESS_REVIEW_DATA, native Stockfish, CDP + Playwright): the same
  Clock 1 solve (move_ms 1023-1039), pause, 'time' and the fall to level 5; wide layout 22 px clock, side panel
  "Clock 1 of 3", goal "Three of four solved: a faster clock". Lucena seeded to Clock 1 (114 s +2): one move after
  1.06 s took the clock 114,000 to 112,938; the reply (Stockfish 727 ms) left it there, plus the 2 s increment
  (114,938); nothing ran during the search. Long-think marking checked in the page on made-up times.
- Screenshots: `C:\Users\arisg\AppData\Local\Temp\claude\2708a047a13f0a79\52ab711d-8c96-436a-ab64-878118bfa6ae\scratchpad\p6-shots\`
  (web-*.png phone, electron-*.png wide, plus each run's report.json).

## Deviations
1. CLOCK_MOVES.KPK is 20 (measured, as the spec asked), not 12.
2. Status also has `per_move` (the tier's seconds a move) for the level news, so the page needs no copy of the table.
3. replayClock returns each turn's end before its increment (what the checks need); the page keeps the same value.
4. The distance column goes short ("#7") under 380 px wide when the time column is there: at 360 px the long form
   left the move's SAN too little room; at 390 it fits.
5. A move made while the reply is still sliding in counts as a turn of 0 ms (the board takes input then, as before).
6. A turn that would start while the page is hidden waits behind the pause cover without counting as a pause.
7. On a 'time' or other miss the review opens at once, as misses already do; the end card (with "Out of time")
   shows for solves only, as before.

## Not done / for the user
- Not tried on a real phone: please play a Clock 3 (KQK or KBNK) on your phone and say how the tap speed felt.
- Not checked in a real desktop Chrome, only headless Chromium and Electron.
- The coordinator's HANDOFF.md is not edited; the release order is above.
- `packaging/build/puzzles.json` (copied for Electron) and data/ links are untracked in the worktree, not committed.
