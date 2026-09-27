# chess.com Game Review: arrows and board highlights (behavioural spec)

Evidence ids refer to `observations.jsonl`:
- `gNN.pMMM` is game NN, ply MMM (1-based). The game list is in `corpus.md`.
- `x08.*` is the settings experiment, `xN.*` navigation, `xE.*` exploration, `xA.*` the Analysis tab, `xG.*` geometry and `xT.*` timing and held keys.

**Basis.**
- 15 reviewed games, **926 plies**: 9 reviewed from White and 6 from Black.
- Account Aris_Ver (Diamond), review engine *Torch Human / Fast*, arrow mode *Coach* unless stated.
- Plus: 61 exploratory moves over 12 positions, 31 navigation plies, 5 settings probes, a Best-mode pass over g01–g03 (129 plies), 10 Analysis-tab records, 6 held-key phases and 2 geometry records.
- Status: **Confirmed** means at least 3 consistent cases and no contradiction. **Likely** means 1–2 cases. **Guess** means inferred.
- Every Confirmed claim below was re-checked against the log with `stats.py`, `greenred.py` and `thresholds.py` (scratch scripts). The counts quoted are their output.

---

## 1. Summary rules

| # | Rule | Status | Evidence |
|---|---|---|---|
| R1 | **Square tints.** Every played move tints its from- and to-squares in the classification colour at opacity 0.5; this replaces the normal yellow last-move highlight. Colours (RGB): book 213,164,125 · best and excellent 129,182,76 (the same colour) · good 149,183,118 · inaccuracy 247,198,49 · mistake 255,164,89 · miss 255,119,105 · blunder 250,65,45 · great 116,155,191 · brilliant 38,194,163 · forced 255,255,51. Castling tints the king's from and to squares; en passant does not tint the captured pawn's square. When a 0.8 overlay (R8–R10) falls on one of the two squares, it *replaces* the tint there. | Confirmed | 893 plies with 2 tinted squares in one colour; the other 33 have one tint plus a 0.8 overlay on the other square (26 red, 7 orange). Castling g04.p036; e.p. g03.p022, g04.p014 |
| R2 | **Green arrow** `rgba(159,207,63,0.8)`: the mover's better move, i.e. a move from the position *before* the played move, drawn on the board *after* it. It appears **only** on inaccuracy, mistake, miss and blunder, and on none of the other 662 plies. | Confirmed | green on non-bad plies: 0. Green is a legal move for the mover in 158/160 cases; the other 2 are castling drawn king→rook (R15). Green equals the Best-mode arrow in 17/17 checked cases (x08.05) |
| R3 | **Red arrow** `rgba(248,85,63,0.8)` on a bad move is the opponent's punishing reply: a legal move for the opponent after the played move (123 of 154 red arrows). It is the first move of the losing line: a capture, fork, kick, skewer or the first move of a mate. | Confirmed | g02.p011, g03.p015, g13.p009, g14.p010, g15.p051 … It matched local Stockfish's best reply (depth 14) in 98/124 plies; the other 26 differ from that engine's choice |
| R4 | **Every bad move shows green, red or both.** Both appear exactly when the coach explanation has two parts: one about what the opponent can now do, and one about what the mover missed. | Confirmed | 264/264 bad plies have green and/or red. 20 have both, and all 20 have two-part sentences (e.g. g09.p015, g13.p021, g15.p013, g15.p069) |
| R5 | **Green versus red follows the kind of explanation.** Green-type sentences: "misses … / better move was … / best option was …"; the *moved* piece left free ("leaves the X hanging and available to be taken immediately", "places the X on an unsafe square", "leaves … a pawn that can be taken freely"); and generic ones ("critical move … easy to overlook", "only one good move", "was better off, but now …", "lost their winning advantage", "Big oof"); and positional remarks ("the knight ends up on a less active square"). Red-type sentences: "allows / permits the opponent to …", "leads to losing a X", "loses a X / loses material", "leaves a X without defenders", "removes a key defender and leaves … hanging", "gives away a free X", "hangs a X" (another unit), "the pin is ignored", "the attack … goes unanswered". Two-part sentences get both colours, in the order of the sentence. | Confirmed at the sentence level: 0 contradictions in 264 bad plies. **Engine-level approximation (Guess):** green-only when the move is *not a capture*, the moved piece can simply be taken, and the sentence is the "hanging / unsafe" type. That holds 12/12, but the same situation also produced red "loses a knight / bishop" sentences (g10.p018, g10.p050, g13.p083) | green hanging-type: g01.p037, g03.p033, g03.p037, g05.p021, g09.p040, g12.p015, g14.p012, g15.p010. Red after a capture that loses the capturing piece: g11.p017, g13.p027, g15.p020 |
| R6 | **Good-or-better moves never get green.** Best, excellent, good, great, book and brilliant show nothing (432 of 662 plies, 65%) or *idea* arrows: mostly orange (R11), and red only for the threat idiom (R7). | Confirmed | plies with arrows: best 94/274, excellent 71/171, good 39/93, great 10/32, book 11/66, brilliant 5/5 |
| R7 | **Threat idiom** on a good-or-better move that creates a concrete threat (wins material, forces mate, traps a piece): a **red** arrow for the mover's *next* move, plus an **orange 0.8 overlay** `rgba(255,170,0,0.8)` on its target square. | Confirmed (30 red arrows on non-bad plies: best 17, good 6, excellent 5, great 2) | g03.p014, g11.p014, g13.p048/p050/p052, g13.p090 (promotion), g15.p045 |
| R8 | **Consequence idiom** on bad moves: the red reply gets the orange 0.8 overlay on its target when the explanation is "allows / permits the opponent to …" (fork, skewer, mate, pin, win material). | Confirmed | 97 of the 98 orange overlays sit on the target of a red arrow; e.g. g13.p009, g14.p018, g15.p017, g15.p023 |
| R9 | **Line idiom** for pins and blocked checks or attacks: an orange arrow along the line, with a **red 0.8 overlay** `rgba(248,85,63,0.8)` on the pinned or blocking piece. | Confirmed | g12.p017, g13.p020, g13.p066, g14.p007, g14.p023, g15.p030 |
| R10 | **Structure idiom** (pawn chain, doubled, isolated or backward pawns, blockade, opposition): red 0.8 overlays on the pawns or squares concerned, with no arrow. | Confirmed (12 plies with red overlays and no arrows) | g04.p024 (g4, h5), g04.p134 (b6), g13.p070 (chain c6, d5, b5); with an orange capture arrow: g03.p011 (f6, f7) |
| R11 | **Orange idea arrows** `rgba(255,170,0,0.8)`, one arrow per element of the idea: every newly opened bishop ray (up to 4); every fork prong (up to 3); a pawn kick (pawn → attacked piece); a passed pawn → its promotion square; a rook behind a passed pawn (rook → pawn plus pawn → queening square); castling readiness (king → g- or c-file square); a trade (both recaptures onto the square); defence (defender → defended piece, sometimes also attacker → piece); a discovered line; the played move itself when it is a long-range capture. | Confirmed | 169 orange "piece attacks target", 62 "along a ray", 48 "opponent move", 6 "is the played move". e.g. g13.p030 (4 rays), g15.p068 (fork), g13.p054 (trade), g13.p085 (defence), g10.p048 (played move) |
| R12 | **Brilliant**: exactly one orange arrow, the opponent's capture of the sacrificed or abandoned piece. | Confirmed (5/5) | g07.p019 c6b5, g07.p025 f6d7, g07.p031 d7b8, g08.p021 g8h7, g15.p032 g7h8 |
| R13 | **No arrows** on forced moves, on the mating move, and on the stalemating move. | Confirmed for forced (21/21) and mate (5/5); Likely for stalemate (1/1) | forced g08 ×6, g13.p028; mate g02.p048, g07.p033, g08.p035, g10.p071, g13.p098; stalemate g04.p143 |
| R14 | **Geometry.** All arrows live in a `0 0 100 100` SVG viewBox over the board (square = 12.5).<br>• Straight arrows: 7-point polygon; shaft 2.75 wide; head 6.5 wide and 4.5 long; the tail starts 4.5 from the source-square centre; the tip lands on the target-square centre; the shape is rotated into place.<br>• Knight arrows: 9-point L polygon, always long leg first, mirrored with `scale(-1,1)`.<br>• Style: fill alpha 0.8 **and** element opacity 0.8. | Confirmed (473 straight, 135 knight) | xG.01–02, every arrowed ply |
| R15 | **Castling arrows.** A *better move* that is castling is drawn king → rook square (e8h8). Castling-readiness idea arrows go king → destination square (e8g8, e1c1). | Likely for king→rook (2/2); Confirmed for readiness (8) | g10.p012, g13.p014; readiness g02.p008, g04.p018, g13.p008, g13.p011 |
| R16 | **Same move, consecutive plies.** A move shown red on ply N ("allows X") is shown **green** on ply N+1 when the opponent fails to play it ("misses X"), and the other way round (green "missed" on N, red "allows" on N+1 when the other side leaves it available again). The arrow itself does not change, only its colour. | Confirmed | red→green: g13.p073→p074 g2g3, g14.p018→p019 d1d6, g15.p020→p021 g5c1, g15.p077→p078 f8c5. Green→red: g11.p024→p025 g5c1 |
| R17 | **Timing and navigation.**<br>• The full arrow set is in the DOM 2–9 ms after the step (median 3 ms, n=494).<br>• There is no fade, no debounce and no skipping: held or repeated keys at 16–250 ms draw every intermediate ply's arrows (xT.summary).<br>• Arrow keys, clicking a move and stepping back give identical displays, and flipping the board changes no arrow coordinates (31/31, xN.summary).<br>• The coach **Next** button jumps to the next key moment, not the next ply (skipped ahead 11/31 times). | Confirmed | `t_first_arrow_ms`; xT.01–04; xN.* |
| R18 | **Missed recapture.** "A recapture was available, but a different move was played" draws a **red** arrow for the *mover's own* missed recapture (legal before the move), with no green. | Likely (1) | g15.p037 d3e4 |
| R19 | **Badges and end icons.**<br>• The classification badge sits on the to-square as a static `.effect` icon; the miss icon id is `incorrect`.<br>• Great (`great_find`) and Brilliant (`Brilliant`) badges are `.animated-effect` elements.<br>• On the last ply, animated end icons sit on both kings: `winner` plus `mate`, `resign`, `resignwhite`, `abandon` or `draw_*`. When the last move was a king move, the king's icon replaces the classification badge. | Confirmed | g10.p071, g11.p025, g12.p020, g13.p098, g14.p024, g15.p082; king-move mate g08.p035 |
| R20 | **Coach panel buttons.**<br>• *Best* (show the better move) is offered on every good and bad move and on most excellent ones, never on best, great, brilliant, book or forced moves.<br>• Excellent moves lack Best in two situations: inside a forced mate (14 plies, all with M evals, e.g. g10.p059–p070, g13.p054), and on 7 plies that show *Share* instead (g01.p017, g02.p026, g03.p018, g05.p042, g05.p048, g10.p009, g10.p037).<br>• *Share* appears on every great (32/32) and brilliant (5/5) move.<br>• The last ply has no *Next*. | Confirmed | button counts per class (stats) |
| R21 | **Arrow mode setting** (`arrowModeSelect`), applied to the whole review:<br>• **Coach** gives R2–R16.<br>• **Best Move** gives exactly one arrow, fill `rgb(150,190,70)` with opacity 0.8, for the mover's best move. It is shown iff the played move was not the engine's top move (good, excellent and all bad classes, even at 0.00 loss) and never on best, great, book or forced; no 0.8 overlays.<br>• **Coach+Best** gives the union; a coach green that is the same move is merged into the Best arrow.<br>• **Off** gives no arrows and no 0.8 overlays; tints and badges stay.<br>Separately, *Suggestion arrow* and *Show threats* do nothing in the Review view. | Confirmed (Best mode 71/71 present, 58/58 absent) | x08.01–05, xA.01 |
| R22 | **Exploring your own moves in the review.**<br>• Replaying the game move just steps onto the main line.<br>• Playing the review's precomputed best move grades it Best instantly, with no arrow (3/3).<br>• Any other move is graded 1508–1536 ms after the drop. It then shows **exactly one blue arrow** `rgba(72,193,249,0.8)` (opacity 0.8): the engine's best move for the side now to move. It never shows green, red, orange or overlays, and the arrow does not update (49/49). | Confirmed | xE.summary, xE.P1–P12 |
| R23 | **Analysis tab (outside the review).**<br>• The *Suggestion arrow* is one blue arrow for engine line 1, even with 3 lines shown. It is drawn only once the new search reaches **depth 14** (3/3, 2.2–5.2 s after the step), cleared about 45 ms after stepping, and not redrawn at greater depth.<br>• The *Threat arrow* is `rgb(202,52,49)` at opacity 0.75, drawn about 40 ms after the first shallow result (depth 9–11). It shows what the side that *just moved* would play if it could move again (2/2 agree with a Stockfish null-move search). When the side to move is in check, it shows the checker capturing the king, plus a fork prong if there is one.<br>• Both arrows stack with no offset. | Confirmed for the suggestion depth gate (3); Likely for threat semantics (2 + 2 in check) | xA.02–10 |

