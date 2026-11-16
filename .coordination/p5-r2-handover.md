# Phase 5 round 2 (start positions): state, paused for usage

Branch claude/instinct-p5-starts, worktree .claude/worktrees/instinct-p5-starts.

## Done
- scripts/build_rook_starts.js committed (3e74666, 4699073). Families L1 to L4 per ending as in the spec, seed 20261116,
  cache data/tablebase-cache.jsonl (first line holds the date), `--offline` reads only the cache.
- js/core/rook-starts.test.js written (counts, legality, white to move, mirrors, pawn on b-d, verified flags, walk helper).
  NOT committed yet: it imports js/core/rook-starts.js, which does not exist until the run ends, so npm test would fail.

## Running (background, WSL, log /tmp/rs-run.log, cache data/tablebase-cache.jsonl)
`node scripts/build_rook_starts.js > /tmp/rs-run.log`. At 23:08 UTC: Lucena L1 60 of 70 tried (10 no promotion), L2 60 of 67
(1 no changing move, 6 no promotion), 1130 requests, about 48 requests a minute, no 429. L3, L4 and Philidor still to go.
The run resumes from the cache if it is killed: rerun the same command. Output is only written at the very end.

## Deviations from the spec (tell the coordinator)
1. Request gap 1.1 s, not 600 ms: 600 ms drew a 429 within a dozen requests.
2. `/standard/mainline` is limited to about one call a minute (two answers, then 429 at a 3 s gap): 240 calls would take
   about 5 hours. Instead `promote` is found by walking /standard one request per ply: white plays lichess's first listed
   move, black the longest DTZ among the best category. Checked against the real mainline on 7 starts: off by 0 to 2
   moves, not biased (+1, +2, +1, -1, 0, 0, -1). So `promote` is an estimate; if exact values are wanted, only
   /mainline can give them.
3. Cache holds positions compacted (category, dtz, moves as `uci:code:dtz`), not the raw body.
4. Extra pre-filter before asking lichess: white must not be able to take the black rook (or, Philidor, the pawn) at once.
5. Black K ranks and some unspecified squares in the families are my choices (see comments in the script).

## Left
1. Wait for the run to end (expected about 1 hour more in total), check for `SHORT` lines in /tmp/rs-run.log.
2. `node scripts/build_rook_starts.js --offline --out /tmp/check.js` and `cmp` with js/core/rook-starts.js (byte-identical).
3. Check cache size; commit data/tablebase-cache.jsonl (git add -f, data/ is ignored) only if under 5 MB, else leave ignored and say so.
4. Commit rook-starts.js, then the test; run `npm test` (main: 314 pass, 0 fail, 2 skipped).
5. Update this file with final counts per family, rejections, request count and run time.
