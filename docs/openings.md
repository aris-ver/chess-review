# Openings: your own lines

Drafted 2026-11-17. Phases 1 and 2 are built (the book tree, `js/core/opening-tree.js`, the explorer); phases 3 and 4
are still a plan.

## Goal

Learn openings from your own games, not from a course. Two parts, one tab:

- **Explorer**: walk the opening tree on a board. Each position shows its name, the book moves from there, and how
  your own games went from it.
- **Trainer**: find where you leave book and it costs you, then drill the book move until you play it, with
  spaced repetition. "You left book at move 6 of the Caro-Kann in 14 games. Here's the line."

A generic opening course is available everywhere. Built from your own deviations, it's a reason to use Blundr, and
it stays part of the review product.

## Principles

- **Your games first.** Every line in the trainer comes from a position you reached in a real game. The explorer's
  book is the map; your games are what's marked on it.
- **Offline.** The book ships with the app (the lichess chess-openings TSVs, CC0, already in `data/book`). No
  opening-explorer API at runtime: it would leak what the user studies, and it fails offline.
- **No theory prose.** Names, moves, engine evals and your own results only. Written explanations would have to be
  correct and original, and that's a content job, not a code job. Out of scope.
- **The record is the state**, as with puzzles and drills: what's due and how well a line is known are worked out
  from the attempts, never stored separately.
- **One page for both apps**, in the shared page.

## What the data already gives

- `games.eco`, `games.opening_name`: from the game's own headers (chess.com, lichess).
- `positions`: every position of every game with `fen_key` and `move_played`, analysed or not.
- `moves.in_book`, `moves.wp_loss`, `moves.label`: only for analysed games. Once a move leaves the book the game
  stays out of it (`classify.js`), so the first move with `in_book = false` is where the game left theory.
- `js/core/book.js`: the book as a set of `fen_key`s. It has no names and no next moves yet.
- The evals cache: `best_move` and MultiPV lines for every analysed position, so the deviation position of an
  analysed game already has an engine opinion on every book move.

What the book doesn't have: **how popular a move is**. The TSVs are about 3,800 named lines, not a weighted tree.
Book moves are therefore shown without percentages, ordered by engine eval where the cache has one.

## Book tree

`bookTree` in `js/desktop/book.js` makes `book_tree.json` from the TSVs; `scripts/build_web.js` and
`js/desktop/build.js` write it next to `book_keys.txt` (the web build also puts it on the offline list):

```
{ "names": [["B12", "Caro-Kann Defense: Advance Variation"], ...],
  "pos": { "<fen_key>": [<index into names, or -1>, "c8f5 c6c5 ..."], ... } }
```

- The name is that of the shortest TSV line ending on the position. A position no line ends on takes the name of the
  last named position before it on the shortest line through it, so every book position has one; only the start
  position has none.
- The moves are every legal move into a book position, transpositions included, so they agree exactly with
  `isBook` and `in_book`. The ones more TSV lines play come first (a rough "main line first", since the book has no
  popularity), then the rest in UCI order.
- Measured: 7,855 positions (the 7,854 book keys and the start), 3,329 names, 800 KB raw, 124 KB gzipped. Built in
  about 4 s. The Worker compresses JSON, so it ships as it is.

`js/core/opening-tree.js` (+ test): `loadTree`, `nameOf(key)`, `bookMoves(key)`, `deviation(rows)`,
`deviationCost`, `lines(games)`, `target(key, multipv)`. Not `explore`: that name is taken by the "what if" sandbox
(`js/server/explore.js`).

At runtime the tree comes from `env.openingTree()`, loaded the first time an openings route asks and kept for good
(`js/server/openings.js` `ensureTree`): the desktop reads `book_tree.json` from app.asar (`paths.js` `BUNDLED.tree`),
or builds it from `DATA/book`'s TSVs in a checkout (`main.js` `loadOpeningTree`); the web worker fetches
`book_tree.json` (`site.tree` in `js/web/worker.js`, `env.openingTree` in `js/web/app.js`). Without a tree the routes
answer 503 `{reason: 'no_tree'}` and the page says so. On the web the service worker still downloads the file with
the rest of the offline list at install; the app's worker only reads and parses it when the tab first asks.

Checked on the main profile (448 games): `deviation()` agrees with `moves.in_book` in 445 of 446 analysed games. The
one that differs was reviewed against an older lichess book; the packaged book and `data/book` are the same.
`lines()` takes about 10 ms; reading the positions about 650 ms.