---

## 2. Arrow catalogue

| Arrow | When it is drawn | Colour: fill / element opacity | Geometry | Timing | Controlling setting |
|---|---|---|---|---|---|
| Better move (coach green) | inaccuracy, mistake, miss, blunder with a green-type sentence or sentence part (R2, R5) | `rgba(159,207,63,0.8)` / 0.8 | R14; castling king→rook (R15) | synchronous with the step (2–9 ms) | Arrows = Coach or Coach+Best |
| Punishing reply (red) | bad move with a red-type sentence part (R3, R5); target gets an orange 0.8 overlay for "allows / permits" (R8) | `rgba(248,85,63,0.8)` / 0.8 | R14 | synchronous | Coach, Coach+Best |
| Threat (red + orange overlay) | good-or-better move creating a concrete threat; the arrow is the mover's follow-up (R7) | red as above + overlay `rgba(255,170,0,0.8)` on the target | R14 | synchronous | Coach, Coach+Best |
| Missed recapture (red) | "A recapture was available …" (R18) | red as above, no overlay | R14 | synchronous | Coach |
| Idea (orange) | good-or-better move whose sentence names a scope, fork, kick, pin line, trade, castling readiness, passed pawn, defence or discovered line (R11); brilliant: the capture of the sacrificed piece (R12) | `rgba(255,170,0,0.8)` / 0.8 | R14; one arrow per ray or prong | synchronous | Coach, Coach+Best |
| Line / structure overlay (not an arrow) | pinned or blocking piece (R9); structure (R10) | square `rgba(248,85,63,0.8)`, replacing the tint (R1) | 1 square | synchronous | Coach, Coach+Best |
| Best move | every ply whose move was not the engine's top move (R21) | `rgb(150,190,70)` / 0.8 | R14 | synchronous | Best, Coach+Best |
| Exploration reply (blue) | after a user move in the review that is neither the game move nor the precomputed best (R22) | `rgba(72,193,249,0.8)` / 0.8 | R14 | about 1.5 s after the drop, once | always (review, any mode) |
| Analysis suggestion (blue) | Analysis tab, *Suggestion arrow* on: line 1 once depth ≥ 14 (R23) | `rgba(72,193,249,0.8)` / 0.8 | R14 | 2–5 s after the step | Suggestion arrow |
| Analysis threat (dark red) | Analysis tab, *Show threats* on: the null-move best move of the side that just moved (R23) | `rgb(202,52,49)` / 0.75 | R14 | about 120 ms after the step | Show threats |

