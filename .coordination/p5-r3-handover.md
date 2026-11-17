# Phase 5 round 3 hand-over: drill logic, opponent, routes, record

Branch `claude/instinct-p5-logic` (worktree `.claude/worktrees/instinct-p5-logic`), from main cc15e01. Not pushed, not
merged. Round 2b's files (build_rook_starts.js, rook-starts.js, its test, the cache) are untouched; nothing here
depends on rook-starts.js's contents beyond its format, so 2b's new starts drop in.

## Files
- `js/core/rook-drills.js` (new, pure): ROOK_ENDINGS, ROOK_TABLES, ROOK_SLACK [8, 6, 5, 4], OPPONENT_NODES 200,000,
  POST_PROMO 10, HOLD_ROOK 30, RECENT_ROOK 30, ROOK_RESULTS (the spec's lists). `rookStart(fen)` finds a start as
  stored or mirrored, key `Lucena:<level>:<index>`; `rookBudget` = promote + slack (Philidor null); `chooseStart` /
  `pickRookStart` (never one of the last 30 at that level, else the one dealt longest ago; mirrored at random);
  `rookStatus(tables, ending, {fens, budget})` grades steps 1-3 and 5-7; `rookTurn(tables, ending, {fens, ucis,
  budget}, engine)` grades, asks the engine, applies step 4, plays and grades the reply.
- `js/core/drills.js`: ENDINGS gains 'Lucena', 'Philidor' after KBNK; LEVELS rows {lo: null, hi: null, slack,
  counter: false}, 4 each; positionKey falls back to the rook key; pickStart dispatches to pickRookStart.
- `js/server/drills.js`: RESULTS for both; parseAttempt (fen a start of that level or its mirror, dtm null, Lucena
  budget must equal promote + slack, Philidor null, worst_loss null); tablesFor = the seven tables; nextDrill (mode
  'lucena' | 'philidor', dtm null, budget, counter false, hold_moves 30 for Philidor, new `post_promo` 10 for
  Lucena, null elsewhere); parseMove (fens[0] a start of the level, replay, now also returns `ucis`);
  `playRookMove(tables, req, engine)`; parseLine refuses rook endings (400).
- `js/server/drill-opponent.js` (new): `bestOf(info lines)`, `opponent(pool)` (MultiPV 1, the history, retries at
  100k then 20k nodes as explore.js, else EngineFailed).
- `js/server/routes-drills.js`: availability, the rook move, 503s (below).
- Engines: `search(fen, nodes, multipv, moves)` in js/desktop/engines.js and web/engines.js sends
  `position fen <start> moves ...`; typedef in js/core/engine.js.
- `js/desktop/main.js`: `drillEngine = new EnginePool({size: 1, path: STOCKFISH, hash: 16})`, in env only when the
  Stockfish file exists, reaped and closed with the analysis pool.
- `js/web/worker.js`, `js/web/app.js`: desktop browsers get a one-engine full-net pool (Hash 16) that loads after the
  analysis pool (so the 99 MB is never fetched twice at once; then it comes from Cache Storage). Phones (the lite
  worker) get none and `drillEngineUnavailable: 'needs_computer'`.
- `scripts/check_rook_drills.js` (new, dev only): tablebase-best white against the real opponent, and --replay to time
  the recorded replies on another engine. Reads data/tablebase-cache.jsonl, writes only data/rook-check-cache.jsonl.

## Routes and shapes
- GET /api/drills/next?ending=Lucena[&level=N]: {drill: {ending, level, mode: 'lucena', fen, dtm: null, budget,
  counter: false, hold_moves: null, post_promo: 10}, status}. Philidor: mode 'philidor', budget null, hold_moves 30,
  post_promo null. 503 {error, reason} when unavailable.
- POST /api/drills/move {ending, level, fens}: p3's shape with kind, loss, dtm_after, dtm null, plus `promoted`
  (Lucena: the user has promoted; Philidor: black has, so the page can say "take the new queen") and `engine_ms`
  (null when the drill ended on the user's move). With a result: review {moves: [{dtm, kind, loss} all null, one per
  user move], worst: -1}, worst_loss null (round 4's hint replaces this). Step 4 ending: result 'promoted', reply,
  reply_san and fen null.
- GET /api/drills/status: every status gains `unavailable`: null, or for the rook endings 'needs_computer' (phones) or
  'no_engine' (no drill engine in env). All ten endings listed.
- 503 reasons: 'needs_computer', 'no_engine' (next and move), 'engine_failed' (move: every retry failed).
- POST /api/drills/attempt: schema 5 unchanged; dtm null, budget as above, worst_loss null.

## Measured (WSL, native Stockfish 19 from bin/, Node 22.23.4)
Tablebase-best white (lichess's first listed move) against the drill opponent at 200k nodes with the history, graded by
rookStatus/rookTurn. Lucena 20 starts per level (spread over the 60), Philidor 5 per level; 523 lichess requests on
the first run (one at a time, 1.1 s apart, User-Agent endgame-table-check, no 429), cached; the rerun after the fix
needed 1.

| level | games | results | within budget | moves used minus promote (min..max, median) | slack left (min) |
| --- | --- | --- | --- | --- | --- |
| Lucena L1 | 20 | promoted 16, won 4 | 20 | -4..+2, 0 | 6 |
| Lucena L2 | 20 | promoted 12, won 8 | 20 | -7..+4, -1 | 2 |
| Lucena L3 | 20 | promoted 14, won 6 | 20 | -7..+2, -2 | 3 |
| Lucena L4 | 20 | won 11, promoted 9 | 20 | -10..-2, -7 | 6 |
| Philidor L1 | 5 | held 4, pawn_taken 1 | n/a | | |
| Philidor L2 | 5 | pawn_taken 4, held 1 | n/a | | |
| Philidor L3 | 5 | held 5 | n/a | | |
| Philidor L4 | 5 | held 5 | n/a | | |

So the budget is fair against the real opponent: no tablebase-best game ran out, and the opponent mostly defends
worse than the tablebase line `promote` was measured on (median 0 to -7 moves; 'won' = it lost its rook or got
mated). The tight one was L2 with 2 moves of slack left once. Caveat: this is the round 2 start set; round 2b's new
starts should be run again (`node scripts/check_rook_drills.js`, about 5 minutes plus lichess time for new positions).
The first run found a real grading bug (a rook trade offered by the user, black takes, was 'piece_lost' before the
user took back; tablebase play does this), fixed in 5f8273a with tests; the table above is after the fix.

Reply latency (one reply = ucinewgame + 200k nodes with the history):
- Native, desktop process: p50 136-156 ms, p90 163-183 ms per level, max 200 ms (Lucena 357 replies, Philidor 408).
  Engine start (spawn + net) 460-540 ms, paid once by the first reply after start or after the 10-minute reaper.
  Budget 0.5 s: met.
- WASM full net (stockfish-19-single.wasm run by Node, the same build the browser runs), on 383 of the recorded
  replies: Lucena p50 291 / p90 338 / max 407 ms, Philidor p50 302 / p90 342 / max 409 ms, the same move as native in
  383 of 383. Desktop Chrome budget 1 s: met by this proxy; not measured in a real Chrome (no browser automation
  set up here), and Chrome's WASM is usually a little slower than Node's.
- Phones: not measured (no full-net engine on phones this phase, per the user's decision).
OPPONENT_NODES stays at 200,000.

## Tests
`npm test` in this worktree: 338 tests, 336 pass, 0 fail, 2 skipped (start: 324, 322 pass, 2 skipped; the same two
skips as main: ENDGAME_FULL and MIGRATE_DATA). Suite 37 s; the live test takes 10 s. New:
- js/core/rook-drills.test.js: grading table over hand-made sequences for every result in both lists (except
  'abandoned', the page's), each also checked to be null on every earlier ply; budgets before and after a promotion,
  Philidor held at 30; rookTurn with a fake engine (history passed, step 4, an illegal engine move rejected); starts,
  mirrors, the 30-deal rule, chooseStart's oldest-dealt rule. Four cases need data/endgames (KRKR, KQKR) and are
  skipped without it.
- js/server/drills.test.js: rook results, tablesFor, parseAttempt checks, the deal and its repeat rule over 45
  recorded Philidor L4 attempts, and the test that a row of an ending this version doesn't know (plus a Lucena row)
  survives a sync import and export unchanged.
- js/server/routes-drills.test.js: unavailable (no_engine, needs_computer) on next/move/status; a Lucena played to the
  promotion with scripted replies (mate score ends it unplayed), then recorded; crash retries 200k, 100k, 20k; 503
  engine_failed; parseMove refuses another level's start, the other ending's, a non-start; a mirror accepted; the live
  test (3 Lucena L1 starts, Stockfish 1M nodes as the user, all solved), skipped without bin/stockfish or the tables.
- js/desktop/engines.test.js: a search after moves is deterministic and sees the moved position.

## Deviations and decisions
1. Step 4 is checked after every user move while the promoted piece is on, not only right after the promotion (a queen
   rescued a move later still ends it once Stockfish sees mate). POST_PROMO still caps it.
2. Recaptures play on: Philidor K+R v K+P with black to move able to take the rook back, and the user's rook taken in a
   trade the user can take back (both endings). The spec ended these at once ('rook_won', 'piece_lost'), which graded a
   rook trade wrong.
3. Philidor, table says draw while black still has the pawn (KPK after a rook trade): 'held', not 'pawn_taken'.
4. Lucena 4 pieces with no table and no rule (a minor piece against the rook after an under-promotion): 'threw'.
5. Drill objects gain `post_promo`; statuses gain `unavailable`; move answers gain `promoted`, `engine_ms`.
6. The web drill pool loads only after the analysis pool's load, to share the one wasm download.
7. Repetition uses placement + side to move (as the existing drills), not castling/ep (irrelevant here).

## For round 4
- Page: cards for Lucena/Philidor with "needs a computer" from `status.unavailable`; counters from budget/post_promo/
  hold_moves and `promoted`; "Stockfish is thinking" after 300 ms (native replies are ~0.15 s, WASM ~0.3 s, the first
  native one ~0.7 s); end-card text for every result in ROOK_RESULTS; review list has no distance column (all nulls).
- Hint route: drillEngine is the place for phones' fallback but phones have none now; the analysis pool on desktop and
  desktop browsers. `search(fen, nodes, 1, moves)` is ready for it.
- Rerun scripts/check_rook_drills.js on round 2b's starts before ship.
- Known low: the move route trusts client fens for the step-4 mate (it is only re-checked on the move that ends it);
  the web drill engine has no idle reaper (the analysis pool has none on the web either).
