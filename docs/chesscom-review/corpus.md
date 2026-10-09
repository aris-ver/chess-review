# chess.com Game Review — observation corpus

Account used: **Aris_Ver** (Diamond, unlimited reviews). UI language Greek; coach sentences in English.
Review settings during every walk: engine *Torch Human*, strength *Fast (~1 s, Elo 3270)*, show-arrows mode *Coach Arrows* (the default; see `x08.*` for the other modes).
Every game was walked ply by ply in the **visible** tab, with synthetic `ArrowRight` key presses from an in-page script. After each step the script waited until the board and coach text had been still for 0.9 s, then captured arrows, highlights, badges, coach headline, eval and buttons. Records are in `observations.jsonl` with ids `gNN.pMMM` (1-based ply).

**Totals: 16 games, 1040 plies.**
- Reviewed from White: 10 games (g01, g03–g08, g12, g13, g16).
- Reviewed from Black, with the board flipped: 6 games (g02, g09, g10, g11, g14, g15).

| # | Game / source | Result | Reviewed as | Why picked | Coverage hits |
|---|---|---|---|---|---|
| g01 | [69734742883](https://www.chess.com/analysis/game/live/69734742883/review) kostasstax–CGSnoopeh, blitz 5+5 (tab already open) | 1-0, Black flagged at −6.81 | White | the review already open | book, good, excellent, best, great ×2, inaccuracy ×6, mistake ×5, miss ×4, blunder, forced; O-O both sides; time-scramble ending; won→lost→"won on time" |
| g02 | [6008464170](https://www.chess.com/analysis/game/live/6008464170/review) FransBrouwer–kostasstax, rapid (user tab) | 0-1, 24…Qxf2# | **Black** | Black's side; mating attack | delivered mate; mating attack; moves allowing forced mate; fork; pins; forced ×2; hanging knight (g02.p019) |
| g03 | [5920281532](https://www.chess.com/analysis/game/live/5920281532/review) kostasstax–arauzmjr, rapid (archive scan) | 0-1, White resigned | White | en passant; resignation | en passant (g03.p022); resignation mid-position (g03.p038); hanging queen (g03.p033); structure overlays; **settings experiment x08** |
| g04 | [181382301605](https://www.chess.com/analysis/game/live/181382301605/review) Hikaru–BillieKimbah, blitz (archive scan) | ½-½ stalemate | White | stalemate, O-O-O, e.p., 143 plies | stalemate (g04.p143); O-O-O (g04.p036, Great); e.p. (g04.p014, Great); very long R+P endgame; **lost→drawn** (−5.78 at g04.p043) |
| g05 | [5917766276](https://www.chess.com/analysis/game/live/5917766276/review) kostasstax–staropram, rapid (Stockfish scan) | 1-0 on time, lost on the board | White | missed mates, time scramble | **missed mate-in-1 ×3**, mate-in-2 ×1; allowing mate-in-1 ×3; blunders ×3; opposing arrows a1h1/h1a1 (g05.p033); Miss with red arrow (g05.p069); time scramble |
| g06 | [181729701879](https://www.chess.com/analysis/game/live/181729701879/review) Hikaru–CMjose11, bullet (archive scan) | 1-0, Black resigned | White | promotion, underpromotion, bullet | **promotion** a8=Q (g06.p097); **underpromotion** a1=N (g06.p098); resignation; bullet time scramble; Mistake for a 0.23 drop at 3000+ level (g06.p007) |
| g07 | Opera Game (Morphy 1858), PGN pasted ([review](https://www.chess.com/analysis/game/pgn/5p9m9DiPL2/review)) | 1-0, 17.Rd8# | White | sacrifices | **brilliant ×3** (g07.p019, p025, p031); great (g07.p013); O-O-O (g07.p023); mate (g07.p033) |
| g08 | Ed. Lasker–Thomas 1912, PGN pasted ([review](https://www.chess.com/analysis/game/pgn/27MPmM1vyk/review)) | 1-0, 18.Kd2# | White | queen sac + king hunt | **brilliant** (g08.p021); great (g08.p025); forced ×6 in a row; mate by a king move without badge (g08.p035) |
| g09 | [5919259582](https://www.chess.com/analysis/game/live/5919259582/review) Exquize–kostasstax, rapid (Stockfish scan) | 0-1, White resigned | **Black** | missed mates, Black's side | missed mate-in-1 ×2, mate-in-2, mate-in-5; **8 red+green plies**; won→drawn swing (g09.p078–p079); two arrows onto one square (g09.p039) |
| g10 | [6008587135](https://www.chess.com/analysis/game/live/6008587135/review) velimare–kostasstax, rapid (user tab) | 1-0, 36.Rf7# | **Black** | promotions, missed mates | promotion ×2 (g10.p021, g10.p063); missed mate-in-1 ×2 (g10.p067, p069); mate by rook with `winner`/`mate` icons; best-move castling arrow e8h8 (g10.p012); **experiments x02 nav, x03 Analysis tab, x04 exploration, x06 geometry, x07 timing** |
| g11 | [6008555917](https://www.chess.com/analysis/game/live/6008555917/review) CalebTTU–kostasstax, rapid 10 min (user tab) | 0-1, White resigned after 13.e4 | **Black** | stopping-rule game | pin ignored (g11.p019); great (g11.p020); capture that leaves the capturing knight undefended → red (g11.p017, R5 refinement); book move with orange arrows (g11.p003); `resign` icon |
| g12 | [6176464312](https://www.chess.com/analysis/game/live/6176464312/review) kostasstax–diniarbajbulatov, rapid (user tab) | 0-1, White resigned after 10…axb5 | White | stopping-rule game | hanging bishop → green (g12.p015); castling mistake with red reply (g12.p019); miss (g12.p007) |
| g13 | [5920318933](https://www.chess.com/analysis/game/live/5920318933/review) kostasstax–archiefrench, rapid (archive scan) | 0-1, 49…Qa1# | White | 98 plies, promotion, mate | promotion g1=Q with threat idiom (g13.p090); ladder mate (g13.p098); missed forced mate (g13.p062); great discovered check (g13.p019); "loses a queen/knight" → red (g13.p027, p083); pawn chain overlays (g13.p070) |
| g14 | [6008425446](https://www.chess.com/analysis/game/live/6008425446/review) Bradthecat–kostasstax, rapid (Stockfish scan) | 1-0, Black resigned after 12…Qc4 | **Black** | missed mate-in-1 | missed mate-in-1 Qd6# (g14.p019); allows mate (g14.p018); "unsafe square" → green (g14.p012) |
| g15 | [5918744487](https://www.chess.com/analysis/game/live/5918744487/review) sanjarsherqulov–kostasstax, rapid (Stockfish scan) | 0-1, White abandoned after 41…a2 | **Black** | missed mates | **brilliant** (g15.p032); missed mate-in-1 ×2 (g15.p022, p041); great ×3; "a recapture was available" → red arrow = the mover's own missed recapture (g15.p037, **new idiom**); `abandon` icon |
| g16 | [184469387614](https://www.chess.com/analysis/game/live/184469387614/review) arisgmn1 (554)–Lakshya4599 (576), rapid 10 min | 0-1, White resigned | White | rating calibration below 800: 114 plies, 9 lead changes, both players ~560 | **different recording:** account arisgmn1 (basic membership, one review a day, default review engine, not Torch Human); only the coach headline label and the eval were captured, no arrows, highlights or coach text; 2026-10-09 |

Games opened but **not** logged:
- 49989027721 was two plies long (1.e4 e5, then White won).
- 69719833908 was four plies long.

Both were too short to exercise the display.

## Coverage tally (after g15)

| Item | Count | Where (examples) |
|---|---|---|
| brilliant | 5 | g07.p019, g07.p025, g07.p031, g08.p021, g15.p032 |
| great | 32 | g01.p015, g04.p014, g07.p013, g11.p020, g13.p019, g15.p070 … |
| best | 274 | all games |
| excellent | 171 | all games |
| good | 93 | all games |
| book | 66 | all games |
| inaccuracy | 88 | all games |
| mistake | 90 | all games |
| miss | 54 | g01 ×4, g05, g09, g13, g15 … |
| blunder | 32 | g01.p037, g03.p015, g05.p021, g12.p015, g15.p020 … |
| forced | 21 | g01.p043, g02.p027, g08 ×6, g13.p028 … |
| missed mate-in-N | 14+ | g05.p060/p062/p066/p068, g09.p055/p063/p083/p084, g10.p067/p069, g13.p062, g14.p019, g15.p022/p041 |
| delivered mate | 5 | g02.p048, g07.p033, g08.p035, g10.p071, g13.p098 |
| mating attack | 5 | g02, g07, g08, g10, g13 |
| stalemate | **1** (rare) | g04.p143 |
| hanging piece left en prise | 8+ | g01.p037, g02.p019, g03.p033, g05.p021, g09.p040, g12.p015, g14.p012, g15.p010 |
| winning tactic found | 6+ | g01.p015 pin, g02.p026 fork, g13.p019 discovered check, g15.p070 fork, g11.p020, g04.p020 |
| winning tactic missed | 10+ | g04.p044 fork, g13.p074 fork, g15.p048 discovered attack, g15.p028 fork, g13.p021 … |
| lost→drawn swing | 3 | g04 (−5.78 → stalemate), g09.p078–p079, g15.p046/p060 (0.00 from a lost position) |
| castling O-O / O-O-O | 12 / **2** | O-O g01.p011 … g13.p016; O-O-O g04.p036, g07.p023 |
| en passant | **2** (rare) | g03.p022, g04.p014 |
| promotion / underpromotion | 5 / **1** | g06.p097, g10.p021, g10.p063, g13.p090 / g06.p098 |
| time-scramble ending | 3 | g01, g05, g06 |
| very long endgame | 3 | g04 (143 plies), g06 (99), g13 (98) |
| resignation mid-position | 6 | g03, g06, g11, g12, g14, (g09) |
| reviewed from White / Black | 9 / 6 | see table |

Items below three: stalemate (1), en passant (2), underpromotion (1) and O-O-O (2). All four are genuinely rare in real games. The Stockfish scan of the account archive found no further stalemate or underpromotion in kostasstax's games (`sf_scan` notes).

## Stopping rule

**Not met.** Coverage has been met since g10, but the last three games did not all come back clean:

| Game | New rule or changed rule? |
|---|---|
| g11 | yes: capture that loses the capturing piece → red; this refines R5 |
| g12 | no |
| g13 | yes: "loses a knight" on a quiet check → red; together with g11 this reformulates R5 as sentence-type driven |
| g14 | no |
| g15 | yes: "A recapture was available" → red arrow on the mover's own missed recapture (new idiom, 1 case); new game-over icon `abandon` |

The novelties come from rare coach sentence templates. The tail of these templates is long, and each new game has roughly a 50% chance of showing one. No rule other than R5 changed after g10. The games after g10 (g11–g15) refined R5 and added one rare idiom (R18) and one icon name.
