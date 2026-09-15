# chess-review

Local, offline chess.com game review: Stockfish evals cached per position in DuckDB/Parquet,
deterministic plain-English explanations, a static chess.com-style review UI. No LLM anywhere.
Design: `chess-review-spec.md`.

## Daily use

```
bash scripts/restart_server.sh          # http://127.0.0.1:8123/  (log: data/serve.log)
```

The home screen lists **profiles** (one per chess.com user; add any username, remove with ✕) plus
placeholders for PGN / FEN / board-setup analysis. Open a profile → its games; open a game → **Analyse game**
(≈1-2 min for a rapid game: MultiPV=3, 1M nodes/position, 6 engines). The board, graph, move list and key
moments fill in while it runs. **⟳ Refresh games** re-fetches the current month from chess.com; nothing is
analysed unless you ask — the **⚙ Auto-analyse** toggle in the header makes a refresh analyse the new games
too (off by default, remembered in the browser). `scripts/restart_server.sh --nodes 500000` halves analysis time.

Data layout: everything belonging to one player is in `data/profiles/<source>-<username>/` (raw archives,
parquet tables, review JSON, insights); the Stockfish cache `data/evals.duckdb` is shared across profiles
because it is keyed by position, so players in the same openings reuse each other's engine work. A pre-profiles
`data/` layout is migrated automatically on the next server start or CLI run.

In the review: ← → step (buttons grey out at the ends), space jumps between key moments, click a count in the
summary to step through that side's moves of that kind, and **click (or drag) a piece to a target square to try a
different move** — it is evaluated on the spot (`explore.py`, one multi-threaded engine, ~1 s) and shown as a
variation under the move it branches from; stepping back before the branch discards it.
`index.html?selftest=1#/game/<id>` runs an in-page smoke test of navigation + exploration.

Pieces and badge icons: the page uses `data/site/assets/pieces/{w,b}{p,n,b,r,q,k}.png` and
`data/site/assets/icons/<classification>.svg` when present (`bash scripts/install_assets.sh <icons> [pieces]`),
otherwise the built-in cburnett pieces and inline badges. The single config is `ASSETS` at the top of
`static/index.html`. **chess.com's piece and icon files are proprietary — local personal use only**; before
exposing the page beyond localhost swap in Lichess pieces (github.com/lichess-org/lila, free licence) and
your own icons. `data/` is gitignored, so they never enter the repo. The arrow geometry is an independent
reimplementation.

Sounds: `bash scripts/fetch_sounds.sh` pulls chess.com's default sound set into `data/site/sounds/` (personal use,
gitignored). The brilliant-move stinger is not served publicly by chess.com: save it from your browser's
DevTools (Network → Media, while a review plays one) as `data/site/sounds/brilliant.mp3` or `.webm` and it is picked up automatically.

Docker / VM: see `deploy/DOCKER.md` (`docker compose up -d`, state in `./data`, expose via Tailscale).

## Pipeline (CLI)

```
source .venv/bin/activate
python -m chess_review ingest    --username <me>       # 1  creates profile chesscom-<me>; chess.com archives -> its raw/*.json (skips months on disk; --refresh-latest)
python -m chess_review ingest    --pgn-file game.pgn   #    or a pasted PGN -> the profile's pgn/<hash>.pgn
python -m chess_review normalise                       # 2  -> games.parquet, positions.parquet in the profile dir
python -m chess_review analyse   [--workers 6] [--nodes 1000000] [--limit N]   # 3  batch: every pending position -> data/evals.duckdb (shared)
python -m chess_review review                          # 4  classify -> site -> aggregates
python -m chess_review serve   [--port 8123] [--nodes N]                       #    server + on-demand analysis API
python -m pytest                                       #    33 tests, some use the real engine
```

Every stage takes `--profile <id>`; with exactly one profile it is the default. Individual stage 4 steps:
`classify`, `site`, `aggregates`. `export` dumps step-1 CSVs.
Server API: `GET /api/profiles`, `POST /api/profiles`, `POST /api/profiles/<id>/delete`, `GET /api/status`,
`POST /api/p/<id>/analyse/<game>`, `POST /api/p/<id>/refresh` (`{"analyse": true}` to analyse the new games),
`POST /api/stop`; profile files are served under `/p/<id>/`.

