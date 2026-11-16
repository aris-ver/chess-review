# Decisions

Product decisions are in docs/training-grounds.md ("Decided"). Coordination decisions:

- 2026-11-16: .coordination/ is committed (user's choice).
- 2026-11-16: all five tables ship as gzipped white-to-move-only .bin (about 350 KB), built at build time into
  data/endgames/, not committed. Building 3-piece ones on a phone was too slow (0.2-0.8 s on desktop).
- 2026-11-16: start positions by rejection sampling, not enumeration (first deal was 0.6-1.2 s in Node).
- 2026-11-16: KPK attack and defence are separate endings ('KPK', 'KPK-hold') with separate levels.
- 2026-11-16: worktrees are made with Windows git (`-c safe.directory=*`); the Agent tool's worktree isolation fails
  on this repo's UNC path.
