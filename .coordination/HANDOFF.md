# Handoff

Feature: "Develop your instinct" endgame drills. Plan: docs/training-grounds.md. Progress: STATE.md. Decisions:
DECISIONS.md.

## Done
- Phase 1 merged to main (e78b236, 35ed298; not pushed). js/core/endgame-table.js, js/core/drills.js,
  scripts/build_endgame_tables.js and tests. Spec: p1-spec.md. Fable VERDICT: OK twice.
- Tables build into data/endgames/ (gitignored) with `node scripts/build_endgame_tables.js` (~16 s cold).

## Next: phase 2 (storage, sync, routes, progression)
- drill_attempts table in js/server/db.js: {id, ts, ending, level, fen, dtm, budget, moves_used, result, ms,
  worst_loss}; sync like puzzle_attempts (js/server/sync.js).
- js/server/drills.js + routes-drills.js modelled on puzzles.js / routes-puzzles.js: next drill, record attempt,
  level from the record (3 of last 4 solved up, 2 fails in a row down, min 1, star at top level).
- Endings: KQRK, KRRK, KQK, KRK, KPK, KPK-hold. KPK endings: dtm and budget null; worst_loss null on a throw.
- pickStart can return null (documented, never seen): routes must handle it. levelOf() throws RangeError: validate.
- Server-side table loading per ending (web app worker, Electron main), lazily; wiring of .bin files into
  build_web.js / js/desktop/build.js is phase 3 (ensureTables(dir) is exported for it).

## Known low items (tuning later)
- An empty or tiny zone hands its turn to the next one (double share); KQK L5 edge has 3 positions, recur ~every 50.
- KPK only-move count follows one fixed line, approximate.

## How we work
- Fable plans and checks (VERDICT: OK), Opus builds in a worktree made with Windows git
  (`git -c safe.directory=* -C <repo> worktree add -b claude/<name> .claude/worktrees/<name> main`), tests from WSL
  (Node at ~/.nvm/versions/node/v22.23.4/bin), merge to main from WSL with --ff-only. No push without the user.
- The phase 1 worktree .claude/worktrees/instinct-p1 can be removed with Windows git `worktree remove`.
