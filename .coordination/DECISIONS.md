# Decisions

Product decisions are in docs/training-grounds.md ("Decided"). Coordination decisions:

- 2026-11-16: .coordination/ is committed (user's choice).
- 2026-11-16: worktrees are made with Windows git (`-c safe.directory=*`); the Agent tool's worktree isolation fails
  on this repo's UNC path.
