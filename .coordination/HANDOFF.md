# Handoff

Feature: "Develop your instinct" endgame drills. Plan: docs/training-grounds.md. Progress: STATE.md. Decisions:
DECISIONS.md.

## Done
- Phase 1 on main (e78b236, 35ed298): js/core/endgame-table.js, js/core/drills.js, scripts/build_endgame_tables.js.
  Spec: p1-spec.md. Tables build into data/endgames/ (gitignored), `node scripts/build_endgame_tables.js` (~16 s cold).
- Phase 2 on main (76d21a1, 9b367d8; not pushed): drill_attempts (progress.sqlite, schema 5), sync file
  drill_attempts.jsonl gated in the Worker by the client flag `drills`, js/server/drills.js, js/server/routes-drills.js.
  Spec: p2-spec.md (routes, shapes, progression, star rule). Checker VERDICT: OK. npm test 299 pass 0 fail 2 skip on main;
  worker vitest 39/39.

## Next: phase 3 (page tab, board, counter, review)
- Own tab "Develop your instinct" in the shared page (web and desktop, same UI). User plays white; mate counter on easy
  levels; review after each drill.
- Missing piece: the defender's reply, status checks and review need the tables. Decide first: a stateless server route
  (e.g. POST /api/drills/move {ending, fen} -> reply, status, loss) using env.drillTables, or ship .bin to the client.
  Server route is the simpler fit (tables already lazy on env); the client must then round-trip per move.
- Wire the .bin files into build_web.js and js/desktop/build.js (ensureTables(dir) is exported) and pass a DrillTables
  built with tablesFromFiles into env.drillTables in the web worker and Electron main. Without it routes answer 503.
- The page must send an `id` with every POST /api/drills/attempt (retries are then idempotent) and echo the dealt fields;
  worst_loss null for 'threw'; KPK endings dtm and budget null.
- Release order: deploy the Worker before shipping a desktop build with drills. A new client against the old Worker gets
  400 on sync once it has a drill attempt, which stalls puzzle sync (no data loss).

## Known low items (tuning later)
- An empty or tiny zone hands its turn to the next one (double share); KQK L5 edge has 3 positions, recur ~every 50.
- KPK only-move count follows one fixed line, approximate.
- KQRK/KRRK deal path tested only with a fake table; run it once against the real 4-piece tables in phase 3.
- Export files drill_attempts.jsonl under `puzzle_progress`; guest-data count label "puzzle_records" includes drills.
- A dealt but unplayed position can be dealt again (repeat guard uses recorded attempts only).

## How we work
- Opus plans and checks (checker must end "VERDICT: OK"); no Fable, it burns the user's limits. Routine builds may use
  Sonnet, harder ones Opus. Check usage (get_usage) before each agent.
- Builder works in a worktree made with Windows git
  (`git -c safe.directory=* -C <repo> worktree add -b claude/<name> .claude/worktrees/<name> main`), tests from WSL
  (Node at ~/.nvm/versions/node/v22.23.4/bin), merge to main from WSL with --ff-only. No push without the user.
- Worktrees .claude/worktrees/instinct-p1 and instinct-p2 are merged and can be removed with Windows git
  `worktree remove` (instinct-p2 has worker/node_modules from `npm ci`; both show vendor_*.sh as modified, line endings only).
