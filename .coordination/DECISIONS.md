# Decisions

Product decisions are in docs/training-grounds.md ("Decided"). Coordination decisions:

- 2026-11-16: .coordination/ is committed (user's choice).
- 2026-11-16: all five tables ship as gzipped white-to-move-only .bin (about 350 KB), built at build time into
  data/endgames/, not committed. Building 3-piece ones on a phone was too slow (0.2-0.8 s on desktop).
- 2026-11-16: start positions by rejection sampling, not enumeration (first deal was 0.6-1.2 s in Node).
- 2026-11-16: KPK attack and defence are separate endings ('KPK', 'KPK-hold') with separate levels.
- 2026-11-16: worktrees are made with Windows git (`-c safe.directory=*`); the Agent tool's worktree isolation fails
  on this repo's UNC path.
- 2026-11-16: phase 2 skipped the separate planner and built with Sonnet to save usage; checking kept.
- 2026-11-16: planning and checking moved from Fable to Opus (user: Fable burns the limits).
- 2026-11-16: drill sync file is gated by its own client flag `drills`, not own_puzzles, so v1.0.x clients that send
  own_puzzles still never see it (they would otherwise remove every line).
- 2026-11-16: star = a solved attempt counted at the current level when that level is the top one, sticky
  (docs/training-grounds.md "when its top level is reached"); practice solves via ?level=N do not earn it.
- 2026-11-16: the drill's moves, status and review go through stateless server routes (POST /api/drills/move, /line);
  the page loads no tables. Rejected: shipping .bin to the page (second loader, UI-thread parse, logic twice).
- 2026-11-16: "Develop your instinct" is a home-page section after Puzzles opening #/drills: the page has no tab bar,
  Puzzles is reached the same way.
- 2026-11-16: KBNK L2 is mate in 19-24, +10, counter shown, king in or next to a wrong corner (user's choice): the
  planned 12-18 band holds no wrong-corner start. Rejected: keeping 12-18 with the king two squares off the corner.
- 2026-11-16: the .bin tables stay uncommitted; CI caches data/endgames keyed on the generator's hash (+2 min cold).
- 2026-11-16: phase 5 start positions are verified with the lichess tablebase API by a dev script and the verified list is
  committed; builds and runtime never call the API (user's choice). Rejected: local Syzygy files (setup, new dependency).
- 2026-11-16: phase 5 (user): Lucena graded solved once Stockfish sees mate after promotion, tables below 5 pieces
  (KQKR and KRKR); rook drills on computers only for now, phones show "needs a computer"; 4 levels; titles Lucena and
  Philidor. Rejected: playing Q+R vs R out to mate; the lite net or a 99 MB phone download this phase.
- 2026-11-17: round 2b drops /standard/mainline (one call a minute made the run 8 h+): promote is the /standard walk
  estimate (cached mainline answers used where present) and the Lucena slack gets +4 to cover its error (user's
  choice). Round 3 showed the real opponent leaves 2-6 moves spare. Rejected: local Syzygy files (setup).
