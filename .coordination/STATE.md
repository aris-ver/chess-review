# State

Objective: build "Develop your instinct" (endgame drills) per docs/training-grounds.md, phase by phase.

Pipeline: Opus plans and checks (Fable until phase 2's first review), Sonnet or Opus builds in a worktree (claude/instinct-p<N>), merge to main on Fable's
"VERDICT: OK". No push without the user's go-ahead (a push deploys blundr.gr).

## Progress

- 2026-11-16: plan written and decided (docs/training-grounds.md).
- 2026-11-16: phase 1 spec done (worktree .coordination/p1-spec.md, branch claude/instinct-p1). Built as e78b236; Fable
  VERDICT: OK (17k positions cross-checked, 0 mismatches). Fix round 35ed298 (Fable OK), merged to main, npm test 281 pass 0 fail. Fix round covered: rejection sampling for first deals
  (enumeration cost 0.6-1.2 s in Node, too slow on phones), KPK attack status, KPK split into 'KPK' and 'KPK-hold'.
- 2026-11-16: phase 2 built by Sonnet as 76d21a1 (builder planned itself, p2-spec.md). Fable NOT OK: old clients would
  wipe the drill record via sync, star from a practice solve, null fen crash. Fix round 9b367d8; Opus VERDICT: OK.
  Merged to main, npm test 299 pass 0 fail, worker vitest 39/39.
- 2026-11-16: phase 3 spec p3-spec.md (server move route). Built by Opus on claude/instinct-p3 (be2ca69, 981d29c),
  played in Electron and web by the builder. Paused at the 5-hour limit, resumed after the reset. Opus VERDICT: OK
  (low items only, in HANDOFF). Cherry-picked to main as 38aeb9d, 6bbd5c9.
- 2026-11-16: 'abandoned' race fixed on main (4041ac5). Phase 4 (KBBK, KBNK) spec p4-spec.md, built by Opus on
  claude/instinct-p4 (2218690, cffac3e), Opus VERDICT: OK; user set KBNK L2 to 19-24 in a wrong corner; fix round
  27966b7, Opus recheck VERDICT: OK. Fast-forwarded to main.

## Next

1. Phase 1: tables (KQK, KRK, KPK runtime; KQRK, KRRK offline), drills.js, tests.
2. Phase 2: storage, sync, routes, progression. Done.
3. Phase 3: page tab, board, counter, review.
4. Phase 4: KBBK, KBNK.
5. Phase 5 (v2): rook endings.
- 2026-11-16: released: main pushed (blundr.gr deployed, run 43955323797), desktop v1.1.0 published. Phase 5 spec
  being planned by Opus.
- 2026-11-17: phase 5 round 1 (KQKR, KRKR tables) built by Opus, Opus VERDICT: OK, fast-forwarded to main (7e21cef).
- 2026-11-17: phase 5 round 2 (rook starts) built by Sonnet, Opus VERDICT: OK with pre-ship fixes (round 2b);
  cherry-picked to main (228358f), npm test 321 pass 0 fail 3 skip.
- 2026-11-17: phase 5 round 3 (logic, opponent, routes) built by Opus, Opus VERDICT: OK, fast-forwarded to main.
- 2026-11-17: phase 5 round 4 (page, hint) built by Opus, Opus VERDICT: OK, fast-forwarded to main.
- 2026-11-17: offline web app (service worker web/offline.js, docs/web.md Offline) built by Opus, two fix rounds,
  Opus VERDICT: OK, fast-forwarded to main (7be0f85). Pushed with phase 5 on the user's word; round 2b (starts) not
  in it: its lichess /mainline run (Lucena L2-L4) is still going in instinct-p5-starts2 and ships as its own deploy.
- 2026-11-17: round 2b (textbook Lucena L1/L2, capped Philidor, walk estimate) Opus VERDICT: OK, cherry-picked to
  main; Lucena slack +4 (12, 10, 9, 8, f43d5c1). Fairness on the new starts: 80/80 Lucena within budget, 80/80
  Philidor held or pawn taken; reply p90 under 0.2 s native. Pushed (another session had already pushed rounds 1-4
  with the old starts at 10:51).
