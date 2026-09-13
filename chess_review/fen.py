import chess


def fen_key(fen: str) -> str:
    """FEN with halfmove clock and fullmove number stripped.

    Positions repeat across games at different move numbers; the engine
    evaluation does not depend on the counters, so the cache must not either.
    """
    return " ".join(fen.split()[:4])


def board_from_key(key: str) -> chess.Board:
    return chess.Board(key + " 0 1")
