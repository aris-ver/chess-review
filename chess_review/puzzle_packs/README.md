# Puzzle packs

`puzzles.json` holds puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles),
which Lichess releases under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Every puzzle was mined
from a real Lichess game, checked with Stockfish and rated by the players who tried it.

`scripts/build_puzzle_pack.py` rebuilds the library from a fresh download. It keeps puzzles with Popularity ≥ 85,
at least 500 plays and a rating deviation of 80 or less, sampled evenly across 100-point rating bands, plus every
puzzle the packs use.

`packs.json` freezes the puzzle packs and the list the puzzle of the day is drawn from, so they are the same on every
machine. Each pack is a theme laid out as stages of 20, each about 200 rating points above the last, ten at most.
`scripts/build_puzzle_packs.py lichess_db_puzzle.csv.zst` picks them from the whole database: a puzzle sits in one
pack only, the best-liked and most-played first, with limits on how much a stage may repeat itself (see
`scripts/pack_rules.py`), and adds the puzzles it picks to `puzzles.json`. It keeps the daily list as it is.
