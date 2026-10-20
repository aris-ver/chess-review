# Puzzle packs

`lichess.parquet` holds puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles),
which Lichess releases under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Every puzzle was mined
from a real Lichess game, checked with Stockfish and rated by the players who tried it.

`scripts/build_puzzle_pack.py` rebuilds the pack from a fresh download. It keeps puzzles with Popularity ≥ 85,
at least 500 plays and a rating deviation of 80 or less, sampled evenly across 100-point rating bands.
