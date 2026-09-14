"""Opening book from the lichess chess-openings TSVs (data/book/*.tsv, fetched once
by scripts/fetch_book.sh). Every position reachable along a book line counts as
"in book", so the ply where a game leaves theory is the first non-book position."""

import csv
import io
from functools import lru_cache

import chess.pgn

from .config import DATA
from .fen import fen_key

BOOK_DIR = DATA / "book"


@lru_cache(maxsize=1)
def load() -> frozenset[str]:
    keys: set[str] = set()
    for tsv in sorted(BOOK_DIR.glob("*.tsv")):
        with open(tsv, encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh, delimiter="\t"):
                game = chess.pgn.read_game(io.StringIO(row["pgn"]))
                if game is None:
                    continue
                board = game.board()
                for move in game.mainline_moves():
                    board.push(move)
                    keys.add(fen_key(board.fen()))
    return frozenset(keys)


def is_book(key: str) -> bool:
    return key in load()
