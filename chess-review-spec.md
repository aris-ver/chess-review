# Build Spec: Local Chess Game Review Tool

You are building a personal chess analysis tool. Read this entire spec before writing code. The design decisions below are settled — do not re-litigate them or propose alternatives unless you find a hard technical blocker.

## Goal

Fetch my chess.com game history (or accept a pasted PGN), analyse every position with Stockfish, and produce a game review that identifies **the 3-5 moves that actually decided the game and explains why in plain English**.

The explanations must be generated from deterministic facts extracted from engine output and board geometry. **No LLM anywhere in this system.** Format strings over structured data.

## Hard constraints

- Personal use only. Single user (me). No auth, no multi-tenancy, no deployment.
- Runs locally. My machine, my CPU.
- No paid APIs, no token costs.
- Python. Assume strong proficiency — skip explanatory comments on standard idioms.
- No LLM, no ML, no inference beyond Stockfish itself.

## Stack

- `python-chess` for PGN parsing, board logic, UCI communication, SVG rendering
- Stockfish 18 as a local binary, spoken to over UCI
- DuckDB + Parquet on disk for storage. No server, no ORM.
- CLI entry points per stage. Each stage is independently runnable and idempotent.
- Output: static HTML file. No web framework, no SPA, no chessboard JS library.

## Architecture

Four stages. Each reads from disk, writes to disk, and can be re-run without redoing prior work.

```
ingest → normalise → analyse → review
```

### Stage 1: Ingest

Pull all monthly archives from the chess.com public API:

- `https://api.chess.com/pub/player/{username}/games/archives` returns archive URLs
- Fetch each archive URL, dump raw JSON verbatim to `data/profiles/<id>/raw/{YYYY-MM}.json` (one profile per chess.com user; see `profiles.py`)

Rules:
- **Serialise requests.** Parallel requests trigger 429s. One at a time, with a small delay.
- Set a descriptive User-Agent — chess.com requires it.
- Skip archives already on disk unless `--force`.
- This runs once. Never hit the API again during development.

Also accept a raw PGN via `--pgn-file` or stdin, which skips this stage and enters at Stage 2.

**Acceptance:** all archives on disk, re-running is a no-op.

### Stage 2: Normalise

Parse PGNs into two tables.

`games`:
```
game_id           TEXT PRIMARY KEY   -- chess.com URL or content hash for pasted PGN
played_at         TIMESTAMP
time_control       TEXT
time_class         TEXT               -- bullet/blitz/rapid/daily
my_colour          TEXT               -- 'white' | 'black'
my_rating          INTEGER
opponent_rating    INTEGER
result             TEXT               -- 'win' | 'loss' | 'draw'
termination        TEXT
eco                TEXT
opening_name       TEXT
```

`positions`:
```
game_id           TEXT
ply               INTEGER            -- 0-indexed, before the move is played
fen               TEXT               -- position BEFORE move_played
move_played       TEXT               -- UCI
side_to_move      TEXT
clock_remaining   INTEGER            -- seconds, NULL if unavailable
PRIMARY KEY (game_id, ply)
```

Notes:
- chess.com PGNs carry clock annotations as `{[%clk 0:01:14.3]}` comments. Parse them. This data is load-bearing later and most tools throw it away.
- Strip the move counters from FEN before using it as a cache key (positions repeat across games with different move numbers).
- Handle variants: skip anything that isn't standard chess.

**Acceptance:** row counts sane, spot-check 3 games against the chess.com UI.

### Stage 3: Analyse

Build an engine evaluation cache keyed on position, not game.

`evals`:
```
fen_key       TEXT PRIMARY KEY   -- FEN with move counters stripped
nodes         INTEGER
eval_cp       INTEGER            -- from side-to-move POV, NULL if mate
mate_in       INTEGER            -- signed, NULL if not mate
best_move     TEXT               -- UCI
pv            TEXT[]             -- UCI list
```

Process:
1. `SELECT DISTINCT fen_key FROM positions` minus what's already in `evals`
2. Analyse each with Stockfish, write results
3. Resume cleanly if interrupted

Critical details:

- **Use fixed nodes, not depth or time.** `chess.engine.Limit(nodes=1_000_000)`. Reproducible across runs and hardware. Fixed time is non-deterministic; fixed depth explodes in tactical positions.
- **Pick one eval sign convention and enforce it everywhere.** Store from side-to-move POV. Convert at read time only. Sign flips are the single most common bug in homemade analysers — write a test that asserts a known winning-for-white position evaluates positive for white and negative for black.
- **Mate scores are not centipawns.** Store `mate_in` in its own column. Never mix mate into centipawn arithmetic.
- Configure `Threads` to cores-1 and `Hash` to a few GB.
- Use a worker pool of engine processes. Stockfish 18's shared-memory feature means multiple processes share NN weights — running N single-threaded processes is more efficient than one N-threaded process for batch throughput.
- Log progress. This runs for hours on a full history.

