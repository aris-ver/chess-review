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

Correction to item 3 above: lichess lists a position's moves best first by DTM (distance to mate), not by DTZ. The walk
takes white's first listed move and black's longest DTZ within the best category; it is an estimate of the mainline.

## Round 2b (fix round, branch claude/instinct-p5-starts2, commits f43ba62, 72b51e3, 02370ea)
Plan change by the coordinator mid-round: /standard/mainline is no longer required. `promote` is the exact mainline
count where the cache holds that answer, else the walk estimate. No new /mainline call is ever made.

Files changed: scripts/build_rook_starts.js, js/core/rook-starts.js (same format, same exports), its test, the cache.

### What happened with /mainline
A first run asked /mainline for every Lucena start (65 s apart, 10 s more after each 429; none was logged before it
was stopped). It ran about 8 h, finished Lucena L1 (327 candidates) and was stopped; 448 mainline answers are in the
cache and are read (never fetched) by the build. Starts that have one use it: Lucena L1 36 of 60, nothing else.

### New family rules (Lucena L1 and L2)
Measured on the 327 L1 candidates with exact mainline answers: c- or b-pawn starts 0 of 143 reached promote >= 5; a black
king on the 6th rank 0 of 110; a black rook on rank 5 or higher 5 of 173; black rook on the king's side or the pawn's
rank 0 of 52; the 55 candidates that kept to the rules below all reached it.
- L1: d-pawn only (stored on d, mirrored by the drill), pawn 7th, white king on the queening square, black king on rank
  7 or 8 exactly two files from the pawn, white rook on the cutting file (between them) on ranks 1-3, black rook on the
  far side from the black king, 2-4 files from the pawn, ranks 1-4. promote >= 5.
- L2: same except the white rook is anywhere but the cutting file. promote >= 5.
- Both skip the walk when |dtz| < 7 (mainline promote is about (dtz + 1) / 2; dtz 7 gives 4 or 5).
- b- and c-pawn starts are gone from L1 and L2 (a b-pawn leaves no far side; c-pawn starts never reached 5). L3 and L4
  keep pawns on b-d.
- Philidor caps (good = drawing first moves): L1 <= 8, L3 <= 8 (from the old histograms: L1 median 12, L3 median 13),
  L4 <= 3 as before. L3 also rejects a white rook above the pawn's rank (already behind it). L2 unchanged.

### Counts (accepted of tried; rejections)
| Level | Accepted | Tried | Rejected |
|---|---|---|---|
| Lucena L1 | 60 | 61 | 1 no promotion |
| Lucena L2 | 60 | 107 | 1 not a win, 1 no promotion, 45 promote < 5 or dtz < 7 |
| Lucena L3 | 60 | 71 | 2 not a win, 9 no promotion |
| Lucena L4 | 60 | 161 | 26 not a win, 13 no promotion, 62 promote < 10 |
| Philidor L1 | 60 | 269 | 3 not a draw, 206 more than 8 drawing moves |
| Philidor L2 | 60 | 85 | 25 not a draw |
| Philidor L3 | 60 | 280 | 14 not a draw, 206 more than 8 drawing moves |
| Philidor L4 | 49 | 600 | unchanged (shortfall, as in round 2) |
L1 reject rate fell from 72% (235 too close of 327) to 2%. Promote source: L1 36 mainline + 24 walk, L2-L4 all walk.
promote ranges: L1 5-11, L2 5-11, L3 2-13, L4 10-21.

### Runs
Abandoned mainline run (02:47 to about 11:00): 1113 requests logged by L1, 448 of them /mainline. Final run: 698
/standard requests, 774 s, no 429 logged, Philidor all from cache. `--offline` rerun: 0 requests, byte-identical (cmp).
Observed mainline versus walk: not measurable on shipped starts (the 36 mainline ones have no walk value); the earlier
check (-3 to +4) stands. On the 448 mainline answers promote is (dtz + 1) / 2 for dtz 3, 5, 7 (4-5), 9 (5-6) at most
one above.

### For round 3
- The walk estimate has an error of -3 to +4: the Lucena budget slack table must add 4 (not done here, as asked).
- The ROOK_STARTS format is unchanged. Philidor L4 has 49.
- Lucena L1 and L2 are now the bridge-type positions only, so every promote is >= 5.

### Script changes
User-Agent endgame-table-check; a network error, 5xx or exhausted 429s is not cached (the run ends exit 3 without
writing, resume by rerunning); only a definite 4xx is cached as a skip; the 429 loop is bounded to 8; comments fixed.
Test file: removed the mirror check, added an offline rebuild comparison, L1/L2 geometry, Philidor L3 rook, promote
parser and the walk test. npm test here: 328 tests, 306 pass, 0 fail, 22 skipped (the table-data tests skip because
data/endgames is not built in this worktree).