## Layout

| module | role |
|---|---|
| `ingest.py` | serial chess.com API fetch (429 backoff, UA required, no `python-requests` in the UA or Cloudflare 403s) |
| `normalise.py` | PGN -> `games` / `positions` (clock annotations parsed; variants skipped; terminal row per game) |
| `analyse.py` | worker pool of single-threaded Stockfish processes, fixed nodes, hash cleared per search, MultiPV=3; resumable cache; `Analyser` = persistent pool for the server |
| `pov.py` | **the only place eval signs are flipped**; win% formula; mate never enters cp arithmetic |
| `book.py` | lichess `chess-openings` TSVs (`scripts/fetch_book.sh`) -> set of book positions |
| `classify.py` | win%-delta labels per move -> `moves.parquet` (brilliant / great / best / excellent / good / book / forced / inaccuracy / mistake / miss / blunder; definitions in the module docstring) |
| `critical.py` | top 3-5 decisive moves per game (boundary crossings first), selected live by `site.py` |
| `facts.py` | `MoveFacts`: refutation, SEE-based hung pieces, material swing, missed/allowed mate, only-move, fork/pin/skewer/discovered |
| `explain.py` | format strings over `MoveFacts` |
| `site.py` + `static/index.html` | static review site: game list, board, arrows, eval bar/graph, move list, key moments |
| `aggregates.py` | GROUP BY insights -> `site/insights.html` |
| `serve.py` | stdlib server: static site + JSON API, one background job at a time (analyse a game / all games / refresh / fetch a new profile) |
| `profiles.py` | `Profile` = per-player paths under `data/profiles/<id>/`; create/list/delete; legacy layout migration |
| `explore.py` | on-the-spot evaluation + classification of a move made on the board (memory cache only) |

## Conventions

- `evals.eval_cp` / `evals.mate_in` are **side-to-move POV**. Convert at read time only, via `pov.py`.
- `mate_in`: +N side to move mates in N, -N gets mated, 0 = already checkmated.
- `positions.clock_remaining` is the mover's clock **after** the move (the `[%clk]` on that move); `time_spent` is derived.
- `positions` has a terminal row per game with `move_played = NULL` so the last move has an "after" eval.
- Thresholds live in `config.py` (`BLUNDER`/`MISTAKE`/`INACCURACY` win%, `ONLY_MOVE_GAP`, `OPENING_SKIP_PLIES`, `CRITICAL_MAX`).
- Accuracy is lichess's game formula (`accuracy.py`): half harmonic mean, half volatility-weighted mean of per-move accuracies, book moves excluded. It lands within ~5-10 points of chess.com's unpublished CAPS2, usually above it.
- Material floor (`CP_MISTAKE`/`CP_BLUNDER`): a move that hangs material per SEE and drops the eval that much is at least a mistake/blunder even in a won position, where win% alone would call it "good".
- Stockfish 18 segfaults on a few rare positions (e.g. `3k4/4r3/8/8/8/8/3Q4/3K4 w`); engines are restarted and the position retried with fewer nodes (`CRASH_RETRY_NODES`), then stored without an eval.
- Golden file: `tests/golden/clocks.json`; regenerate with `UPDATE_GOLDEN=1 pytest tests/test_golden.py` after intentional changes.

## Operational notes

- Long runs in WSL: `setsid nohup python -m chess_review analyse > data/analyse.log 2>&1 < /dev/null & disown` — plain `nohup` children still get SIGHUP when the terminal session closes.
- Whoever is analysing (CLI batch or the server's job) holds the DuckDB write lock; readers fall back to `data/evals.parquet`, refreshed at the end of each job. The server only holds the lock while a job runs.
- Memory: the server idles at ~100 MB; engines add ~64 MB hash + ~100 MB net per worker while analysing and are shut down after `ENGINE_IDLE_SECONDS` (10 min) without work. `scripts/mem.sh` shows what is using WSL's memory.
- Throughput on a 6-core laptop: ~1.6-2 positions/s at 1M nodes with 6 workers (one per physical core; hyperthreads hurt).
