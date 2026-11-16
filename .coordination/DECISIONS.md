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