## Explorer

Built in phase 2 as specified below, with these specifics:

- **Page routes**: `#/p/<profile>/openings[?m=e2e4,e7e5[&ply=N]][&c=white|black]` is the explorer on that line (UCI,
  from the start), at ply N when not the line's end, with the colour filter when not both. The address follows every
  move and colour change in place (`location.replace`, no history entry; `route()` does nothing when the address
  already matches the explorer on screen), so Back, Settings and back, and a reload land on the same line and move.
  Back at the exact address it was left at also brings back the games list that was open. The Train tile "Openings"
  opens the profile used last (else the first on Home, never the pasted games') where the explorer was last left, for
  that profile. Back from the explorer goes where it was opened from; Back from a game opened from it says
  "Openings" and returns to it. A pasted game's Explore link opens the pasted games' profile, which the profile
  picker then lists.
- **Deep link into a review**: `#/p/<profile>/game/<id>?ply=N` opens the review at ply N. The explorer's games list
  uses it to land on the position after the move clicked. A saved review position (`state.resume`) wins over it.
- **Server routes** (`js/server/routes-openings.js`, the counts in `js/server/openings.js`):
  - `GET /api/openings/position?profile=<id>&moves=<uci,...>[&colour=all|white|black]`:
    `{path, fen, key, turn, in_book, left_at, name, eval, games, score, next}`, `next` being one row per move (book
    moves and every move the profile's games played), with games, W/D/L, accuracy and eval.
  - `GET /api/openings/games?profile=<id>&moves=<uci,...>[&move=<uci>][&colour=...]`: the games that reached the
    position (and played `move` there), newest first, at most 200, each with the ply to open the review at.
  - 400 for a bad profile id, move or colour; 404 for a missing profile; 503 with no tree.
- **Page**: the review board and move list in an `openings` body mode; the coach bubble names the position; `#opbox`
  in the review panel holds the colour filter, the profile picker (with more than one profile) and the move table.
  Each position's numbers are cached for the visit and asked again on the next visit.
- **From a review**: the overview's "left the book with ..." line has an "Explore" link to the position the game
  left the book from (games from the standard start only).

- **Board and move list**, starting from the start position. Play a move or click one in the list.
- **Header**: ECO and name of the current position, or "Out of book" with the last book position's name.
- **Next moves**: a list with one row per move. Every book move is listed, plus every move you or your opponents
  played from here, so you see where your games left the tree. Columns:
  - the move, marked "book" or not
  - your games: how many reached here and played this move, and your score from them (W/D/L)
  - your average accuracy over the next 10 of your moves, when those games are analysed
  - the engine eval after the move, when the cache has it; empty otherwise (no search is started just to fill it)
- **Your colour** toggle: games as white, games as black, or both. Your moves and your opponents' are counted
  separately; the side to move tells which.
- **Clicking a game count** lists those games; each opens its review at that ply.
- **Start from a game**: from a review's opening section, "Open in explorer" jumps to the position the game left
  book.

All counts come from one query over `positions` joined to `games` (and `moves` for accuracy), grouped by `fen_key`
and `move_played`. Fine at a few thousand games; check the time on the web build with the largest profile, and add
an index on `positions(fen_key)` if it's slow.

## Trainer

### Finding lines

For every game, the **deviation** is the first position where the move played isn't a book move from the book tree
(`bookMoves(key)` doesn't contain it), computed from `positions`, so unanalysed games count too. It belongs to you
when you played that move.

- Deviations are grouped by `fen_key`, so transpositions merge.
- A position where the book has no move left isn't a deviation: the book just ends there.
- A group becomes a **line** when you deviated there in at least 2 games, or once with a cost (below).
- **Cost** of a deviation, for analysed games: the deviating move's own `wp_loss`. A line whose average is under 3
  points isn't a problem: you chose a fine sideline. Those lines are kept but listed last and not dealt as drills
  until you choose them. (The first draft summed your next 5 moves. On the main profile that came to about 37 for
  any line, since out-of-book moves lose 7.4 points each on average, so it measured the middlegame, not the
  opening. With the move's own loss, 32 of the 64 lines are minor.)
- **Rank**: games x average cost, with unanalysed games counted at the average cost of the analysed ones in the
  group (or 0 when none is analysed).
- Opponents' deviations (how to punish them) are v2.

### The move to learn

At the deviation position, the **target** is:

- the book move the cache's MultiPV (3 lines) ranks highest;
- when none of its 3 lines is a book move, the engine's first move, and the card says "not a book move". The TSVs
  name dubious lines too (1. e4 e5 2. Nf3 f5, 2. Qh5 Nh6, 1. d4 Nf6 2. d5 Ng8): 13 of the main profile's 64 lines
  are like that, and drilling the book's move there would teach a bad one;
- with no MultiPV at all, the main book move, and the card says "not checked by the engine".

Games where you played the target aren't a problem, even when it's not a book move. Phase 3 leaves them out of the
line's cost and count (the QGA McDonnell line on the main profile: 4. Nf3 in 2 of its 5 games is the engine's move).

### A drill

- The board starts at the start position, from your side. The opponent's moves are played for you, from the line
  your games took to the deviation (the most common one, when the group has several).
- You play your side's moves. A move that isn't the game's line or another book move is wrong; at the deviation
  position, anything but the target is wrong.
- **Wrong**: the board shows the right move, you play it, and the attempt counts as a miss.
- **Speed-up**: once a line has been solved twice, the drill starts 4 plies before the deviation; the earlier moves
  are played out quickly so the position still comes in its order.
- After the target: "Done", the line's name, and the next 3 book plies to show where the line goes. No deeper.

### Schedule

Leitner boxes, from the record: a solve moves the line up one box, a miss sends it back to box 1. Due after
1, 3, 7, 21 and 60 days. Box 5 solved means **known**. The home Train row shows "N lines due".

**Known in real games**: when a newly imported game reaches a line's deviation position and you play the target,
the line moves up a box and the card says "Played it right in a real game". That's the result the whole feature is
for, and it's the number to watch.

### Storage

- `opening_attempts` in the **profile's** `games.sqlite` (lines come from one player's games, so they belong to the
  profile, unlike `drill_attempts`): `{id, ts, fen_key, target, solved, ms, source}`, `source` being `drill` or
  `game` (the game_id of a real-game hit).
- Schema version 6 with an UPGRADES step. Synced as the own-puzzle record is.
- Lines aren't stored: they're computed from the games each time the tab opens. Measure; cache in memory per
  profile if it's slow.

## Files

| File | What |
|------|------|
| `js/desktop/book.js`, `scripts/build_web.js`, `js/desktop/build.js` | `book_tree.json` |
| `js/core/opening-tree.js` (+ test) | names, book moves, deviations, cost, target; the Leitner schedule (phase 3) |
| `js/server/openings.js`, `routes-openings.js` (+ tests) | explorer counts, lines, record, due; modelled on drills.js |
| `js/server/db.js`, `sync.js` | `opening_attempts`, schema 6 |
| `chess_review/static/index.html` | "Openings" card in Train, explorer, trainer, "Open in explorer" in the review |
| packaging and web deploy | ship `book_tree.json` |

No Python version, so no parity tests.

## Phases (one session each, committed at the end of each)

1. Done 2026-11-17. Book tree and `opening-tree.js`: the build, names, next moves, the deviation finder, cost,
   target, tests.
2. Done 2026-11-18. Explorer: routes, the counts query, the page, the review's "Explore" link, the `?ply=` deep
   link. Web and desktop, phone layout.
3. Trainer storage and logic: schema 6, sync, lines, target, schedule, real-game hits, routes.
4. Trainer page: the line list, the drill board, the "done" screen, the Train row's due count. Phone layout.
5. v2, if phase 4 gets used: opponents' deviations, a repertoire you choose by hand.

## Open decisions

- Drill from move 1 every time, or always from near the deviation? The plan starts at move 1 and shortens after two
  solves; check by playing whether the early moves get boring.
- When your games took several move orders to one deviation, drill the most common or each in turn? The plan says
  the most common.

## Risks

- **The book's depth is uneven.** Some lines run 20 moves, others stop at 4. A shallow line makes a fine move look
  like a deviation; the cost filter covers most of that. Check the top 20 lines of the main profile by hand before
  phase 4.
- **Cost depends on the review's node count.** Fast-mode reviews give noisier `wp_loss`. Acceptable for ranking.
- **Look**: lichess and chess.com both have explorers and opening trainers. The ideas are fine; use our own layout
  and wording, copy neither, and keep clear of chess.com's look.
