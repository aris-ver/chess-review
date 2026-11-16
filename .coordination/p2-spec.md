# Phase 2 spec: storage, sync, routes, progression

Branch claude/instinct-p2 (from 31acada). No UI, no build wiring (phase 3).

## Files
- js/server/db.js: DRILL_ATTEMPTS_SCHEMA, SCHEMA_VERSION 5, UPGRADES step 5.
- js/server/sync.js: drill_attempts.jsonl as a virtual file. worker/src/store.js: the Worker accepts the name.
- js/server/drills.js (record, level, deal, table loading), js/server/routes-drills.js, registered in router.js ROUTES.
- Tests: drills.test.js, routes-drills.test.js; fast.test.js asserts schema 5.

## Schema
progress.sqlite `drill_attempts(seq PK autoinc, id TEXT, ts INTEGER, ending TEXT, level INTEGER, fen TEXT, dtm INTEGER,
budget INTEGER, moves_used INTEGER, result TEXT, ms INTEGER, worst_loss INTEGER)`, indexes on ending and id. Made by
UPGRADES step 5 only when the database has puzzle_solved (progress.sqlite), so a new database and an upgraded one have
the same schema. Not in PROGRESS_DDL (that is schema 1, as for own_puzzles). Web D1 side: the Worker's file name check.
Sync: `drill_attempts.jsonl`, one line per attempt, nulls omitted except ms, merged one line per id (tidy oncePer id).

## Results and progression
- Solved: mate drills 'solved'; KPK 'promoted'; KPK-hold 'held', 'pawn_taken', 'stalemate'.
- Failed: mate 'stalemate','piece_lost','repetition','fifty','budget'; KPK 'threw','pawn_lost','stalemate','repetition',
  'fifty'; KPK-hold 'threw','promoted'; every ending 'abandoned'.
- Level from the record, per ending, replayed in seq order, start 1. Only attempts at the current level count. Run =
  last 4 attempts at the current level since arriving. 3 solved in the run: up (not above top). Else last 2 of the run
  failed: down (not below 1). A move clears the run.
- Star: any solved attempt at the top level (LEVELS[ending].length). Sticky; reaching the top alone is not it.
- Edge cases: at level 1 two fails stay at 1; at the top the run keeps sliding and a solve there keeps the star; an
  attempt at a practice level (not the current one) is on the record and moves nothing; unknown-ending rows are ignored.

## drills.js
`attempts(db, ending?)`, `progress(ending, rows)` -> {level, top, star, run}, `status(db, ending)` -> {ending, level,
top, star, played, solved, run, recent[10]}, `statuses(db)`, `parseAttempt(body)` (BadRequest on anything wrong),
`record(db, attempt, now, makeId)` -> {counted, id, before, status} (an id already there is ignored), `tablesFor(ending)`,
`DrillTables(load)` (`get(ending)` -> {name: table}, lazy, cached, retried after a failure), `tablesFromFiles(read, dir)`
(kqk.bin etc, gzipped or not), `nextDrill(db, tables, ending, {level, rng})` -> {drill|null, level, status}.
Validation: ending in ENDINGS (own-property check), level integer in 1..top before levelOf is called, fen parses and is a
start position of that ending (positionKey prefix), result in the ending's list, dtm and budget integers for mate
endings and absent for KPK endings, worst_loss null for 'threw', id (optional) up to 64 of [A-Za-z0-9_-].
Deal: recent = positionKey of the last 50 attempts' fens at that ending; zone turn = attempts so far at the ending.

## Routes (env.drillTables, env.rng; default tables say "not installed")
- GET /api/drills/next?ending=E[&level=N] -> {drill: {ending, level, mode: mate|attack|hold, fen, dtm, budget, counter,
  hold_moves}, status}. 400 bad ending or level, 503 tables missing or unusable, 404 when pickStart gives null.
- POST /api/drills/attempt {ending, level, fen, dtm, budget, moves_used, result, ms, worst_loss, id?} -> {counted, id,
  before, status}. 400 on bad JSON, non-object or any field.
- GET /api/drills/status[?ending=E] -> status, or {endings: [six statuses]}. 400 bad ending.
- Other /api/drills/ paths: 404 {error}.

## Tests
Progression table (3 of 4, sliding window, 2 fails, min 1, cleared run, other-level attempts, top level, star, KPK
results), parseAttempt refusals, record idempotence and order, DrillTables caching and retry, tablesFromFiles, nextDrill
with generated KQK/KRK/KPK (level, no repeats, KPK nulls, null start), schema upgrade 4 to 5 equal to a fresh one on
node:sqlite and SQLite WASM, sync lines, merge, round trip between two stores, routes end to end through the router.
Only generated 3-piece tables are used, so `npm test` needs no data/endgames.
