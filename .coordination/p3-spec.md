# Phase 3 spec: the "Develop your instinct" tab

Branch claude/instinct-p3 (from e1c6c13). Product rules: docs/training-grounds.md. Storage and routes: p2-spec.md.

## Decision: the move route lives on the server (2026-11-16)
The page never loads tables. On the web the "server" is the tabs' worker in the same browser (js/web/worker.js runs
the router), on desktop it is 127.0.0.1, so a round trip per move costs a few ms, not a network hop. One copy of the
rules (js/core/drills.js), no .bin download on the page thread, the page stays a thin client like the puzzles.
Rejected: shipping tables to the page (a second loader, 350 KB parsed on the UI thread, drill logic duplicated).

## New routes (js/server/routes-drills.js, stateless)
- POST /api/drills/move {ending, fens} -> fens = every position from the dealt fen up to and including the user's last
  move (user is white; the server checks fens[0] is a start of that ending, each step one legal move, the side to move
  alternates, white moved last; 400 otherwise, cap length ~300). Answer:
  `{kind, dtm_after, reply: uci|null, fen: after the reply|null, dtm: mate distance after the reply (null on KPK
  modes or when the counter is hidden is fine to still send; the page decides display), result: null|<result>,
  review: null|{moves, worst}, worst_loss}`. result uses the p2 result names; when the user's move ends the drill
  (mate, stalemate, piece lost, repetition, fifty, budget, KPK threw/promoted/held/pawn_taken...) there is no reply.
  The defender's reply can also end it (checked again after the reply). review and worst_loss are filled when result
  is set (worst_loss null for 'threw', per parseAttempt). Uses defenderMove (mate), kpkAttackerMove (hold),
  status / attackStatus / defenceStatus, review, kindOfMove. Budget and level come from the dealt drill: send
  `level` and `budget` too, or recompute from levelOf; pick one and validate it.
- POST /api/drills/line {ending, fen} -> {line: [uci]} from bestLine, for "Best from here" in the review.
- Tests for both in routes-drills.test.js with generated 3-piece tables, plus one run of nextDrill + move against the
  real KQRK/KRRK tables when data/endgames has them (skip otherwise; HANDOFF low item).

## Tables wiring
- scripts/build_web.js: `ensureTables(<data/endgames>)` then copy the five .bin into the web output (path such as
  `endgames/kqk.bin`; check the ad-block name rule in build_web). js/web/app.js / worker.js: env.drillTables =
  new DrillTables(tablesFromFiles(read, 'endgames')) with read fetching from the site (lazy, first use only).
- js/desktop/build.js: ensureTables, copy into the app.asar stage. js/desktop/main.js (and paths.js for the dev
  checkout, reading data/endgames): env.drillTables from tablesFromFiles over the files on disk.
- Missing tables still answer 503; the page shows a plain message, not a crash.

## Page (chess_review/static/index.html, shared by both apps)
- A top-level tab "Develop your instinct", next to the puzzles' tab, built like it. Phone: check the label fits
  the tab bar; a shorter phone label is allowed (e.g. "Instinct").
- Home: six ending cards in this order: KQRK, KRRK, KQK, KRK, KPK (attack), KPK-hold (defence). Each: a plain name
  ("Queen and rook", ...), level N of top, star when earned, played/solved. From GET /api/drills/status.
- Drill board: reuse the page's existing board/piece/sound code (puzzles). User plays white, board from white's side.
  Header: ending, level, "moves left" (budget - moves_used) on mate drills, "mate in N" only when drill.counter is
  true, hold count on KPK-hold. User move -> POST move -> animate reply. Promotion: queen by default as elsewhere.
- End: POST /api/drills/attempt with a client id (uuid-ish, [A-Za-z0-9_-]), the dealt fields echoed, moves_used, ms,
  result, worst_loss; retry on failure with the same id. Leaving a drill mid-way records 'abandoned' (once).
- Review after every drill (fail: opens itself; solve: a "Review" button plus "Mate in 12, the fastest was 9."):
  the move list with the mate distance after each user move, kinds marked (best/slack/lost/threw), the worst move
  highlighted with a short line ("lost 3 moves here"), stepping through positions on the board, "Best from here" from
  a chosen move (POST line, play it on the board). Then "Next position" (GET next) and "Back to endings".
  Show level changes from the attempt answer (before vs status.level): "Level 3 reached", star earned.
- Own wording and layout; copy neither lichess nor chess.com (see training-grounds Risks).
- Same UI on web and desktop; no web-only code unless the browser forces it.

## Done
npm test and worker vitest green; desktop: the drill playable in Electron (CHESS_REVIEW_DATA temp dir) with one KQK
solve, one fail with review, a KQRK deal, KPK-hold; web: local build served, same checks, phone width 390 px.
Screenshots in the notes folder.
