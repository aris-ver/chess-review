# Phase 4 spec: KBBK and KBNK

Branch claude/instinct-p4 (from main 4041ac5). Product rules: docs/training-grounds.md (Levels, Start positions).
Earlier specs: p1-spec.md (tables, index, byte format; prototype timings KBBK 44 s, KBNK 73 s), p2-spec.md (record,
progression), p3-spec.md (routes, page).

## Tables
- js/core/endgame-table.js: 'KBBK' and 'KBNK' in ENDING_NAMES. Pawnless 4-piece index as KQRK. Captures: a bishop or
  knight taken leaves KBK / KNK, a draw (insufficient material), so no sub tables. Byte format unchanged (max 33 fits).
- scripts/build_endgame_tables.js: both in NAMES, kbbk.bin, kbnk.bin, gzip like the others; lichess spot check
  covers them. Report measured build time and gzipped size; if either .bin is over ~1.5 MB, say so before going on
  (it is downloaded lazily on the web on first use of that ending).
- Tests: maxima 19 (KBBK) and 33 (KBNK) on white-to-move entries, counts stable. Generating them is too slow for
  `npm test` (tens of seconds): assert on data/endgames files when present, skip otherwise, as the phase 3 real-table
  test does. Keep a fast test of the KBBK/KBNK move generation and index round trip on a few positions.
- CI: the cold build grows by about 2 minutes. Cache data/endgames in the GitHub workflow(s) that build (actions/cache
  keyed on the ensureTables stamp inputs: endgame-table.js, build_endgame_tables.js). Do not commit the .bin files.

## Drills (js/core/drills.js)
- ENDINGS order (v1 then v1.1, as training-grounds.md lists them): KQRK, KRRK, KQK, KRK, KPK, KPK-hold, KBBK, KBNK.
  Records are keyed by name, so existing ones are unaffected.
- LEVELS (start DTM band, slack, counter):
  KBBK: L1 6-10 +12 shown, L2 10-13 +9 shown, L3 12-16 +6 hidden, L4 15-18 +4 hidden, L5 17-19 +3 hidden.
  KBNK: L1 8-12 +15 shown, king already in a corner of the bishop's colour; L2 12-18 +10 shown, king in or by a wrong
  corner; L3 18-24 +8; L4 24-30 +6; L5 28-33 +4 (all hidden). Budget stays under the 50-move rule at every level.
- Start positions: KBBK only bishops on opposite colours (same-colour pairs are draws; also never deal them).
  KBNK buckets by the black king's distance to the nearest right corner (bishop's colour) vs wrong corner, on top of
  or instead of the zone buckets; L1 and L2 constrain as above. Every other rule unchanged (band, white to move,
  black not in check, last 50 never again, random symmetry). Check pickStart speed on the 5.2M tables (first deal
  must stay well under 300 ms in Node; rejection sampling as before).
- Fails, defender, review, kinds of move: unchanged; the 50-move rule matters more here, make sure it is graded.
- js/server/drills.js tablesFor and parseAttempt accept both; worker store / sync need no change (ending is data).
  Check that the Worker or any validation list of endings does not reject the new names.

## Builds and page
- build_web.js and js/desktop/build.js pick the new files up through ensureTables/NAMES; confirm both ship
  endgames/kbbk.bin, kbnk.bin (names pass the ad-block rule).
- index.html: two more ending cards ("Two bishops", "Bishop and knight"), nothing else should be needed. Check the
  cards grid at 390 px with eight cards.

## Done
npm test and worker vitest green; real tables built; in the web build (and Electron if cheap) one KBBK and one KBNK
drill dealt at L1 and played to mate with the table's best moves, one L5 KBNK deal; cards show both. Hand-over and
screenshots in the coordinator's side-session-notes folder.
