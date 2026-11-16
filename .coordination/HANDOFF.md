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

- Phase 3 on main (38aeb9d routes + table wiring, 6bbd5c9 page; cherry-picked from claude/instinct-p3 because main had
  moved and the worktree's line-ending-only vendor_*.sh blocked a rebase). Spec: p3-spec.md. Stateless POST
  /api/drills/move and /api/drills/line on the local server (on the web the tabs' worker), the page loads no tables.
  build_web.js and js/desktop/build.js call ensureTables and ship endgames/*.bin; env.drillTables in web worker and
  Electron main. "Develop your instinct" is a home-page section after Puzzles (the page has no tab bar) opening #/drills.
  Opus checker VERDICT: OK; played to the end in Electron and in the web build at 390x844 by builder and checker.
  Notes and screenshots: p3-build-handover.md, p3-shots/ in the coordinator's side-session-notes folder.

## Next: phase 4 (KBBK, KBNK)
- Tables (4-piece, offline like KQRK), shipping, levels per docs/training-grounds.md (KBNK zone by right/wrong corner,
  budget under the 50-move rule). Cards and page should need only the new endings in ENDINGS.
- Before shipping drills at all: deploy the Worker first. A new client against the old Worker gets 400 on sync once it
  has a drill attempt, which stalls puzzle sync (no data loss). Nothing is pushed yet.
- The page sends an `id` with every POST /api/drills/attempt; worst_loss null for 'threw'; KPK dtm and budget null.

## Known low items (tuning later)
- Leaving in the 350 ms before the reply shows (index.html giveUpDrill) records 'abandoned' even if the reply ended the
  drill. Small, but 'abandoned' is a fail and can move the level down; fix with phase 4.
- The move route trusts the client's black replies (only legality checked), so crafted fens can get 'solved'; the
  attempt route trusts the result anyway (own data only). Crafted KPK-hold input can give a 500 (kpkAttackerMove after
  a black under-promotion, holdLine with a pawn on rank 1); an honest game never reaches it.
- Escape/Back mid-drill counts as a miss without a confirm (per spec).
- Attempt retries are in memory only; closing the tab before the save lands loses the attempt.
- Both builds build missing tables, about 12-16 s cold (CI too).
- web build needs data/book; a fresh worktree lacks it (symlink from main for checks).
- An empty or tiny zone hands its turn to the next one (double share); KQK L5 edge has 3 positions, recur ~every 50.
- KPK only-move count follows one fixed line, approximate.
- Export files drill_attempts.jsonl under `puzzle_progress`; guest-data count label "puzzle_records" includes drills.
- A dealt but unplayed position can be dealt again (repeat guard uses recorded attempts only).

## How we work
- Opus plans and checks (checker must end "VERDICT: OK"); no Fable, it burns the user's limits. Routine builds may use
  Sonnet, harder ones Opus. Check usage (get_usage) before each agent.
- Builder works in a worktree made with Windows git
  (`git -c safe.directory=* -C <repo> worktree add -b claude/<name> .claude/worktrees/<name> main`), tests from WSL
  (Node at ~/.nvm/versions/node/v22.23.4/bin), merge to main from WSL with --ff-only (or cherry-pick when main moved).
  No push without the user. Copy data/endgames into a new worktree from an old one to skip the cold build.
- Worktrees .claude/worktrees/instinct-p1, p2, p3 are merged and can be removed with Windows git `worktree remove`
  (p3 has node_modules with Electron 44.9.3, borrow it for Electron checks first; all show vendor_*.sh as modified,
  line endings only).
