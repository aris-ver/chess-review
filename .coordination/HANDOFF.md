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

- 4041ac5: leaving while the defender's reply is still to be shown records the result it gave, not 'abandoned'
  (checked in the web build with a faked ending reply).
- Phase 4 on main (2218690 tables + CI cache, cffac3e drills + cards, 27966b7 fix round). Spec: p4-spec.md. KBBK and
  KBNK tables (kbbk.bin 381 KB, kbnk.bin 591 KB gzipped; all seven build in ~80 s cold; lichess checks 0 mismatches);
  data/endgames cached in both workflows (key: hash of endgame-table.js + build_endgame_tables.js). Same-colour
  bishops never dealt and refused by parseAttempt. KBNK L1 king within 1 of a right corner; L2 (user's choice) mate
  in 19-24 +10 shown, king in or next to a wrong corner (47,550 positions; none exist in the planned 12-18 band);
  L3-L5 rotate 8 buckets (zone x nearer right/wrong corner). KBBK L2 10-13 +9, L4 15-18 +4. Phone titles show the
  ending name only. Opus checker VERDICT: OK, recheck of 27966b7 VERDICT: OK. Played in web (390x844) and Electron.
  Notes: p4-build-handover.md, p4-shots/ in the coordinator's side-session-notes folder.

## Next: phase 5 (v2, rook endings) or release
- Phase 5 per docs/training-grounds.md "Rook endings (v2)": KQKR table, Lucena/Philidor position script with Syzygy
  checks on the dev machine, outcome grading, Stockfish (full net) as opponent and for the approximate review. Bigger
  than phases 1-4: plan it in its own spec first and ask the user about Syzygy files on the dev machine.
- Release (user's call, nothing pushed): deploy the Worker first. A new client against the old Worker gets 400 on sync
  once it has a drill attempt, which stalls puzzle sync (no data loss). Then the web push, then a desktop build.
- The page sends an `id` with every POST /api/drills/attempt; worst_loss null for 'threw'; KPK dtm and budget null.

## Known low items (tuning later)
- Doc and drills.js:11 say no wrong-corner KBNK start is shorter than mate in 19; strictly there are mate-in-1 and 2
  ones (none 3-18), so the band holds. Wording only.
- The move route trusts the client's black replies (only legality checked), so crafted fens can get 'solved'; the
  attempt route trusts the result anyway (own data only). Crafted KPK-hold input can give a 500 (kpkAttackerMove after
  a black under-promotion, holdLine with a pawn on rank 1); an honest game never reaches it.
- Escape/Back mid-drill counts as a miss without a confirm (per spec).
- Attempt retries are in memory only; closing the tab before the save lands loses the attempt.
- Both builds build missing tables, about 80 s cold with all seven (CI caches them).
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