**Second pass, separate command:** re-analyse only positions flagged as critical by Stage 4 with `multipv=5`, stored in an `evals_multipv` table. Do not run MultiPV over everything — it triples cost for data you use on 5% of positions.

**Acceptance:** cache hit rate reported at the end. Expect 30-50% dedupe on a personal history. If it's near zero, the fen_key normalisation is broken.

### Stage 4: Review

Join evals onto games and classify.

#### Win probability

Convert centipawns to win probability before doing anything else. Use the Lichess formula:

```python
def win_pct(cp: int) -> float:
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)
```

**Classify on win% delta, not centipawn delta.** A 300cp drop from +900 to +600 is irrelevant. A 100cp drop from +50 to -50 lost the game. This decision is the difference between a useful tool and a wall of meaningless labels.

Thresholds (tune these later against my own games):
- `blunder`: win% drop > 20
- `mistake`: 10-20
- `inaccuracy`: 5-10
- else: `ok`

#### Critical moment selection

Do not report every flagged move. Rank by win% swing and take the top 3-5 per game, preferring moves that **cross a decision boundary** — winning→equal, equal→losing, drawn→lost. A game may legitimately have zero critical moments.

#### Fact extraction

For each critical move, build a `MoveFacts` dataclass. All fields deterministic, all testable:

| Field | How |
|---|---|
| `refutation` | first 3-5 plies of the PV from the position *after* the played move |
| `material_swing` | walk that PV, diff material at the end vs. start |
| `hung_pieces` | after the move, for each of my pieces: `board.is_attacked_by(them, sq)` combined with `board.see(capture)` to check the capture is actually good |
| `missed_mate` | best move was mate, played move was not |
| `allowed_mate` | opponent has mate after the played move, didn't before |
| `was_only_move` | MultiPV gap between move 1 and move 2 exceeds a threshold |
| `motif` | fork (opponent's reply attacks ≥2 higher-value pieces), pin (`board.is_pinned`), discovered attack, skewer |
| `is_forced` | `len(list(board.legal_moves)) == 1` — exclude these entirely, a forced move cannot be a mistake |
| `in_book` | matched against an ECO book; report the ply where I left theory |
| `clock_remaining` | from Stage 2 |
| `time_spent` | delta from previous clock reading for the same side |

Skip the first 8 plies by default unless the move is already a blunder.

#### Rendering

Format strings over `MoveFacts`. Examples of the target output:

> **Move 14. Nc6** — blunder, win% 52% → 18%
> This hangs the queen to `Bxf7+ Kxf7 Ng5+ Ke8 Qxd8`. `Be7` held the balance.
> Played with 14 seconds remaining.

> **Move 22. Rd1** — missed mate in 3
> `Qh6+` forces mate: `Qh6+ Kg8 Qg7#`.

Output a single static HTML file per game: board diagrams via `chess.svg` with arrows for played move (red) and best move (green), the critical moments in order, and an eval graph.

**Acceptance:** run it on 10 games I already understand well. If it flags moves I know were fine, or misses the blunder I remember losing to, the thresholds are wrong — not the engine. Report precision/recall against my own judgement.

## Stage 5: Aggregates (build this, it's the real payoff)

Once every position I've played is in a table with an eval attached, these are `GROUP BY` queries and no free tool offers them:

- Average win% bleed by ECO code and by ply range — which openings cost me most, and where
- Blunder rate bucketed by remaining clock time
- White vs. Black asymmetry in eval loss
- Endgame conversion rate by material configuration vs. expected from eval
- Blunder rate by time_class
- Rolling accuracy over time — am I actually improving

Emit as a single HTML report with tables and simple charts.

## Explicit non-goals

Do not build any of these. If you think one is necessary, stop and ask.

- LLM integration of any kind
- Interactive chessboard, move navigation, JS frontend framework
- Positional explanations ("your knight was misplaced") — tactics cover the large majority
- User accounts, hosting, deployment, Docker
- Real-time or on-demand analysis — everything is batch
- Lichess support (may come later; don't design for it now)

## Build order

Do not skip ahead. Each step ends with something runnable.

1. Stages 1-3 with CSV output and no classification. Just prove evals for the full history land on disk.
2. Win% conversion + classification. Eyeball the distribution across all games — if 40% of moves are "blunders", thresholds are wrong.
3. Critical moment selection. Verify against 10 known games.
4. Fact extraction, one field at a time, with unit tests using hand-picked FENs.
5. HTML rendering.
6. Aggregates.

Report back after step 1 before proceeding.

## Testing

- Unit tests for every fact extractor, using specific FENs with known answers
- A sign-convention test as described in Stage 3
- A golden-file test: one full game, committed expected output, catches regressions in classification
- No mocking of Stockfish in the fact-extraction tests — use real short analyses on fixed positions with fixed node counts, so they're deterministic
