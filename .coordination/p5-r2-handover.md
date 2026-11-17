# Phase 5 round 2 (start positions): hand-over

Branch claude/instinct-p5-starts. Not pushed, not merged.

## Files
- scripts/build_rook_starts.js: the generator (dev only, never from builds, tests or CI).
- js/core/rook-starts.js: generated, 51.7 KB, `export const ROOK_STARTS = {Lucena: [4 levels], Philidor: [4 levels]}`;
  entry `{fen, family, good, legal, dtz, promote}`; header lists seed, date and counts.
- js/core/rook-starts.test.js: 6 tests (counts per level, legality, white to move, no check, piece sets, no duplicates
  or mirrors, pawn on files b-d, pawn rank per family, good < legal, Lucena good >= 1 and promote >= 1, L4 promote >= 10,
  Philidor L4 good <= 3, the walk helper with a fake tablebase). No network.
- data/tablebase-cache.jsonl: 1.3 MB, committed with `git add -f` (data/ is ignored), so the offline rerun reproduces.
  First line holds the date (2026-11-16); positions are stored compacted.

## Run
5026 requests, 5533 s (92 min), seed 20261116, one request at a time, 1.1 s apart, no 429, no skipped candidate.
`--offline` rerun: 0 requests, output byte-identical (cmp).

## Positions per level (accepted of tried; rejections)
| Family | Accepted | Tried | Rejected |
|---|---|---|---|
| Lucena L1 | 60 | 70 | 10 no promotion |
| Lucena L2 | 60 | 67 | 1 no changing move, 6 no promotion |
| Lucena L3 | 60 | 71 | 2 not a win, 9 no promotion |
| Lucena L4 | 60 | 161 | 26 not a win, 13 no promotion, 62 promote < 10 |
| Philidor L1 | 60 | 61 | 1 not a draw |
| Philidor L2 | 60 | 85 | 25 not a draw |
| Philidor L3 | 60 | 63 | 3 not a draw |
| Philidor L4 | 49 | 600 | 24 not a draw, 2 no changing move, 525 more than 3 drawing moves |

"No promotion" = the best-move line ends (mate or material change) before white promotes. "No changing move" = every
legal white move keeps the result, so the start was dropped (the spec's rule, not loosened).

## Decisions and deviations
1. Philidor L4 is accepted at 49 (cap of 600 candidates reached; "at most 3 drawing moves" is rare when the king stands
   1-2 files off the pawn). No change to the family was made, to avoid more requests; the test expects 49 there. Round 3
   must deal from 49 for that level (the "never one of the last 30" rule still fits). A later change of the family
   (for example white K on rank 1-2 only, rook on far ranks) could fill it, with about 600 more requests.
2. Request gap 1.1 s, not 600 ms (600 ms drew a 429 within a dozen requests).
3. /standard/mainline answers about one call a minute, then 429 (5 hours for 240 calls). `promote` is instead found by
   walking /standard one request per ply: white plays lichess's first listed move, black the longest DTZ among the best
   category. On 7 starts checked against the real mainline it was off by 0 to 2 moves, no bias. So `promote` is an
   estimate of the DTZ-optimal line, +-2; the Lucena budget (promote + slack) is therefore +-2 loose. Exact values would
   need /mainline at one call a minute.
4. Extra pre-filter: white must not be able to take the black rook (Philidor: or the pawn) on the first move.
5. Many Lucena L1 and L2 starts are easy (dtz 3 to 9, promote 2 to 8), not the textbook bridge; the families follow the
   spec's wording. The family rules for squares the spec left open (black king ranks, black rook squares) are mine, in
   the comments of the script.

## Tests
npm test in this worktree: 322 tests, 301 pass, 0 fail, 21 skipped (main: 314 pass, 0 fail, 2 skipped). The extra
skips are the table-data tests, because data/endgames is not built in this worktree; the 6 new tests ran.

## Open items
- Philidor L4 at 49 (above).
- Round 3 must treat Lucena `promote` as an estimate.
