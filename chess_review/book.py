"""Opening book from the lichess chess-openings TSVs (data/book/*.tsv, fetched once
by scripts/fetch_book.sh). Every position reachable along a book line counts as
"in book", so the ply where a game leaves theory is the first non-book position."""

import csv
import io
from functools import lru_cache

import chess
import chess.pgn

from .config import DATA
from .fen import fen_key

BOOK_DIR = DATA / "book"


@lru_cache(maxsize=1)
def load() -> dict[str, tuple[str, str]]:
    """fen_key -> (eco, name) for the deepest named line reaching that position."""
    book: dict[str, tuple[str, str]] = {}
    depth: dict[str, int] = {}
    for tsv in sorted(BOOK_DIR.glob("*.tsv")):
        with open(tsv, encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh, delimiter="\t"):
                game = chess.pgn.read_game(io.StringIO(row["pgn"]))
                if game is None:
                    continue
                board = game.board()
                moves = list(game.mainline_moves())
                line_len = len(moves)
                for i, move in enumerate(moves):
                    board.push(move)
                    key = fen_key(board.fen())
                    # Name every prefix by the shortest line that is exactly this position,
                    # otherwise by the line that reaches it with fewest remaining moves.
                    remaining = line_len - (i + 1)
                    if key not in book or remaining < depth[key]:
                        book[key] = (row["eco"], row["name"])
                        depth[key] = remaining
    return book


def is_book(key: str) -> bool:
    return key in load()


def name_for(key: str) -> tuple[str, str] | None:
    return load().get(key)
