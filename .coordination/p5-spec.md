# Phase 5 spec: rook endings (Lucena, Philidor)

Branches claude/instinct-p5-r<N> from main (97cd5d5 or later). Product rules: docs/training-grounds.md "Rook endings
(v2)". Earlier specs: p1 (tables, index, byte format), p2 (record, progression, star), p3 (stateless routes, page),
p4 (shipping, CI cache). Four build rounds below; each is checked on its own before the next starts.

## Pushback on the plan (settle with the user before round 3)
1. **"Promote and the queen survives: that's queen against rook, KQKR" is wrong.** In the Lucena white still has its
   rook, so the promotion gives KQR v KR, 5 pieces, which no table of ours covers. KQKR only comes up when a rook
   leaves the board (black takes white's rook after the promotion, or white gave its rook up first). Decision below:
   the opponent's own search after the promotion ends the drill when it reports mate for white; every position that
   drops to 4 pieces or fewer is graded by a table. KQKR is still needed, plus a KRKR table (same generator work).
2. **Phones run the lite engine today** (web/shim.js, js/web/worker.js: the full one per core is more than iOS gives a
   tab). The opponent must be the full net, so on phones the rook drills need one full engine: a 99 MB download and an
   unmeasured memory risk on iOS. See Q2.
3. Levels: 4 per ending, not 5. Each level is a family of setups verified by hand-picked rules; a fifth family adds
   API time and positions without a clearly different skill.

## Round 1: KQKR and KRKR tables

Generator (js/core/endgame-table.js), black gets pieces:
- Names: white's pieces between the two Ks, black's after the second: 'KQKR', 'KRKR'. Existing names (ending in 'K')
  are unchanged. Index: `((tri(wk)*64 + bk)*64 + white...)*64 + black...`, the same 8-fold symmetry; 2.6M entries
  each, like KQRK. No duplicate swapping (the pieces differ by colour).
- Meaning of a byte: N = white mates in N, **0 = white does not win** (a draw, or black wins). Document it at the top.
  "Does black win" is asked by flipping colours and ranks (core flipFen) and probing the flipped position, which only
  works because KRKR is symmetric and KQKR flipped is still KQKR with the queen on white's side.
- generate(): legality now has two halves. White to move: black's king not attacked (else ILLEGAL); white may be in
  check. Black to move: white's king not attacked by the black rook (else ILLEGAL). whiteReaches: white's moves
  include captures of the black rook (KQK or KRK with black to move, via probe on the sub table, as promoPlies does
  now); sliding rays stop on the black rook, the capture square included; a destination marked ILLEGAL is already
  skipped (`v <= L` fails on 255). blackLost: black's moves are king moves plus rook moves (rays, captures); a rook or
  king taking a white piece leaves white unable to win (return false); **a destination W entry of ILLEGAL is skipped,
  not read as "longer than L"** (a pinned rook). Mates and stalemates count rook moves. White with no legal move is
  0 either way (mated or stalemated: not a win).
- DEPENDS: KQKR: ['KQK'], KRKR: ['KRK']. DRAWN gains every material where white has no piece (KKR, KKQ...).
- probe() and blackMoves() handle black rook moves and captures (black-to-move probe stays the one-ply search).
  fromFen() accepts black pieces (name 'K<white>K<black>'; still null for more than 4 pieces). whiteMoves/bestLine for
  the new tables are not needed now (only a later "queen against rook" mate drill would need them).
- Expected: KQKR longest win **35 moves DTM, to be confirmed**: Wikipedia gives 31 moves to win the rook or mate
  (DTC, https://en.wikipedia.org/wiki/Queen_versus_rook_endgame); the 35-move DTM figure has no source I could
  find. The build reports the max and the position; the builder sends that one position to lichess (dtm should be
  69 plies, white to move) and writes the confirmed figure into EXPECT. KRKR max: unknown, confirmed the same way.
  Counts (wins, mates, stalemates) go into EXPECT from the first build once the lichess check passes.
- scripts/build_endgame_tables.js: 'KQKR', 'KRKR' in NAMES, kqkr.bin, krkr.bin. The lichess check's category mapping
  grows: our white-to-move 0 matches lichess draw, loss, blessed-loss, maybe-loss; our win matches win (cursed-win,
  if any, counts as a mismatch to look at); black to move mirrored. Run `--check=400` with at least 100 positions from
  each new table: 0 mismatches.
- Estimates (to measure): KQKR 60 to 150 s in Node (about 70 plies of levels, heavier black moves), KRKR under a
  minute; gzipped KQKR 0.6 to 1.2 MB (broad DTM spread, like KBNK's 591 KB), KRKR 0.1 to 0.3 MB (mostly draws). All
  nine cold: about 3 to 4 minutes. If kqkr.bin is over 1.5 MB, stop and report (fallback: ship it as 0/1 bytes,
  win or not, which is all the grading reads). The CI cache key (generator + build script hash) already covers it.
- Tests: a fast test of the new move generation (pins, rook captures, white in check) on hand-made positions and an
  index round trip; maxima and counts asserted on data/endgames when present, skipped otherwise (as p4).

Done when: npm test green, both tables built and checked against lichess, sizes and times reported.

## Round 2: start positions (independent of round 1, may run alongside it)

`scripts/build_rook_starts.js` (Node, dev only, never from builds, tests or CI) writes `js/core/rook-starts.js`
(committed, generated, "do not edit"; a JS module so both apps get it with js/core and no JSON import is needed; the
name passes the ad-block rule).

- Frame: the user is always white. Lucena: white K+R+P against K+R, the pawn going up. Philidor: white K+R against
  black K+R+P, the pawn going down (as KPK-hold). White to move, nobody in check, legal by core/chess.js. Pawn files
  b to g only (rook pawns are different endings); stored with the pawn on b-d, mirrored left-right at random when
  dealt.
- Candidates: seeded random placements inside each family below, deduplicated by mirror, asked in a fixed order.
  Each family stops at **60 accepted**; at most 600 candidates tried per family, and the script reports a family that
  falls short instead of loosening the rule.
- Lucena families (pawn file p; "cut off" = the black king two or more files from the pawn, the white rook on a file
  between them):
  L1 bridge: P on the 7th, K on the queening square, R on the cutting file on ranks 1-3, black K cut off, black R on
  the other side 2+ files away. Slack +8.
  L2 cut first: P 7th, K on the queening square, black K 2+ files away, white R anywhere not between them. Slack +6.
  L3 sixth: P on the 6th, K on the 7th or 8th within one file of the pawn, black K cut off. Slack +5.
  L4 fifth: P on the 5th, K within one square of the pawn, black K cut off, promotion 10 or more moves away. Slack +4.
- Philidor families (black pawn on file p; ranks as on the board):
  L1 third rank: pawn on rank 4, black K on rank 4-5 within a file of it, white K on the pawn's file (or next to it)
  on rank 1-2, white R on rank 3.
  L2 go behind: pawn on rank 3, black K beside it, white K in its path, white R on ranks 1-3 (the only plan is to get
  behind, to the far ranks, and check).
  L3 in time: pawn on rank 4-5, white R not on rank 3: it has to get there first.
  L4 off the path: pawn on rank 4-5, white K one or two files off the pawn's file, R anywhere; at most 3 drawing moves.
- Kept when lichess says: Lucena category 'win' (not cursed-win or maybe-win); Philidor 'draw' (not blessed-loss: we
  hold 30 moves, not 50). Both: at least one of the user's legal moves changes the result (from the moves array), so
  no start can be played carelessly. Lucena also asks `/standard/mainline` and records the moves to the first
  promotion on it (DTZ-optimal play, close to the fastest; a mainline that never promotes drops the candidate).
- API manners: one request at a time, 600 ms between them, User-Agent 'endgame-table-check' (as the existing check),
  429 waits 60 s, 5xx or a network error retries after 5, 15, 45 s then skips the candidate (reported). Cache:
  `data/tablebase-cache.jsonl` (data/ is gitignored), one line per URL with the body, read first; `--offline` uses
  only the cache and fails on a miss. A rerun with a full cache must produce a byte-identical rook-starts.js (that is
  the check). About 2,000 to 3,000 requests, 30 to 45 minutes once.
- Output shape: `export const ROOK_STARTS = { Lucena: [[entry x60] x4 levels], Philidor: [...] }`, entry
  `{fen, family, good, legal, dtz, promote}` (good: the user's moves that keep the result; promote: Lucena moves to
  promotion, null for Philidor), plus a header comment with seed, date and counts per family.
- Tests: the file's shape, every fen legal and white to move, mirrors not duplicated, pawn on b-d, counts per level.

Done when: the file is committed with 4 x 60 per ending (or the shortfall reported), and an `--offline` rerun
matches it.

## Round 3: drill logic, opponent, routes, record (after rounds 1 and 2)

**Engine.** A dedicated one-engine pool for the drills, `env.drillEngine`, separate from the analysis pool so a
review job never delays a reply: desktop `new EnginePool({size: 1, path: STOCKFISH, hash: 16})` (js/desktop/engines.js,
reaped with the others when idle); web `new EnginePool({size: 1, hash: 16, full script and wasm})` in the leader
worker, made on the first rook drill, **the full net on every device, phones included** (on desktop browsers the
wasm is already in Cache Storage). Threads=1, Hash=16, `ucinewgame` before each search, MultiPV 1, `go nodes
OPPONENT_NODES` = 200,000 to start. Both pools' search() gains an optional `moves` list so the engine gets `position
fen <start> moves ...` and sees repetitions (a defender then aims for them, an attacker avoids them). Same binary,
nodes and history give the same move every time (deterministic, which tests and the review rely on); native and WASM
should agree but nothing depends on it (the desktop's Stockfish is "latest", not pinned to 19).
- Latency budget (p90 of a reply, measured by the builder on 20 starts per ending): desktop native under 0.5 s,
  desktop Chrome under 1 s, phone (Playwright with 4x CPU throttle as the proxy, plus one real phone if the user
  can) under 2.5 s. Over budget: lower OPPONENT_NODES to 120,000 and say so; under 100,000 needs the user.
- No engine (no Stockfish file, wasm failed): the rook routes answer 503, the cards say why.

**Who plays.** Stockfish is always black: the defender in Lucena, the attacker in Philidor.

**Grading** (core/rook-drills.js, pure; the engine is passed in as an async function so tests fake it). After every
ply, in this order:
1. Mate on the board: black mated is 'won' (Lucena) or 'held' (Philidor); white mated is 'mated' (a fail in both). Stalemate: Lucena 'stalemate' (fail), Philidor 'stalemate' (solved).
2. 4 pieces or fewer with a table for that material (KQK, KRK, KPK, KQRK, KRRK, KQKR, KRKR; flipped when black has
   the stronger side): the table decides at once. Lucena: white wins is 'won' (or 'promoted' if a promotion was
   played), otherwise 'pawn_lost' when the pawn is gone and nothing was promoted, else 'threw'. Philidor: black wins
   is 'threw', otherwise 'pawn_taken'.
3. 4 pieces with no table: Lucena K+R+P v K is 'won' unless black is to move and can take the rook (then play on one
   ply); K+P v K+R (white's rook gone) plays on only while the pawn is on the 7th (a promotion then lands in KQKR),
   else 'piece_lost'. Philidor K+R v K+P is 'rook_won'; white's rook gone with black's still on is 'piece_lost'.
4. Lucena, the user just promoted (5 pieces, black to move): the reply search runs as usual; if its score is mate for
   white the drill ends 'promoted' and the reply isn't played. Otherwise play goes on (the queen hangs or is
   skewered; step 2 grades it when it falls) with POST_PROMO = 10 more user moves, after which it's 'budget'. The
   promotion piece is the user's (the page queens by default); the same rule covers a rook.
5. Philidor, black just promoted: the user may take the new piece with the next move (step 2 then grades); after any
   other move, or if no capture exists, 'promoted' (fail).
6. Repetition (threefold) and fifty (halfmove 100): Lucena fails ('repetition', 'fifty'), Philidor 'held'.
7. Lucena budget: user moves >= budget (promote + slack, from the start's entry) before a promotion: 'budget'.
   Philidor: HOLD = 30 user moves: 'held'.
Results: Lucena solved ['promoted', 'won'], failed ['pawn_lost', 'piece_lost', 'threw', 'mated', 'stalemate',
'repetition', 'fifty', 'budget', 'abandoned']. Philidor solved ['held', 'pawn_taken', 'rook_won', 'stalemate'],
failed ['promoted', 'piece_lost', 'threw', 'mated', 'abandoned'].
Known leniency (accepted by outcome grading): a user move that throws the win can still be "solved" when Stockfish
misdefends; the verified start and full-net opponent keep this rare.

**Dealing.** core/drills.js ENDINGS gains 'Lucena', 'Philidor' (after KBNK); LEVELS rows {slack, counter: false}
(4 each). pickStart for them draws from ROOK_STARTS at the level, mirrored at random, never one of the last 30 dealt
(of 60), oldest-dealt when all are recent. Drill object: mode 'lucena' | 'philidor', dtm null, budget (Lucena:
promote + slack; Philidor null), hold_moves 30 for Philidor.

**Routes** (routes-drills.js, still stateless). POST /api/drills/move with the same body: fens[0] must be a
ROOK_STARTS entry of that level (or its mirror), replay as now; answer shape as p3 with kind, loss, dtm_after and
dtm null, plus `promoted` (bool) and `engine_ms`. The reply comes from env.drillEngine with the history since the
start (crash: retry at 100k then 20k nodes, as explore.js). tablesFor('Lucena'/'Philidor') = KQK, KRK, KPK, KQRK,
KRRK, KQKR, KRKR, loaded at deal time (lazily on the web, about 1.5 to 2 MB in all).

**Record.** drill_attempts unchanged (schema 5): ending 'Lucena' | 'Philidor', dtm null, budget (Lucena int, Philidor
null), moves_used, result, ms, worst_loss null always. parseAttempt checks the fen is a start of that level, the
result against the lists above. Progression and the star rule are unchanged (3 of the last 4 up, 2 fails down, star
at the top level). Sync needs no change; the builder confirms with a test that a row of an ending the code doesn't
know survives a sync import and export unchanged (what v1.1.0 clients will do with these rows).

Tests: grading table-driven over hand-made FEN sequences for every result above; fake engine for routes (scripted
replies and mate scores); parseMove refuses a non-start fen; one live test against bin/stockfish when present
(skipped otherwise) that plays three Lucena L1 starts with Stockfish at 1M nodes as the user too (the black replies
differ from the lichess mainline, so scripted moves would not fit), expecting 'promoted' or 'won' each time.

## Round 4: review hint and page (after round 3)

**Hint route** POST /api/drills/hint {ending, level, fens} -> {moves: [{ply, score_before, score_after}], likely:
k | null, pv: [uci] (8 plies from the likely move's position), approximate: true}. It searches every white-to-move
position of the attempt (start and after each reply, last 20 at most) at REVIEW_NODES = 400,000, MultiPV 1, on the
analysis pool when it has the full net (desktop, desktop browsers: in parallel) and on the drill engine on phones.
Scores white's view, mates clamped to +-1000 cp. likely = the user move with the largest fall in score (Lucena:
s_k - s_k+1; Philidor the same, white's view), only if the fall is at least 100 cp; else null ("no single move stands
out"). Cost: desktop native about 1 s, desktop Chrome 3 to 5 s, phone up to about 40 s for a 15-move attempt
(measure; the page shows the move list at once and fills the hint in when it lands).
Named hints, when the likely move matches one (else the generic line):
- Lucena: the rook stopped cutting the black king off; the king left its shelter before the rook was on the 4th
  rank to block checks; the pawn was left hanging.
- Philidor: the rook left the 3rd rank before the pawn reached it; the pawn reached the 3rd rank and the rook didn't
  go to the far end to check from behind; the king left the pawn's path.
Wording: "Probably here: <move>. <hint>. This is an estimate from a deeper engine search, not a tablebase." "The
engine's line from here" plays `pv` on the board like "Best from here".

**Page** (chess_review/static/index.html, both apps):
- Cards 9 and 10: Lucena ("Rook ending: win", "Shelter your king from the checks, then promote. Stockfish defends.")
  and Philidor ("Rook ending: hold", "Keep the king in front and the rook on the third rank. Stockfish attacks.").
  Phone titles: "Lucena", "Philidor". Home tile: "Ten endings". Check the grid at 390 px with ten cards.
- Instead of the mate counter: Lucena "Promote the pawn: N moves left", after a promotion that goes on "Keep the new
  queen: N moves left"; Philidor "Hold the draw: N more moves". While a reply is out for more than 300 ms: "Stockfish
  is thinking". The 350 ms reply delay is skipped when the search already took that long.
- Phones (the lite worker): the first rook drill asks before the 99 MB download ("These two drills need the full
  engine, a one-time 99 MB download kept for next time. Wi-Fi recommended."), with the existing engine progress.
- End card headlines and summaries for every new result; review list without a distance column, the likely move
  marked, the approximate note always shown.

Done (as p3/p4): npm test and worker vitest green; in Electron (temp CHESS_REVIEW_DATA) and in the web build at
390x844: one Lucena L1 played to 'promoted', one Lucena fail with its hint, one Philidor L1 held 30 moves or by
taking the pawn, one Philidor fail; reply latency logged; screenshots and hand-over in the coordinator's notes
folder. docs/training-grounds.md "Rook endings (v2)" updated to what was built.

## Open questions for the user (with my recommendation)
1. Promotion grading (pushback 1): end on Stockfish's mate score after the promotion, tables for every 4-piece
   result. Recommend yes. The alternative (play Q+R v R to mate) adds moves that train nothing.
2. Phones: full engine on phones, opt-in 99 MB download, only after one test on a real iPhone shows the tab survives
   one engine; if it doesn't, rook drills say "needs a computer" on iOS. Which phone can you test on?
3. 4 levels per ending (recommend), not 5.
4. Add KRKR (recommend; about a minute of build and 0.1 to 0.3 MB) so "pawn taken" and "queen lost" are exact.
5. Cheap follow-up later: a "Queen against rook" mate drill on the KQKR table (needs whiteMoves for black pieces).
   Not in this phase.
6. Card names: "Rook ending: win / hold" with Lucena and Philidor in the descriptions, or the names themselves on
   the cards. Recommend the plain names on desktop, the short names on phones.

## Risks
- Engine on iOS (Q2) is the biggest one; measure before round 4's page work depends on it.
- Opponent strength at 200k nodes: if the defender in Lucena lets obvious draws go, raise nodes before tuning levels.
- Outcome grading forgives some mistakes (above); the hint is approximate by design.
- Families with few verified positions show up in round 2's report; fix by changing the family, not loosening the
  lichess check.

## Decided by the user (2026-11-16), overrides the open questions above
1. Promotion grading as proposed: solved once Stockfish scores mate for white after the promotion; anything down to 4
   pieces graded by our tables. KRKR is built alongside KQKR.
2. Phones: computer first. Rook drills ship on desktop and desktop browsers; on phones the two cards show "needs a
   computer" and no full-net download is offered this phase. An opt-in download comes later, after a real iPhone test.
3. 4 levels per rook ending.
4. Card titles "Lucena" and "Philidor" everywhere, with a plain line under each ("win rook and pawn against rook",
   "hold rook against rook and pawn").

## Round 1 result (2026-11-17, Opus VERDICT: OK, merged to main at 7e21cef)
KQKR 43 s, 748 KB gzipped, longest mate 35 (lichess dtm 69); KRKR 37 s, 263 KB, longest 19. For round 3:
- fromFen now returns names with no table (KRKQ, KQKP, KBKN...); probe throws "no KRKQ table" on them. Grading must
  flip KRKQ to KQKR (and read the result for the other side) or check the name against ENDING_NAMES before probing.
- whiteMoves throws for KQKR and KRKR, so bestLine and lineFrom do too; don't wire a line request for them.
- The spec's "KQKR flipped is still KQKR" is wrong: flipped it is KRKQ.

## Round 2 result (2026-11-17, Opus VERDICT: OK, cherry-picked to main, 228358f)
240 Lucena + 229 Philidor starts in js/core/rook-starts.js, cache data/tablebase-cache.jsonl committed. Philidor L4
has 49 (accepted). Must be fixed before ship, in a fix round (2b) that runs alongside round 3 (file format unchanged):
- Lucena L1/L2 mostly don't teach the bridge or the cut (L1: 26/60 promote within 3; only 8/60 look like a bridge).
  The b-pawn rule fell back to the rook on the king's side (build_rook_starts.js:115). Tighten: black king exactly 2
  files from the pawn, black rook on the far side (drop b-pawns or give them an a-file rule), promote >= 5.
- Philidor L1/L3: too many drawing first moves (median ~12 of 17), L3 often already has the rook behind. Cap `good`.
- `promote` is a walk estimate (lichess lists by DTM, not DTZ), errors -3..+4 vs /mainline. Fix: run /mainline once
  for every Lucena start, unattended (~1 call a minute), cached, and use that as `promote`. Fix the comments.
- User-Agent back to the spec's generic "endgame-table-check". A network error must not be cached as a permanent skip.
- Test: run build({offline: true}) and compare with the committed file; drop the mirror check that can't fail.
For round 3: deal from 49 at Philidor L4; budget = promote + slack, where promote counts the promoting move; measure
tablebase-best white against the real drill opponent on about 20 starts per level and report how many promote within
budget (the opponent is Stockfish at 200k nodes, not the tablebase).

## Round 3 result (2026-11-17, Opus VERDICT: OK, fast-forwarded to main)
Grading, opponent pools, routes and record per p5-r3-handover.md; fairness: tablebase-best white within budget in
80/80 Lucena games against the real opponent; native reply p90 ~0.18 s, WASM in Node ~0.34 s. Low items for round 4:
- parseMove keeps the client's halfmove clock and move number from fens[0]; replace them with the stored start's
  (a crafted "99" makes Philidor 'held' after one move). Cheap fix, do it in round 4.
- An illegal engine move throws a plain Error (rook-drills.js:276), a 500 not a 503: wrap it as EngineFailed.
- End card for Lucena 'budget' after a promotion: "the new piece didn't win in time", not "too slow". On the 10th
  move after promotion the budget check runs before the engine is asked.
- Philidor 'pawn_taken' can show a move early when the user can take the new queen next move (outcome right).
- drill-opponent bestOf reads the last info line, not bestmove (deterministic, low).
- Without Cache Storage the drill pool downloads the 99 MB again, one after the other (low).