Arrows are never offset or bundled:
- Opposing arrows on the same line (g05.p033 a1h1/h1a1) are drawn independently.
- Two arrows onto one square (g09.p039) are drawn independently.
- The most arrows seen on one ply is 4 (5 plies), then 3 (4 plies), 2 (91), 1 (394), 0 (432).

---

## 3. Thresholds

| Threshold | Value | Sample | Counterexamples / notes |
|---|---|---|---|
| Green or red on a move | **No eval threshold.** It depends on the classification (inaccuracy, mistake, miss or blunder) and the sentence type (R2, R5) | 264 bad plies | none |
| Best-mode arrow | **No eval threshold.** Shown iff the played move ≠ the engine's top move, even for *excellent* with 0.00 displayed loss | 129 plies (x08.05) | none |
| More than one suggestion arrow | **Never happens.** Exploration shows exactly 1 blue arrow (49 cases); the Analysis suggestion shows only line 1 even with 3 lines (3 cases). There is no multi-arrow eval-gap threshold to reproduce | 52 | none |
| Analysis suggestion arrow depth gate | depth **14** (arrow at 2201–5201 ms) | 3/3 | the Nc7+ step in xA.10 never reached depth 14 within 7 s and drew no arrow (consistent) |
| Analysis threat arrow latency | first shallow result (depth 9–11), 121–129 ms after the step | 4 | — |
| Exploration grading delay | 1508–1536 ms after the drop (median ≈1522); pick-up to drop ≈250 ms | 49 | the precomputed best move grades in 0–21 ms (3) |
| Classification bands (win% loss, mover's view, from chess.com's *displayed* evals; eval before = the previous ply's displayed eval) | nominal chess.com bands: excellent < 2, good 2–5, inaccuracy 5–10, mistake 10–20, blunder ≥ 20 (logistic win% with k = 0.00368) | 424 non-mate plies | exact class in 65% of cases (best fit k ≈ 0.003 → 69%); off by more than one class in only 6/424. In-band: blunder 96%, excellent 88%, good 58%, inaccuracy 46%, mistake 35%. Most "mistakes" below 10% are in already lopsided positions (e.g. g10.p032 +6.3, g15.p023 −6.0), so chess.com probably uses a flatter curve or its own pre-move eval. Plain centipawn cut-offs (40/80/170/310 cp) do no better (68%) |
| Win% loss medians per class | best 0 · excellent 0.83 · good 3.05 · inaccuracy 5.86 · mistake 8.59 · miss 20.4 · blunder 39.2 | 926 plies | miss is not a loss band: it marks a *missed win or tactic* (54 cases, 0–100% loss) |
| Opacity values | arrows: fill alpha 0.8 × element opacity 0.8 (Best: solid fill × 0.8; threat: solid × 0.75); tints 0.5; overlays 0.8 | all | — |

---

## 4. Classification ↔ board display

| Class | Tint (0.5) | Badge | Arrows seen (plies with a colour / total) | 0.8 overlays (squares) | Buttons (Explain present / Best / Share) |
|---|---|---|---|---|---|
| brilliant | 38,194,163 | `Brilliant` (animated) | orange capture-of-sacrifice, always 1 (5/5) | — | Explain 5/5 · no Best · Share 5/5 |
| great | 116,155,191 | `great_find` (animated) | orange 8, red threat 2 (10/32) | red 7, orange 2 | Explain 27/32 · no Best · Share 32/32 |
| best | 129,182,76 | `best` | orange 78, red threat 16 (94/274) | red 18, orange 16 | Explain 193/274 · no Best · no Share |
| excellent | 129,182,76 | `excellent` | orange 67, red 4 (71/171) | red 21, orange 4 | Explain 107/171 · Best 150/171 · Share 7/171 |
| good | 149,183,118 | `good` | orange 33, red 6 (39/93) | red 11, orange 6 | Explain 62/93 · Best 93/93 |
| book | 213,164,125 | `book` | orange 11 (11/66), e.g. g11.p003 | red 2 | Explain 40/66 · no Best |
| forced | 255,255,51 | `forced` | none (0/21) | — | Explain 18/21 · no Best |
| inaccuracy | 247,198,49 | `inaccuracy` | green 66, red 24, some both (88/88) | orange 20 | Explain 74/88 · Best 88/88 |
| mistake | 255,164,89 | `mistake` | red 62, green 30 (90/90) | orange 29 | Explain 87/90 · Best 90/90 |
| miss | 255,119,105 | `incorrect` | green 53, red 11 (54/54) | orange 7 | Explain 44/54 · Best 54/54 |
| blunder | 250,65,45 | `blunder` | red 27, green 11 (32/32) | orange 14 | Explain 32/32 · Best 32/32 |
| last ply | as its class | + end icons on both kings (R19) | as its class; none if mate or stalemate | — | no Next |

---

## 5. Gap analysis (chess.com vs chess-review, `chess_review/static/index.html` and friends)

| Behaviour | chess.com | chess-review now | Change needed | Effort |
|---|---|---|---|---|
| Where green is drawn | only on inaccuracy, mistake, miss, blunder (R2) | green on **every** non-best move of mine incl. good and excellent (`renderArrows`, index.html:1784) | limit coach green to `BAD`; move the "every non-top move" arrow into a separate Best-move mode (below) | S |
| Opponent's bad moves | same treatment as the user's: green and/or red (R2–R5; 264 bad plies, both sides) | opponent's bad move → blue reply only; no green (index.html:1769, 1785) | draw green and red for both sides; keep blue for exploration only | S |
| Green vs red decision | by explanation type (R5): moved piece simply hangs on a quiet move → **green only**; "leads to losing / loses / allows / without defenders" → **red**; two-part → both | green always, plus red when the reply is concrete; `rescueMove` hides green when the refutation takes the moved piece, which is the **opposite** of chess.com (index.html:1764) | derive a sentence type from `facts` (hung moved piece & quiet move → hanging type; refutation line wins material or a mate/fork → loses/allows type; missed tactic → misses type), then pick colours by the R5 table. Delete `rescueMove` and the x badge | M |
| Target overlay on red arrows | orange 0.8 square on the red arrow's target for threats and "allows" consequences (97/98 orange overlays) | red squares on hung pieces with an x badge (`squareMark`, `hungSquares`) | draw an orange 0.8 square at the red target when the red move is a threat, fork, mate or attack; drop hung-piece squares | S |
| Red overlays for pins, blocks and structure | red 0.8 square on the pinned or blocking piece + orange line (R9); structure overlays without arrows (R10) | none | new idea types in `facts.idea_arrows` (pin line, block, structure) returning squares as well as arrows | M |
| Threat idiom on good moves | mover's follow-up threat drawn **red** + orange target overlay (R7) | ideas drawn orange only | when the idea is a concrete threat (wins material or forces mate), emit red + overlay; positional ideas stay orange | S |
| Idea arrow repertoire | rays (up to 4), fork prongs, kick, passed pawn → queening square, rook behind passer, trade recaptures, defence, discovered line, castling readiness, played long-range capture (R11) | trade, attack targets (max 2), castling, pawn-push prepare (`facts.idea_arrows`) | add rays, kick, passed pawn, rook-behind-passer, defence and discovered line; allow up to 4 arrows | M |
| Brilliant display | exactly one orange arrow: the capture of the sacrificed piece (R12) | generic idea arrows | on brilliant, draw only the opponent's capture of the sacrificed piece | S |
| Missed recapture | red arrow on the mover's own recapture (R18, 1 case) | not modelled | optional special case | S |
| Arrow opacity | fill alpha 0.8 **×** element opacity 0.8 (≈0.64 effective) | fill alpha 0.75, no element opacity (`arrowStyle`) | `fill: rgba(r,g,b,0.8); opacity: 0.8` for weight 1 | S |
| Knight arrow bend | always long leg first (135/135) | picks the short bend to avoid collisions (`drawArrows`) | always use `'long'` | S |
| Tint colours | excellent = best 129,182,76; good 149,183,118; book 213,164,125; forced 255,255,51 | excellent `#96bc4b`, good `#96af8b`, book `#d5a47a`, forced `#96af8b` (`COLOR`, index.html:603) | excellent `#81b64c`, good `#95b776`, book `#d5a47d`, forced `#ffff33` | S |
| Overlay vs tint on one square | a 0.8 overlay replaces the 0.5 tint (33 plies) | tint and marks stack | skip the tint on squares that get an overlay | S |
| Castling better-move arrow | king → rook square (e8h8) | engine UCI e1g1 | map castling best moves to king→rook for the green arrow; readiness ideas stay king→g/c | S |
| No arrows on forced, mate, stalemate | none (R13) | forced excluded from green; mating move not special-cased | suppress all arrows when `is_checkmate` / `is_stalemate` or label = forced | S |
| Arrow mode setting | Coach / Best Move / Coach+Best / Off (R21); Best arrow `rgb(150,190,70)` on every non-top move | a Best toggle (`state.showBest`) drawing green | add a 4-way setting; Best colour `rgb(150,190,70)` × 0.8; merge a coach green equal to Best | M |
| Exploring your own moves | one blue arrow, the engine's best for the side to move, drawn once after grading (~1.5 s); no green, red, orange or overlays; precomputed best graded instantly, no arrow (R22) | live **swarm of 3** candidates weighted 1 / 0.68 / 0.45 that re-settles while streaming; leaf `next_best` green (index.html:1787–1793) | one blue arrow for PV1 once the grade is final; no swarm, no green at leaves | M |
| Analysis suggestion arrow | line 1 only, drawn from depth ≥ 14, cleared on step (R23) | `/api/eval_stream` multipv 3 feeding the swarm | gate the arrow on depth ≥ 14 and draw PV1 only | S |
| Analysis threat arrow | null-move best move of the side that just moved, `rgb(202,52,49)` × 0.75, first shallow result; checker→king when in check (R23) | none | a null-move search in `explore.analyse_stream` (skip when in check; then draw checker → king) + a threat layer | M |
| Same arrow red → green on the next ply | consistent (R16) | reply red on N; the next ply's green is its own best move, so it matches naturally when both sides are treated alike | falls out of "both sides alike" | S |
| End-of-game icons | animated icons on both kings (winner + mate / resign / abandon / draw); replaces the badge after a king move (R19) | winner/equal badges on kings | add mate, resign and abandon variants; king-move replacement | S |
| Timing and navigation | synchronous redraw on every step; no debounce; flip is CSS-only (R17) | `renderArrows` on each step; flip mirrors via `sqXY` | none needed | — |
| Retry-mistake mode | not present in this build (no such button in 926 plies) | not present | none | — |
| Classification bands | ≈ win% bands 2/5/10/20 (65–69% exact on displayed evals, 98.6% within one class) | the same bands in `config.py` (EXCELLENT 2, INACCURACY 5, MISTAKE 10, BLUNDER 20) | none; optionally try k ≈ 0.003 | — |

---

## 6. Open questions (with FENs to run through Stockfish)

1. **What an engine-only reimplementation should use to choose "hanging" (green) versus "loses a X" (red) when the moved piece is lost.** Both happen on quiet moves.
   - Green: g12.p015 Be3, FEN after `r1bqk2r/ppp2ppp/2np3n/4P3/3P1p2/2P1BN2/P1P3PP/R2QKB1R b KQkq - 1 8`.
   - Red: g13.p083 Nf6+, `6k1/4B3/5N2/1p1p4/8/6p1/1K6/7r b - - 5 42`, and g10.p018 Nd5, `r1bqk2r/pp1nbppp/2pP4/1B1n4/8/2N1Q3/PPPP1PPP/R1B1K1NR w KQkq - 1 10`.
   - Hypothesis: red when the piece is won only after a forcing move (check, king move, exchange line), green when it can be taken at once for free. Test with a 1-ply static-exchange check.
2. **When a red reply gets the orange target overlay.**
   - Without overlay: g13.p027 Qxh7+, `r2q1rk1/2p1n1pQ/8/npbp1bN1/3p4/1B6/PP1N1PPP/R1B1K2R b KQ - 0 14`.
   - With overlay on the capture square: g15.p020 Qxc1+, `N4bnr/pb1k1p1p/2npp3/6Q1/4P3/1P1P4/P1P2PPP/2q1KBNR w K - 0 11`.
   - The difference might be "without defenders" versus "loses".
3. **Red overlay with no arrow while the sentence is about structure:** g11.p016 dxe5, `r2qk1nr/p1pn1p1p/7b/1p2pbN1/5P2/6B1/PPPQP1PP/RN2KB1R w KQkq - 0 9`. The red square on f7 may be the structure idiom marking a weakness, or a hidden threat Nxf7.
4. **Book move with orange arrows:** g11.p003 Bf4 (last book move), `rnbqkbnr/ppp1pppp/3p4/8/3P1B2/8/PPP1PPPP/RN1QKBNR b KQkq - 1 2`. Arrows: e7e5, the opponent's move being discouraged, and f4e5. Is this a general "prevents …" idiom? Only 11/66 book plies have arrows.
5. **Mistakes with small displayed win% loss:**
   - g15.p023 Kf3 (0.43), `N4bnr/pb1k1p1p/2npp3/6Q1/4P3/1P1P1K2/P1q2PPP/5BNR b - - 1 12`;
   - g10.p032 Kd7 (0.97), `r1b5/pp1k1Npp/5n2/1N2r3/8/4P3/PPPP2PP/R1B1K2R w KQ - 1 17`;
   - g06.p007 g3 (Mistake at −0.19), `rnbqkbnr/ppp2p1p/3p2p1/4p3/8/1P2P1P1/PBPP1P1P/RN1QKBNR b KQkq - 0 4`.

   Run the before and after positions at the review engine's strength to see whether chess.com's own best-move eval differs from the previous ply's displayed eval. Rating-dependent grading is also possible.
6. **Missed recapture (R18) is one case:** g15.p037 g3, before `N6Q/pb1kb2p/2npp3/8/4n3/1q1P1N2/4KPPP/5B1R w - - 0 19`. Is "recapture available" always red, and does it take priority over the green better move?
7. **Miss drawn red** (the sentence names only the loss): g05.p069 Ke5, `6k1/pp3ppp/5P2/4K1N1/1br5/5r2/PP5P/R7 b - - 2 35`. Is "miss" graded on the mover's missed win while the sentence and arrow describe the loss?
8. **Geometry at a second window size was not confirmed.** The Chrome window was maximized and ignored resizing (xG.00). The SVG is viewBox-relative, so thickness should scale with the board. The board was seen at 1136 px once (g11 load), but no arrow was measured at that size.
9. **Stalemate** has only one sample (R13), and **underpromotion** and **en passant** are rare. Their display (no arrows / green / orange) is from 1–2 cases each.

---

## Method notes and limits
- **Coach sentences** are stored only as keyword-tag paraphrases in `observations.jsonl`. The R5 sentence types were derived from the raw sentences captured locally and are summarised here in paraphrase.
- **`engine_lines`** is empty for review plies: the Review view shows no engine lines. Analysis-tab lines are summarised in `xA.*`.
- **Stopping rule not met** (see `corpus.md`). Coverage was met at g10. Of the next five games, three changed something:
  - g11 and g13 refined R5;
  - g15 added R18 and the `abandon` icon;
  - g12 and g14 added nothing.
- **Settings restored:** arrow mode Coach, Suggestion arrow off, Show threats off, as found (verified after the Analysis-tab experiment).
