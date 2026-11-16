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

## Now: phase 3 built, check pending (paused 2026-11-16, 5-hour limit at 94%)
- Spec: p3-spec.md. Decided: stateless POST /api/drills/move and /api/drills/line on the local server (on the web that
  is the tabs' worker, so no network hop); the page loads no tables.
- Built by Opus on branch claude/instinct-p3 (worktree .claude/worktrees/instinct-p3), NOT merged, NOT checked:
  be2ca69 routes + table wiring (build_web.js, desktop build.js/main.js/paths.js, web app.js/worker.js), 981d29c page.
- Builder's report (unverified): npm test 307 pass 0 fail 2 skip (bin/ and tests/parity/local symlinked from main),
  worker vitest 39/39 (needs web-dist built first). Played in Electron (temp data dir) and the local web build at
  390x844: KQK solve, fail + review, level up, KQRK/KRRK/KPK wins on real tables, KPK-hold. Screenshots p3-shots/ and
  p3-build-handover.md in the coordinator's side-session-notes folder.
- Builder's choices to check: no tab bar exists, so "Develop your instinct" is a home section after Puzzles opening
  #/drills; level sent to the move route, budget recomputed server side; client fens checked on placement and side to
  move only, the server judges its own replay; 'abandoned' only after a move; line route also returns {uci, san, fen};
  KPK-hold has its own review; attempt retries in memory only (5 tries); both builds build missing tables (~16 s cold).
- Next: Opus checker on main..claude/instinct-p3 (must end "VERDICT: OK": route validation, page wiring, both builds,
  replay one drill in Electron and in the web build), fix round if needed, merge --ff-only from WSL, commit
  .coordination, write the phase 4 handoff. Then remove worktrees instinct-p1/p2/p3 with Windows git.
- The page sends an `id` with every POST /api/drills/attempt; worst_loss null for 'threw'; KPK dtm and budget null.
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
