# chess-review

Chess.com and lichess game review: Stockfish evals cached per position in SQLite, deterministic plain-English
explanations, a chess.com-style review UI, and puzzles. No LLM anywhere. Plain JavaScript (ES modules, no build
step) under `js/`. It ships two ways from the one `main` branch, with the same page (`chess_review/static/index.html`)
in both: the Windows app (Electron), and **Blundr** at [blundr.gr](https://blundr.gr), the same app running in the
browser. The original build spec is kept in `docs/original-spec.md`; the app was Python until the port to JavaScript
(`docs/js-port.md`), and the last Python release is v0.7.0.

## Using it

**Blundr (web):** open [blundr.gr](https://blundr.gr). The app's server runs in the browser (a worker) and
Stockfish as WebAssembly; reviews and the engine cache stay in the browser. An optional account syncs puzzle progress
and the profile list across browsers and the desktop app. See *Blundr* below.

**Windows app:** [latest release](https://github.com/aris-ver/chess-review/releases/latest) → `Blundr-windows.zip`,
unzip anywhere, run `Blundr.exe` (details under *Windows app* below). From a checkout:

```
npm ci
bash scripts/fetch_book.sh      # the opening book, once
npm run desktop                 # the Electron app on the checkout's data/ (Stockfish from bin/ or $STOCKFISH)
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
(≈1-2 min for a rapid game on the desktop: MultiPV=3, 1M nodes/position, one engine per core). The board, graph,
move list and key moments fill in while it runs. **⟳ Refresh games** re-fetches the newest games; nothing is
analysed unless you ask. On launch the app also asks chess.com and lichess, in the background, whether each
saved profile has newer games than it holds, and fetches them as **⟳ Refresh games** would, one profile at a time
(a light sweeps along the bottom of its home-screen card meanwhile); new games are flagged in the list until opened.

Data layout (`js/server/db.js`): each player's games, positions and classified moves are in
`profiles/<source>-<username>/games.sqlite` under the data folder; the Stockfish cache `evals.sqlite` is shared
across profiles because it is keyed by position, so players in the same openings reuse each other's engine work;
puzzle progress is in `progress.sqlite`.

In the review: ← → step (buttons grey out at the ends), space jumps between key moments, click a count in the
summary to step through that side's moves of that kind, and **click (or drag) a piece to a target square to try a
different move** — it is evaluated on the spot (`js/server/explore.js`, one multi-threaded engine, ~1 s) and shown
as a variation under the move it branches from; stepping back before the branch discards it.
`index.html?selftest=1#/game/<id>` runs an in-page smoke test of navigation + exploration.

**Puzzles** come from two tiles on the home screen.

**Puzzle library** (`#/puzzles`): about 32,000 rated puzzles from the Lichess puzzle database (CC0),
shipped in `chess_review/puzzle_packs/puzzles.json` and picked within ±150 of your puzzle rating, never one
you've tried. The opponent's move plays first, then you find the answer. A wrong move is shown and taken back, and
you can keep trying. Only the first try counts (a hint or the solution counts as not solved), and the rating
(Glicko-1) is replayed from that record (`js/server/puzzles.js`). The rating is not shown anywhere; it only picks
puzzles near your level. Once a puzzle is over, an end card offers the next one (or Retry / Show the solution after a
miss), and closing it leaves the board free to explore like a review. Pick a theme (fork, mate in 2, rook endgame, …)
under the buttons. `python scripts/build_puzzle_pack.py lichess_db_puzzle.csv.zst` rebuilds the library from a fresh
download (a build tool; it needs pyarrow).

**Puzzle packs** (`chess_review/puzzle_packs/packs.json`, built by `scripts/build_puzzle_packs.py`): themed packs
in stages of 20 puzzles, each a step harder than the last; solving 16 opens the next stage. No puzzle appears in two
packs. There is also a **puzzle of the day**.

**Personal puzzles** (`#/puzzles/mine`, `js/server/own-puzzles.js`): pick one of your profiles, or type any
chess.com or lichess username (a new profile, fetched the way **Add a profile** does it). The puzzles are the moves
where the player went wrong while level or better although MultiPV says one move clearly stood out, replayed from the
opponent's move before. The solution follows the engine's line for as long as each move in it is the only good
one; the line after it is there to step through with →, and **View in game** opens the review on the move that
was played. These stay out of the rating: every showing is logged with the profile, and a miss comes back after 1,
then 3, then 7 days (a miss starts it over); found first time or at the 7-day review, it is learned. **Start the
reviews over** on a profile's card archives that record, and every puzzle from its games is new again. It doesn't
touch the library rating.

Puzzles come only from analysed games, so making them is a background job ("build", in `js/server/jobs.js` and
`routes-puzzles.js`). It fetches the games of a new username, analyses the games that aren't analysed yet, newest
first, and reclassifies the profile after each game (at most every 20 s). The puzzles are playable as they appear.
Then it settles their lines. A bar pinned to the bottom of every screen shows its progress, with **Solve** and
**Stop** (what is analysed stays; carry on from the profile's card). A build can take hours, so it never makes you
wait. Analysing a game, refreshing or adding a profile stops it at the next position and gets every core, the bar
says "paused" while that runs, and the build carries on where it was once it's done. The other options were worse.
A plain queue would leave an Analyse click waiting behind hours of batch work. Sharing the cores would slow the
game you are looking at, for a job nobody is watching. An Analyse click while another game is being analysed now
waits its turn ("Queued") instead of being refused. Builds still to do carry on after a restart. Exploring moves (a
separate engine) and library puzzles work throughout.

Pieces, boards and sounds are Lichess's free sets — 35 piece sets, 25 boards, 5 sound packs — in
`chess_review/static/themes/` (`themes.json` lists them, `CREDITS.md` names each author and licence), plus the app's
own sound packs from `chess_review/sound_packs/`. The gear in the header picks them, with a preview board and a play
button per sound. `python scripts/import_lichess_themes.py <lila checkout>` refreshes them; it skips everything
lila's COPYING.md marks non-free (that includes Lichess's standard sound pack).

The classification badges are the app's own drawings (`ic-*` symbols in `static/index.html`): a rounded square in
the class colour with the annotation glyph. The arrow geometry is an independent reimplementation.

## Blundr

The web build: `node scripts/build_web.js` (`npm run build:web`) turns the same page and `js/` into a static site in
`web-dist/` (the JS server runs in a worker, `js/web/worker.js`; `web/` holds the browser-side glue), served by a
Cloudflare Worker (`worker/`) that also runs the optional accounts on an EU D1 database. `--serve` serves it on
127.0.0.1:8200 after building. **A push to `main` that touches the site** (`chess_review/`, `js/`, `web/`, `worker/`,
`legacy/`, `scripts/build_web.js`) **deploys blundr.gr** (`.github/workflows/deploy-web.yml`; D1 migrations only by
hand), so work on a branch and merge when it's ready. Details: `docs/web.md` (how it works, measurements, hosting)
and `docs/accounts.md` (accounts, sync, deploy steps).

`legacy/` is the one Python left in the apps: the Python build's export, frozen, which a browser that still holds the
Python build's data loads once (with Pyodide from its CDN) to move it to SQLite (`js/web/legacy.js`).

## Windows app

No install: the app's server in Electron's Node with a bundled native Stockfish, and the page in one window
(`js/desktop/`, its README has the details). The first launch shows a SmartScreen prompt — *More info → Run anyway*;
a PC with Smart App Control **on** refuses unsigned apps outright (the exe is not code-signed). Data goes to
`%LOCALAPPDATA%\chess-review`; `app.log` there is where errors land.

Building it: `npm ci`, then `npm run build:windows` on Windows → `packaging/dist/Blundr-windows.zip` and
`blundr-app-<runtime>.asar` (it fetches Stockfish and the opening book itself). `.github/workflows/windows-release.yml`
does the same on a clean runner: push a `v1+` tag (`git tag -a v1.0.0 -m v1.0.0 && git push origin v1.0.0`) and the
files land on that tag's GitHub Release, with the bridge release's (v0.7.0) zips attached again for old Python
installs. Push a release tag on its own: when more than three tags arrive in one push, GitHub starts no workflow. The
release notes are the commit subjects since the last tag, and the app shows them as "What's new"; when web-only
commits would crowd them, create the release as a draft with desktop-only notes right after pushing the tag (the
workflow then only uploads the files) and publish it once they are all attached.

**Updates** happen inside the app: the home screen checks the latest release once per launch (and on *Check for
updates* at the bottom) and offers a *Download update* → *Restart to update* banner. An install whose Electron
version matches the release's takes the small `blundr-app-<runtime>.asar`; otherwise it downloads the full zip. A
small PowerShell script waits for the app to exit, swaps the files in and relaunches it; what it did is in
`%LOCALAPPDATA%\chess-review\update.log`. Details in `js/desktop/README.md`.

## Tests

```
npm test        # every js/**/*.test.js (Node >= 22.13)
```

Most replay `tests/parity/*.json` and `tests/golden/clocks.json`, what the Python app answered on the same inputs,
frozen now (`js/README.md`). Some need the real engine (`bin/stockfish`) or the opening book, and skip without them.
The browser end to end tests are Python with Playwright (`tests/test_web_browser.py`, `tests/test_web_shim.py`:
`pip install pytest playwright duckdb`, then `python -m pytest -q`); they build the site with Node first.

## Layout

| path | role |
|---|---|
| `js/core/` | no I/O: fen, pov, accuracy, critical, book, explain, facts, classify, evals (UCI `info` → MultiPV), normalise, config (the thresholds) |
| `js/server/` | the routes (`router.js`, `routes-*.js`), the job runner (`jobs.js`), the database (`db.js`), profiles, ingest (chess.com and lichess), site (review files), aggregates, explore, puzzles, packs, own puzzles, account and sync, the updater |
| `js/web/` | the browser: the worker, tabs sharing one leader, SQLite WASM in OPFS, the one-time move of the Python build's data |
| `js/desktop/` | Electron: the window, the HTTP server on 127.0.0.1, native Stockfish, the updater, the release build |
| `chess_review/static/` | the page (`index.html`, `account.js`, `themes/`), the same in both apps |
| `chess_review/puzzle_packs/`, `sound_packs/` | the puzzle library and packs; the app's own sound packs |
| `web/`, `worker/` | the browser glue (shim, engines, pages, icons); the Cloudflare Worker and the accounts |
| `legacy/` | the Python build's export, frozen, for the one-time move of old browser data |
| `scripts/` | build tools: `build_web.js`, `fetch_book.sh`, the vendoring scripts, and Python ones for the puzzle library and packs, the themes and the synthesized sounds |

## Conventions

- Stored evals (`eval_cp`, `mate_in`) are **side-to-move POV**. Convert at read time only, via `js/core/pov.js`.
- `mate_in`: +N side to move mates in N, -N gets mated, 0 = already checkmated.
- `positions.clock_remaining` is the mover's clock **after** the move (the `[%clk]` on that move); `time_spent` is derived.
- `positions` has a terminal row per game with `move_played = NULL` so the last move has an "after" eval.
- Thresholds live in `js/core/config.js` (`BLUNDER`/`MISTAKE`/`INACCURACY` win%, `ONLY_MOVE_GAP`, `OPENING_SKIP_PLIES`, `CRITICAL_MAX`).
- Accuracy is lichess's game formula (`js/core/accuracy.js`): half harmonic mean, half volatility-weighted mean of per-move accuracies, book moves excluded. It lands within ~5-10 points of chess.com's unpublished CAPS2, usually above it.
- Material floor (`CP_MISTAKE`/`CP_BLUNDER`): a move that hangs material per SEE and drops the eval that much is at least a mistake/blunder even in a won position, where win% alone would call it "good".
- Both apps run Stockfish 19.0.1 (`bin/` for the desktop, `STOCKFISH_VERSION` in `scripts/build_web.js` for the web): change them together, or reviews stop matching.
- Golden file: `tests/golden/clocks.json` (Stockfish 19), replayed by `js/core/classify.test.js`; after an intentional change to thresholds, facts or wording, update it with the change.
