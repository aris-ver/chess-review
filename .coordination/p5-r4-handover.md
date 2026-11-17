# Phase 5 round 4 hand-over: review hint and page

Branch `claude/instinct-p5-page` (worktree `.claude/worktrees/instinct-p5-page`), from main 5202e38. Not pushed, not
merged. Round 2b's files (rook-starts.js, build_rook_starts.js, its test, the tablebase cache) are untouched.

## Files
- `js/core/rook-hint.js` (new, pure): REVIEW_NODES 400,000, HINT_MOVES 20, HINT_FALL 100, HINT_CLAMP 1000, HINT_WON
  500, HINT_PV 8; `whiteScore(turn, {cp, mate})` (white's view, clamped), `likelyMove(moves)`, `namedHint(ending,
  {before, uci, after, reply})` → 'pawn_hanging' | 'rook_cut' | 'king_shelter' (Lucena), 'king_path' | 'rook_third'
  | 'rook_behind' (Philidor) | null.
- `js/core/rook-drills.js`: `EngineFailed` lives here now (drill-opponent.js re-exports it); an illegal engine move
  throws it, so the move route answers 503 engine_failed, not 500. `tableScore(tables, fen)` for 4 pieces or fewer.
- `js/server/drill-opponent.js`: `bestOf` also returns the `pv`; `scorer(pool, {nodes})` for the hint (crash retries
  at 100k, 20k as the opponent; null when all fail).
- `js/server/drills.js`: `parseMove(tables, b, {anyEnd})`: a rook start's fields after the placement (halfmove clock,
  move number, castling, ep) come from the stored entry, not the client; `anyEnd` lets the fens end after a reply.
  `rookHint(tables, req, search)`.
- `js/server/routes-drills.js`: POST /api/drills/hint.
- `chess_review/static/index.html` (both apps): the two cards, counters, "Stockfish is thinking", reply delay, end
  cards, review with the hint, the engine's line; give-up and record send worst_loss null for rook drills (the server
  refused -1 before: an abandoned rook drill would not have been recorded).
- `docs/training-grounds.md` "Rook endings (v2)": rewritten to what was built.
- Tests: `js/core/rook-hint.test.js` (new), `js/core/rook-drills.test.js` (illegal move is an EngineFailed),
  `js/server/routes-drills.test.js` (counters fix, illegal move 503, hint route x3).

## The hint route
POST /api/drills/hint {ending, level, fens} (fens: the whole attempt from the start, ending after the user's move or
after a reply) → `{moves: [{ply, score_before, score_after, pv, line}], likely, pv, line, hint, approximate: true,
ms}`. ply = 2k for the user's k-th move; scores white's view clamped to +-1000; pv UCI (8 plies max) from the
position before that move, `line` the same as [{uci, san, fen}] (for the page, as /line gives them); top-level
pv/line are likely's. Searches every white-to-move position of the last 20 user moves (start and after each reply)
plus, when the attempt ended on the user's move, the position after it (black to move, sign flipped), all at once on
`router.pool` (the analysis pool: native pool on desktop, full-net WASM pool on desktop browsers), MultiPV 1, with
the game's history. Finished positions (mate, stalemate, 4 pieces with a table) are scored without a search. 400 for
non-rook endings, 503 needs_computer/no_engine as the move route, 503 engine_failed when no search answered.

## Played (fresh CHESS_REVIEW_DATA, white's moves from Stockfish at 1M nodes, or random for the fails)
Electron 44.9.3 (instinct-p3's binary, CDP + Playwright 1.62.1 from the npx cache), native Stockfish:
- Lucena L1 'promoted' in 4 (first run), 'won' in 3 (second run); Lucena L1 fail 'threw' in 7 (random play,
  under-promoted f8=N): hint "Probably here: move 4, f8=N+" (generic line), engine line played.
- Philidor L1 held by taking the pawn ('pawn_taken', 7 moves); Philidor L1 fail 'piece_lost' (9 moves): "Probably
  here: move 6, Kf1. The king left the pawn's path."
- Lucena given up after one move: recorded 'abandoned' (status played 2 → 3), hint 857 ms, no console warnings.
Web build (`node scripts/build_web.js --serve`), headless Chromium:
- 390x844 with an Android UA (the shim's lite worker): both cards "NEEDS A COMPUTER", a tap shows the toast and stays
  on #/drills; grid 374 px wide, no horizontal scroll (scrollWidth 390).
- 1440x900: Lucena L1 'promoted' in 3, Lucena L1 fail 'threw' (hint: move 2, Rb7, generic), Philidor L1
  'pawn_taken' in 13, Philidor L1 fail 'mated' in 4 (hint: move 3, Ke1, "The king left the pawn's path"). A second
  Lucena run showed "Stockfish is thinking" on the first reply (3.5 s: the engine loading) in the coach and the box.
Page errors: none; only the local server's 404s for account/me and account/tally (no Worker locally).

## Timings
- Replies, Electron native: p50 154-180 ms, p90 ≤ 205 ms after the first; first reply 487-533 ms (engine start).
  Web (headless Chrome, full-net WASM): p50 292-333 ms, max 387 ms after the first; first 3.5-6 s (engine load).
- Hint, native (WSL, 6-engine analysis pool, 12 threads): 0.4 s (2 moves) to 1.3 s (12 moves); in Electron
  0.43-0.91 s for 3-9 moves. Bench over 6 careless attempts: 1336, 519, 976, 1328, 377, 1227 ms.
- Hint, web desktop (headless Chromium): 0.68-0.85 s for 2-4 moves, 2.7 s for 13 moves. Phones: none (no engine).

## Screenshots
`C:\Users\arisg\AppData\Local\Temp\claude\26cbd1afae6244c7\d7c933dd-2b78-4697-ba35-68a3d4347535\scratchpad\p5r4-shots\`:
cdp-cards-rook, cdp-lucena-win-playing (counter), cdp-lucena-win-end, cdp-lucena-fail-review,
cdp-philidor-hold-end, cdp-philidor-fail-review, cdp-philidor-fail-engine-line, cdp-lucena-giveup, phone-cards-rook,
phone-rook-tap, web-cards-rook, web-thinking, web-lucena-fail-review, web-philidor-hold-review,
web-philidor-fail-review (all .png; the full set is in WSL /tmp/p5r4shots).

## Tests
`npm test`: 347 tests, 345 pass, 0 fail, 2 skipped (main: 338, 336, 2; the same two skips). Worker vitest not run:
nothing under worker/ changed.

## Deviations
1. **Falls are measured between scores held to +-500**, not raw cp. With mates clamped to 1000, a solved Lucena was
   marked "probably here" at a slower winning move (1000 → 841). Held at 500, a win kept is no fall; real mistakes
   (+650 → 0, 0 → -500) still are. Raw scores (clamped to 1000) are still what the route returns.
2. The response adds `line` (SAN and positions, top level and per move) and `ms`; the page uses `line`, and "The
   engine's line from here" works from any scored move, not only the likely one.
3. Scored: the last 20 user moves (so up to 21 searches), not 20 positions.
4. The hint is fetched when the review opens (at once on a fail, on "Review your moves" after a solve), not at the
   end of every attempt, to keep the analysis pool free when nobody looks.
5. No 99 MB download prompt on phones (the user's decision): the cards say "Needs a computer" and a tap explains.
6. Under-promotions are named ("Keep the new knight", "The new knight was lost"); the page queens by default.
7. Named hints are simple geometric rules (rook_cut: a rook move off a file strictly between the black king and the
   pawn; king_shelter: a king move from in front of the pawn to its rank or below while the rook isn't on the 4th or
   5th rank, followed by a check (or no reply); pawn_hanging: black can take the pawn and white can't take back, or
   did; Philidor king_path: a king move off the pawn's file from in front of it; rook_third: a rook move off the 3rd
   rank before the pawn reached it; rook_behind: pawn on the 3rd rank or lower and the rook below the 6th rank after
   the move). Each is unit-tested on a hand-made position with a near miss beside it.

## Open items
- Rerun `scripts/check_rook_drills.js` on round 2b's starts before ship (round 3's note).
- Round 3's low items not taken here: Philidor 'pawn_taken' a move early; bestOf reads the last info line; no Cache
  Storage means a second 99 MB download; no idle reaper for the web drill engine.
- The hint shares the analysis pool: during a running review job it queues behind it (not measured).
- On the first move of a drill the box still shows "Skip" and the pre-move count while the reply is out (as the
  other drills do).
- Not played on a real phone or in a real desktop Chrome (headless Chromium only).
