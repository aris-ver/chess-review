"""Stage 4c: deterministic facts about a critical move, from engine output + board geometry.

Everything here is a pure function of (position, played move, evals, multipv).
No prose; see explain.py for the format strings.
"""

from dataclasses import dataclass, field
from typing import Optional

import chess

from .config import ONLY_MOVE_GAP
from .pov import pov_win_pct

VALUE = {chess.PAWN: 100, chess.KNIGHT: 300, chess.BISHOP: 300, chess.ROOK: 500, chess.QUEEN: 900, chess.KING: 10_000}
NAMES = {chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop", chess.ROOK: "rook", chess.QUEEN: "queen", chess.KING: "king"}
REFUTATION_PLIES = 5
GOOD = {"best", "excellent", "good", "great", "brilliant"}   # labels whose move gets its idea drawn (see idea_arrows)


@dataclass
class MoveFacts:
    game_id: str
    ply: int
    side: str                      # mover
    is_mine: bool
    san: str
    best_san: Optional[str]
    label: Optional[str]
    wp_before: Optional[float]
    wp_after: Optional[float]
    wp_loss: Optional[float]
    refutation: list[str] = field(default_factory=list)       # SAN, opponent's best line after the move
    refutation_uci: list[str] = field(default_factory=list)
    best_line: list[str] = field(default_factory=list)        # SAN, engine's line from before the move
    material_swing: Optional[int] = None                      # mover POV, centipawns, over the refutation
    hung_pieces: list[dict] = field(default_factory=list)     # [{piece, square, capture_san, see}]
    missed_mate: Optional[int] = None
    allowed_mate: Optional[int] = None
    was_only_move: Optional[bool] = None                      # best was the only move (MultiPV gap) and was missed
    motif: Optional[str] = None                               # fork | pin | discovered | skewer, on the reply
    motif_detail: Optional[str] = None
    idea: list[str] = field(default_factory=list)             # UCI arrows illustrating what a good move does
    clock_remaining: Optional[int] = None
    time_spent: Optional[int] = None


# --- board geometry -----------------------------------------------------------

def _least_valuable_attacker(board: chess.Board, colour: chess.Color, target: chess.Square) -> Optional[chess.Square]:
    best, best_val = None, None
    for sq in board.attackers(colour, target):
        if not board.is_legal(chess.Move(sq, target)):
            continue
        v = VALUE[board.piece_type_at(sq)]
        if best_val is None or v < best_val:
            best, best_val = sq, v
    return best


def see(board: chess.Board, move: chess.Move) -> int:
    """Static exchange evaluation of `move` (a capture) from the mover's POV, centipawns.

    Swap-off algorithm on a scratch board; making the captures for real means
    x-rays and pins fall out of legality checks instead of special cases.
    """
    b = board.copy(stack=False)
    target = move.to_square
    captured = b.piece_type_at(target)
    gain = [VALUE[captured] if captured else 0]
    on_target = VALUE[b.piece_type_at(move.from_square)]
    b.push(move)
    while True:
        atk = _least_valuable_attacker(b, b.turn, target)
        if atk is None:
            break
        gain.append(on_target - gain[-1])
        on_target = VALUE[b.piece_type_at(atk)]
        b.push(chess.Move(atk, target))
    for d in range(len(gain) - 2, -1, -1):
        gain[d] = -max(-gain[d], gain[d + 1])
    return gain[0]


def hung_pieces(board: chess.Board, victim: chess.Color) -> list[dict]:
    """Pieces of `victim` (not to move) that the side to move can win outright (SEE >= a pawn)."""
    assert board.turn != victim
    out = []
    for mv in board.legal_moves:
        if not board.is_capture(mv) or board.is_en_passant(mv):
            continue
        pt = board.piece_type_at(mv.to_square)
        if pt == chess.KING:
            continue
        s = see(board, mv)
        if s < 100:
            continue
        sq = chess.square_name(mv.to_square)
        existing = next((h for h in out if h["square"] == sq), None)
        if existing is None or s > existing["see"]:
            entry = {"piece": NAMES[pt], "square": sq, "capture_san": board.san(mv), "see": s}
            if existing:
                out.remove(existing)
            out.append(entry)
    out.sort(key=lambda h: -h["see"])
    return out


def material(board: chess.Board, colour: chess.Color) -> int:
    return sum(VALUE[pt] * len(board.pieces(pt, colour)) for pt in VALUE if pt != chess.KING)


def material_swing(board: chess.Board, pv_uci: list[str], pov: chess.Color) -> int:
    b = board.copy(stack=False)
    start = material(b, pov) - material(b, not pov)
    for u in pv_uci:
        mv = chess.Move.from_uci(u)
        if not b.is_legal(mv):
            break
        b.push(mv)
    return (material(b, pov) - material(b, not pov)) - start


def _ray_beyond(board: chess.Board, frm: chess.Square, through: chess.Square) -> Optional[chess.Square]:
    """Next occupied square continuing the line frm -> through, or None."""
    df = chess.square_file(through) - chess.square_file(frm)
    dr = chess.square_rank(through) - chess.square_rank(frm)
    if df == 0 and dr == 0:
        return None
    if not (df == 0 or dr == 0 or abs(df) == abs(dr)):
        return None
    step_f, step_r = (df > 0) - (df < 0), (dr > 0) - (dr < 0)
    f, r = chess.square_file(through) + step_f, chess.square_rank(through) + step_r
    while 0 <= f < 8 and 0 <= r < 8:
        sq = chess.square(f, r)
        if board.piece_at(sq):
            return sq
        f, r = f + step_f, r + step_r
    return None


def motif(board_after: chess.Board, reply: chess.Move) -> tuple[Optional[str], Optional[str]]:
    """Tactical pattern created by `reply` (the opponent's best move after the played move)."""
    victim = not board_after.turn        # the side that just moved
    attacker = board_after.turn
    if not board_after.is_legal(reply):
        return None, None
    b = board_after.copy(stack=False)
    b.push(reply)
    to = reply.to_square
    apt = b.piece_type_at(to)
    if apt is None:
        return None, None
    aval = VALUE[apt]
    victim_squares = chess.SquareSet(b.occupied_co[victim])
    attacked = b.attacks(to) & victim_squares

    # skewer: slider attacks a valuable piece with another victim piece behind it on the same ray
    if apt in (chess.BISHOP, chess.ROOK, chess.QUEEN):
        for sq in attacked:
            front = b.piece_type_at(sq)
            if front != chess.KING and VALUE[front] <= aval:
                continue
            behind = _ray_beyond(b, to, sq)
            if behind is not None and b.color_at(behind) == victim:
                back = b.piece_type_at(behind)
                if back != chess.PAWN and (front == chess.KING or VALUE[front] >= VALUE[back]):
                    return "skewer", f"skewers the {NAMES[front]} on {chess.square_name(sq)} against the {NAMES[back]} on {chess.square_name(behind)}"

    # fork: the moved piece attacks >= 2 victim pieces worth more than it (or the king, or undefended)
    targets = []
    for sq in attacked:
        pt = b.piece_type_at(sq)
        if pt == chess.KING or VALUE[pt] > aval or not b.is_attacked_by(victim, sq):
            targets.append(f"{NAMES[pt]} on {chess.square_name(sq)}")
    if len(targets) >= 2:
        return "fork", f"forks the {' and '.join(targets)}"

    # pin: a victim piece is newly pinned to its king
    for sq in victim_squares:
        if b.is_pinned(victim, sq) and not board_after.is_pinned(victim, sq):
            return "pin", f"pins the {NAMES[b.piece_type_at(sq)]} on {chess.square_name(sq)}"

    # discovered attack: a slider other than the moved piece now attacks something valuable it didn't before
    for sq in victim_squares:
        pt = b.piece_type_at(sq)
        if pt not in (chess.QUEEN, chess.ROOK, chess.KING):
            continue
        now = {a for a in b.attackers(attacker, sq) if a != to and b.piece_type_at(a) in (chess.BISHOP, chess.ROOK, chess.QUEEN)}
        before = set(board_after.attackers(attacker, sq))
        if now - before:
            a = next(iter(now - before))
            return "discovered", f"discovers an attack from the {NAMES[b.piece_type_at(a)]} on {chess.square_name(a)} onto the {NAMES[pt]} on {chess.square_name(sq)}"
    return None, None


def attack_targets(board: chess.Board, sq: chess.Square) -> list[chess.Square]:
    """Enemy pieces the piece on `sq` attacks and could profitably take: worth more than it, undefended, or the
    king. Most valuable first."""
    piece = board.piece_at(sq)
    if piece is None:
        return []
    enemy = not piece.color
    out = []
    for t in board.attacks(sq) & board.occupied_co[enemy]:
        pt = board.piece_type_at(t)
        if pt == chess.KING or VALUE[pt] > VALUE[piece.piece_type] or not board.is_attacked_by(enemy, t):
            out.append(t)
    out.sort(key=lambda t: -VALUE[board.piece_type_at(t)])
    return out


def idea_arrows(board: chess.Board, played: chess.Move, reply_pv: list[str]) -> list[str]:
    """What a good move does, as up to two arrows (UCI) -- chess.com's orange illustrations. The first that
    applies: the trade it starts, the pieces it attacks, the castling it makes possible, the pawn push the
    engine's line follows up with (only when the line really continues that way, and the move supports it).

    board: the position before the move; reply_pv: the engine's line from the position after it."""
    mover = board.turn
    b = board.copy(stack=False)
    b.push(played)
    to = played.to_square
    pv: list[chess.Move] = []
    walk = b.copy(stack=False)
    for u in reply_pv[:2]:      # the reply and our move after it, validated as we go
        try:
            m = chess.Move.from_uci(u)
        except ValueError:
            break
        if m not in walk.legal_moves:
            break
        pv.append(m)
        walk.push(m)

    # trade: the reply takes the moved piece, and we take back -- "Rd8+ Rxd8 Rxd8"
    if pv and pv[0].to_square == to and b.is_capture(pv[0]):
        out = [pv[0].uci()]
        if len(pv) > 1 and pv[1].to_square == to:
            out.append(pv[1].uci())
        return out

    # attacks: the moved piece hits something worth taking -- one arrow per target, a fork shows both prongs
    targets = attack_targets(b, to)
    if targets:
        return [chess.Move(to, t).uci() for t in targets[:2]]

    # castling: the move cleared the way (or the king is now allowed) on a side it couldn't castle before
    if b.has_castling_rights(mover):
        mine = b.copy(stack=False)
        mine.turn = mover
        before = set(board.generate_castling_moves())
        new = [m for m in mine.generate_castling_moves() if m not in before and mine.is_legal(m)]
        if new:
            return [new[0].uci()]

    # prepares: our next move in the line is a pawn push the moved piece supports, or that our move (not the
    # reply) made possible -- e.g. e6 and then ...d5, or a rook move that unblocks a pawn
    if len(pv) > 1:
        nxt = pv[1]
        after_reply = b.copy(stack=False)
        after_reply.push(pv[0])
        if nxt.from_square != to and after_reply.piece_type_at(nxt.from_square) == chess.PAWN and after_reply.color_at(nxt.from_square) == mover:
            supported = nxt.to_square in b.attacks(to)
            mine = b.copy(stack=False)
            mine.turn = mover
            new_option = nxt not in board.legal_moves and nxt in mine.legal_moves
            if supported or new_option:
                return [nxt.uci()]
    return []


# --- assembly -----------------------------------------------------------------

def _sans(board: chess.Board, pv_uci: list[str], limit: int) -> list[str]:
    b = board.copy(stack=False)
    out = []
    for u in pv_uci[:limit]:
        mv = chess.Move.from_uci(u)
        if not b.is_legal(mv):
            break
        out.append(b.san(mv))
        b.push(mv)
    return out


def extract(move: dict, board: chess.Board, eval_before: dict, eval_after: Optional[dict],
            multipv: Optional[list[dict]] = None) -> MoveFacts:
    """
    move:        row from moves.parquet
    board:       position BEFORE the move
    eval_before: evals row for that position (side-to-move POV = mover)
    eval_after:  evals row for the position after the move (side-to-move = opponent), or None
    multipv:     evals_multipv rows for the position before, or None
    """
    mover = board.turn
    played = chess.Move.from_uci(move["move_played"])
    board_after = board.copy(stack=False)
    board_after.push(played)

    f = MoveFacts(
        game_id=move["game_id"], ply=move["ply"], side=move["side_to_move"], is_mine=move["is_mine"],
        san=move["san"], best_san=move["best_san"], label=move["label"],
        wp_before=move["wp_before"], wp_after=move["wp_after"], wp_loss=move["wp_loss"],
        clock_remaining=move["clock_remaining"], time_spent=move["time_spent"],
    )
    f.best_line = _sans(board, eval_before.get("pv") or [], REFUTATION_PLIES)

    if eval_after:
        pv = eval_after.get("pv") or []
        f.refutation_uci = pv[:REFUTATION_PLIES]
        f.refutation = _sans(board_after, pv, REFUTATION_PLIES)
        f.material_swing = material_swing(board_after, pv[:REFUTATION_PLIES + 3], mover)
        if not board_after.is_game_over():
            f.hung_pieces = hung_pieces(board_after, mover)
        if pv:
            f.motif, f.motif_detail = motif(board_after, chess.Move.from_uci(pv[0]))
        if f.label in GOOD:
            f.idea = idea_arrows(board, played, pv)

        m0, m1 = eval_before.get("mate_in"), eval_after.get("mate_in")
        if m0 is not None and m0 > 0 and not (m1 is not None and m1 < 0):
            f.missed_mate = m0
        if m1 is not None and m1 > 0 and not (m0 is not None and m0 < 0):
            f.allowed_mate = m1

    if multipv:
        ranked = sorted(multipv, key=lambda r: r["rank"])
        if len(ranked) >= 2:
            side = move["side_to_move"]
            w1 = pov_win_pct(ranked[0]["eval_cp"], ranked[0]["mate_in"], side, side)
            w2 = pov_win_pct(ranked[1]["eval_cp"], ranked[1]["mate_in"], side, side)
            f.was_only_move = (w1 - w2 > ONLY_MOVE_GAP) and ranked[0]["move"] != move["move_played"]
        else:
            f.was_only_move = False
    return f
