# State

Objective: build "Develop your instinct" (endgame drills) per docs/training-grounds.md, phase by phase.

Pipeline: Fable plans and checks, Opus builds in a worktree (claude/instinct-p<N>), merge to main on Fable's
"VERDICT: OK". No push without the user's go-ahead (a push deploys blundr.gr).

## Progress

- 2026-11-16: plan written and decided (docs/training-grounds.md).
- 2026-11-16: phase 1 spec done (worktree .coordination/p1-spec.md, branch claude/instinct-p1). Built as e78b236; Fable
  VERDICT: OK (17k positions cross-checked, 0 mismatches). Fix round 35ed298 (Fable OK), merged to main, npm test 281 pass 0 fail. Fix round covered: rejection sampling for first deals
  (enumeration cost 0.6-1.2 s in Node, too slow on phones), KPK attack status, KPK split into 'KPK' and 'KPK-hold'.

## Next

1. Phase 1: tables (KQK, KRK, KPK runtime; KQRK, KRRK offline), drills.js, tests.
2. Phase 2: storage, sync, routes, progression.
3. Phase 3: page tab, board, counter, review.
4. Phase 4: KBBK, KBNK.
5. Phase 5 (v2): rook endings.
