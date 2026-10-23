# chess-review

Chess.com and lichess game review: Stockfish evals cached per position in DuckDB/Parquet,
deterministic plain-English explanations, a chess.com-style review UI, and puzzles. No LLM anywhere.
It ships two ways from the one `main` branch, with the same page (`chess_review/static/index.html`) in both:
the Windows app, and **Blundr** at [blundr.gr](https://blundr.gr), the same app running in the browser.
The original build spec is kept in `docs/original-spec.md`.

## Using it

**Blundr (web):** open [blundr.gr](https://blundr.gr). Python runs in the browser (Pyodide) and Stockfish as
WebAssembly; reviews and the engine cache stay in the browser. An optional account syncs puzzle progress and the
profile list across browsers and the desktop app. See *Blundr* below.

**Windows app:** [latest release](https://github.com/aris-ver/chess-review/releases/latest) → `Blundr-windows.zip`,
unzip anywhere, run `Blundr.exe` (details under *Windows app* below). From a checkout, the same server runs as

```
bash scripts/restart_server.sh          # http://127.0.0.1:8123/  (log: data/serve.log)
```

The home screen leads with the **profile list** (one per chess.com or lichess user; **+ Add profile** in its
heading opens the username form, ✕ removes one), pinnable (★) so favourites stay on top in the order they were
pinned. Below it come the two **Puzzles** tiles, then a row of small buttons for one-off reviews: **Paste a PGN**
(opens a box for it; the game lands in a "Pasted games" profile and opens at once), **Set up a position**
(chess.com-style editor: piece palette with undo/redo/eraser, side to move, castling rights, an editable FEN box)
and **From a screenshot** (drop, paste or link a picture of a board; the 8×8 grid is found and every square
classified against the app's piece silhouettes, in the browser, and the result opens in the editor for a check
before analysis). A position from the editor opens the **sandbox**: the engine's top 3
lines and best-move arrows update live as it searches. Open a profile → its games; any game
not fully analysed has an **Analyse** button right in the list; open a game → **Analyse game**
(≈1-2 min for a rapid game: MultiPV=3, 1M nodes/position, 6 engines). The board, graph, move list and key
moments fill in while it runs. **⟳ Refresh games** re-fetches the current month from chess.com; nothing is
analysed unless you ask. On launch the server also asks chess.com, in the background,
whether each saved profile has games newer than what's on disk; the home screen's profile card shows *N new
games* until you open it or refresh. `scripts/restart_server.sh --nodes 500000` halves analysis time.

Data layout: everything belonging to one player is in `data/profiles/<source>-<username>/` (raw archives,
parquet tables, review JSON, insights); the Stockfish cache `data/evals.duckdb` is shared across profiles
because it is keyed by position, so players in the same openings reuse each other's engine work. A pre-profiles
`data/` layout is migrated automatically on the next server start or CLI run.

In the review: ← → step (buttons grey out at the ends), space jumps between key moments, click a count in the
summary to step through that side's moves of that kind, and **click (or drag) a piece to a target square to try a
different move** — it is evaluated on the spot (`explore.py`, one multi-threaded engine, ~1 s) and shown as a
variation under the move it branches from; stepping back before the branch discards it.
`index.html?selftest=1#/game/<id>` runs an in-page smoke test of navigation + exploration.

**Puzzles** come from two tiles on the home screen.

**Puzzle library** (`#/puzzles`): about 28,000 rated puzzles from the Lichess puzzle database (CC0),
shipped in `chess_review/puzzle_packs/lichess.parquet` and picked within ±150 of your puzzle rating, never one
you've tried. The opponent's move plays first, then you find the answer. A wrong move is shown and taken back, and
you can keep trying. Only the first try counts (a hint or the solution counts as not solved): it lands in
`data/puzzle_attempts.jsonl` and the rating (Glicko-1) is replayed from that file (`puzzles.py`). The rating is
not shown anywhere; it only picks puzzles near your level. Once a puzzle is over, an end card offers the next one
(or Retry / Show the solution after a miss), and closing it leaves the board free to explore like a review. Pick a
theme (fork, mate in 2, rook endgame, …) under the buttons. `python scripts/build_puzzle_pack.py
lichess_db_puzzle.csv.zst` rebuilds the library from a fresh download.

**Puzzle packs** (`chess_review/puzzle_packs/packs.json`, built by `scripts/build_puzzle_packs.py`): themed packs
in stages of 20 puzzles, each a step harder than the last; solving 16 opens the next stage. No puzzle appears in two
packs. There is also a **puzzle of the day**.

**Personal puzzles** (`#/puzzles/mine`, `own_puzzles.py`): pick one of your profiles, or type any chess.com or
lichess username (a new profile, fetched the way **Add a profile** does it). The puzzles are the moves where the
player went wrong while level or better although MultiPV says one move clearly stood out, replayed from the
opponent's move before. The solution follows the engine's line for as long as each move in it is the only good
one; the line after it is there to step through with →, and **View in game** opens the review on the move that
was played. These stay out of the rating: every showing is logged in the profile's `puzzle_attempts.jsonl`, and
a miss comes back after 1, then 3, then 7 days (a miss starts it over); found first time or at the 7-day review,
it is learned. **Start the reviews over** on a profile's card archives that file the same way, and every puzzle
from its games is new again. It doesn't touch the library rating.

Puzzles come only from analysed games, so making them is a background job ("build", in `serve.py`). It fetches
the games of a new username, analyses the games that aren't analysed yet, newest first, and reclassifies the
profile after each game (at most every 20 s). The puzzles are playable as they appear. Then it settles their
lines. A bar pinned to the bottom of every screen shows its progress, with **Solve** and **Stop** (what is
analysed stays; carry on from the profile's card). A build can take hours, so it never makes you wait. Analysing
a game, refreshing or adding a profile stops it at the next position and gets every core, the bar says
"paused" while that runs, and the build carries on where it was once it's done. The other options were worse.
A plain queue would leave an Analyse click waiting behind hours of batch work. Sharing the cores would slow the
game you are looking at, for a job nobody is watching. An Analyse click while another game is being analysed now
waits its turn ("Queued") instead of being refused. Builds still to do are kept in `data/puzzle_builds.json` and
carry on after a restart. Exploring moves (a separate engine) and library puzzles work throughout.

Pieces, boards and sounds are Lichess's free sets — 35 piece sets, 25 boards, 5 sound packs — in
`chess_review/static/themes/` (`themes.json` lists them, `CREDITS.md` names each author and licence), synced into
the served site dir by `site.write_static()` on every start. The gear in the header picks them, with a preview
board and a play button per sound. `python scripts/import_lichess_themes.py <lila checkout>` refreshes them; it
skips everything lila's COPYING.md marks non-free (that includes Lichess's standard sound pack).

The classification badges are the app's own drawings (`ic-*` symbols in `static/index.html`): a rounded square in
the class colour with the annotation glyph. The arrow geometry is an independent reimplementation.

## Blundr

The web build: `python scripts/build_web.py` turns the same page and Python package into a static site in
`web-dist/` (Pyodide runs `chess_review` in a worker; `web/` holds the browser-side glue), served by a Cloudflare
Worker (`worker/`) that also runs the optional accounts on an EU D1 database. **A push to `main` that touches the
site** (`chess_review/`, `web/`, `worker/`, `scripts/build_web.py`, `requirements.txt`) **deploys blundr.gr**
(`.github/workflows/deploy-web.yml`; D1 migrations only by hand), so work on a branch and merge when it's ready. Details:
`docs/web.md` (how it works, measurements, hosting) and `docs/accounts.md` (accounts, sync, deploy steps).

## Windows app

No Python, no install: the server plus a native window (pywebview over WebView2) and a bundled Stockfish. The first
launch shows a SmartScreen prompt — *More info → Run anyway*; a PC with Smart App Control **on** refuses unsigned apps
outright (the exe is not code-signed). Data goes to `%LOCALAPPDATA%\chess-review`; `app.log` there is where errors
land, the window has no console.

Building it: `powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1` from a Windows terminal
(`launcher.py` is the entry point, `packaging/chess-review.spec` the PyInstaller recipe; the script fetches Stockfish
and the opening book itself). `.github/workflows/windows-release.yml` does the same on a clean runner: push a tag
(`git tag -a v0.1.0 -m v0.1.0 && git push origin v0.1.0`) and the zips land on that tag's GitHub Release. Push a
release tag on its own: when more than three tags arrive in one push, GitHub starts no workflow. The release notes
are the commit subjects since the last tag, and the app shows them as "What's new"; when web-only commits would
crowd them, create the release as a draft with desktop-only notes right after pushing the tag (the workflow then
only uploads the zips) and publish it once both zips are attached.

**Updates** happen inside the app: the home screen checks the latest release once per launch (and on *Check for
updates* at the bottom) and offers a *Download update* → *Restart to update* banner. A release carries
`Blundr-windows.zip` (everything; `chess-review-windows.zip` is the same for updaters up to v0.6.0) and
`chess-review-update-<runtime>.zip` (the exe and the web UI, ~6 MB),
where `<runtime>` fingerprints the bundled Python/DLL layer (`packaging/pack.py`). An install whose fingerprint matches
takes the small zip; otherwise it downloads the full one and swaps its whole `_internal` folder. Either way a small
PowerShell script (`chess_review/updater.py`) waits for the app to exit, copies the files in and relaunches it;
what it did is in `%LOCALAPPDATA%\chess-review\update.log`. The fingerprint moves whenever the bundled runtime
changes, so build deps are pinned in `packaging/requirements-build.txt` — bump them deliberately, and expect the
release after a bump (or after CI's Python patch version moves) to be a full download.

## Pipeline (CLI)

```
source .venv/bin/activate
python -m chess_review ingest    --username <me>       # 1  creates profile chesscom-<me>; chess.com archives -> its raw/*.json (skips months on disk; --refresh-latest)
python -m chess_review ingest    --pgn-file game.pgn   #    or a pasted PGN -> the profile's pgn/<hash>.pgn
python -m chess_review normalise                       # 2  -> games.parquet, positions.parquet in the profile dir
python -m chess_review analyse   [--workers 6] [--nodes 1000000] [--limit N]   # 3  batch: every pending position -> data/evals.duckdb (shared)
python -m chess_review review                          # 4  classify -> site -> aggregates
python -m chess_review serve   [--port 8123] [--nodes N]                       #    server + on-demand analysis API
python -m pytest                                       #    some tests need the real engine or the opening book, and skip without them
```

Every stage takes `--profile <id>`; with exactly one profile it is the default. Individual stage 4 steps:
`classify`, `site`, `aggregates`. `export` dumps step-1 CSVs.
Server API: `GET /api/profiles`, `POST /api/profiles`, `POST /api/profiles/<id>/delete`, `POST /api/profiles/<id>/pin`, `GET /api/status`,
`POST /api/p/<id>/analyse/<game>`, `POST /api/p/<id>/refresh` (fetches only; nothing is analysed unless asked),
`POST /api/stop`; profile files are served under `/p/<id>/`. Position tools (no profile): `GET /api/legal?fen=`,
`POST /api/explore`, `GET /api/eval?fen=`, `GET /api/engine`, `POST /api/pgn`, `GET /api/fetch_image?url=`, and `GET /api/eval_stream?fen=&multipv=3` — NDJSON snapshots of the
engine's top lines as it searches, which is what the sandbox draws its live arrows and lines from.

A game can show as partly analysed without ever being asked for: the engine cache is shared by position, so an
opening already seen in another game is already evaluated (the Analyse button's tooltip says how much).

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
- Both apps run Stockfish 19.0.1 (`bin/` for the desktop, `STOCKFISH_VERSION` in `scripts/build_web.py` for the web): change them together, or reviews stop matching.
- Stockfish 18 segfaulted on a few rare positions (e.g. `3k4/4r3/8/8/8/8/3Q4/3K4 w`); engines are restarted and the position retried with fewer nodes (`CRASH_RETRY_NODES`), then stored without an eval.
- Golden file: `tests/golden/clocks.json`; regenerate with `UPDATE_GOLDEN=1 pytest tests/test_golden.py` after intentional changes.

## Operational notes

- Long runs in WSL: `setsid nohup python -m chess_review analyse > data/analyse.log 2>&1 < /dev/null & disown` — plain `nohup` children still get SIGHUP when the terminal session closes.
- Whoever is analysing (CLI batch or the server's job) holds the DuckDB write lock; readers fall back to `data/evals.parquet`, refreshed at the end of each job. The server only holds the lock while a job runs.
- Memory: the server idles at ~100 MB; engines add ~64 MB hash + ~100 MB net per worker while analysing and are shut down after `ENGINE_IDLE_SECONDS` (10 min) without work. `scripts/mem.sh` shows what is using WSL's memory.
- Throughput on a 6-core laptop: ~1.6-2 positions/s at 1M nodes with 6 workers (one per physical core; hyperthreads hurt).
