"""Stage 4a: join evals onto positions and classify every move -> data/moves.parquet.

Classification is on WIN% loss from the mover's point of view, never on
centipawns. win% before = eval of the position the mover faced; win% after =
eval of the position they left the opponent, re-signed to the mover.

The labels grade that loss on a curve that depends on the mover's rating (grade_k): at club level a +5 position
is not yet won, so chess.com still calls a move there that throws 2-3 pawns away a mistake, while at 2800+ a
0.3-pawn slip at equality is already an inaccuracy. The curve and the thresholds were fitted together on
docs/chesscom-review. wp_before/wp_after/wp_loss, and so the graph, accuracy and key moments, stay on the Lichess
curve.

Labels (chess.com vocabulary, deterministic definitions):
  book        resulting position is in the opening book
  forced      only legal move
  brilliant   engine-approved sacrifice (SEE says the piece can be won) that the engine's line doesn't
              win straight back, and that isn't already a crush
  great       the engine's move and the only good one (MultiPV #1 - #2 > ONLY_MOVE_GAP), unless it is a
              recapture: taking back on the square the opponent just took on is the only move but no find
  best        the engine's move, or one its eval says loses nothing (the engine merely ranked another first)
  excellent   loss <= EXCELLENT
  good        loss <= GOOD
  inaccuracy  loss <= MISTAKE
  mistake     loss <= BLUNDER
  miss        a missed chance: the opponent just erred (or a forced mate was on) and the move, a mistake
              or worse, didn't punish it. The mover wasn't losing before it (>= MISS_BEFORE_MIN) and isn't
              lost after it (>= MISS_AFTER_MIN): a move that throws the game away stays a blunder.
              Fitted to chess.com's own labels on docs/chesscom-review (48 misses in 616 plies). Not playing
              a mate in 1 is always a miss.
  blunder     loss > BLUNDER

Material floor: win% barely moves in a decided position, so a move that hangs
material (per SEE) and drops the eval by CP_MISTAKE / CP_BLUNDER centipawns is
at least a mistake / blunder even at +10. Engine-approved sacrifices don't drop
the eval, so they are unaffected. A side already losing (LOSING_MATERIAL_CP) that
gives away a piece's worth more is a mistake too; a winning side handing material
back is simplifying, and chess.com lets that be.

Mate: a mate against is no worse than "lost" when the mover was lost already, so allowing one from there is an
inaccuracy (mate in 4 or more) or a mistake (mate in 1-3) rather than a blunder, and walking into a faster mate
than the one already coming is an inaccuracy (as chess.com grades them).
"""

import argparse
import logging
import math
from typing import Optional

import chess
import pyarrow as pa
import pyarrow.parquet as pq

from . import book
from .accuracy import move_accuracy
from .config import (
    BLUNDER,
    CP_BLUNDER,
    CP_MISTAKE,
    EXCELLENT,
    GRADE_DEFAULT_RATING,
    GRADE_K_HIGH,
    GRADE_K_LOW,
    GRADE_RATING_HIGH,
    GRADE_RATING_LOW,
    INACCURACY,
    LOSING_MATERIAL_CP,
    MATE_FROM_LOST_CP,
    MATERIAL_MISTAKE,
    MISS_AFTER_MIN,
    MISS_BEFORE_MIN,
    MISTAKE,
    ONLY_MOVE_GAP,
)
from . import profiles
from .db import connect
from .profiles import Profile
from .facts import material_swing, see
from .fen import fen_key
from .pov import pov_win_pct

log = logging.getLogger("classify")
SACRIFICE_PLIES = 8     # how far along the engine's line a sacrifice has to stay a sacrifice to be brilliant

SCHEMA = pa.schema([
    ("game_id", pa.string()),
    ("ply", pa.int32()),
    ("side_to_move", pa.string()),
    ("is_mine", pa.bool_()),
    ("move_played", pa.string()),
    ("san", pa.string()),
    ("best_move", pa.string()),
    ("best_san", pa.string()),
    ("n_legal", pa.int32()),
    ("is_forced", pa.bool_()),
    ("in_book", pa.bool_()),
    ("wp_before", pa.float64()),      # mover POV, 0-100
    ("wp_after", pa.float64()),
    ("wp_loss", pa.float64()),        # max(0, before - after)
    ("accuracy", pa.float64()),       # lichess per-move accuracy, 0-100
    ("label", pa.string()),
    ("only_move", pa.bool_()),        # MultiPV says #1 was the only good move (NULL without MultiPV)
    ("clock_remaining", pa.int32()),
    ("time_spent", pa.int32()),
])


def label_for(wp_loss: float) -> str:
    """Loss-only label, for moves that are not the engine's choice."""
    if wp_loss > BLUNDER:
        return "blunder"
    if wp_loss > MISTAKE:
        return "mistake"
    if wp_loss > INACCURACY:
        return "inaccuracy"
    if wp_loss > EXCELLENT:
        return "good"
    return "excellent"


def is_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    """The moved piece (knight or better) can be won by the opponent per SEE, or the
    move is a capture that loses material per SEE."""
    pt = board.piece_type_at(move.from_square)
    if pt in (None, chess.PAWN, chess.KING):
        return False
    if board.is_capture(move):
        # a recapture/trade is not a sacrifice; only a net loss on the exchange is
        return see(board, move) <= -200
    after = board.copy(stack=False)
    after.push(move)
    if after.is_game_over():
        return False
    best = 0
    for cap in after.legal_moves:
        if cap.to_square == move.to_square and after.is_capture(cap):
            best = max(best, see(after, cap))
    return best >= 100


def sacrifice_holds(board_after: chess.Board, reply_pv: list[str], mover: chess.Color, reply_mate: Optional[int]) -> bool:
    """A sacrifice is only one if the material stays given: over the engine's line after the move the mover is
    still down at least a pawn, or the line ends in mate. A piece offered to a pawn and won back two moves later
    by a fork is a tactic, not a sacrifice."""
    if reply_mate is not None and reply_mate < 0:      # the opponent (to move) gets mated: the material is beside the point
        return True
    return material_swing(board_after, reply_pv[:SACRIFICE_PLIES], mover) <= -100


def gives_away(board: chess.Board, move: chess.Move, best_pv: list[str], reply_pv: list[str]) -> bool:
    """The move leaves its piece to be taken (per SEE), the engine's reply takes it, and along the engine's line the
    mover stays at least MATERIAL_MISTAKE down on where the best move's line leaves them. Stockfish's eval flattens out
    in a decided position, so a rook dropped at -8 can cost barely a pawn of eval; the material count doesn't."""
    if not reply_pv or not is_sacrifice(board, move):
        return False
    after = board.copy(stack=False)
    after.push(move)
    reply = chess.Move.from_uci(reply_pv[0])
    if reply.to_square != move.to_square or not after.is_capture(reply):
        return False
    line = [move.uci()] + reply_pv
    n = min(len(line), SACRIFICE_PLIES)
    mover = board.turn
    return material_swing(board, best_pv[:n], mover) - material_swing(board, line[:n], mover) >= MATERIAL_MISTAKE


def material_lost(board: chess.Board, move: chess.Move, best_pv: list[str], reply_pv: list[str], plies: int = 4) -> int:
    """Centipawns of material the move loses against the best move, comparing the engine's two lines over the same
    few plies (any piece, not only the moved one), mover POV."""
    line = [move.uci()] + reply_pv
    n = min(plies, len(line), len(best_pv))
    if n < 2:
        return 0
    return material_swing(board, best_pv[:n], board.turn) - material_swing(board, line[:n], board.turn)


def grade_k(rating: Optional[int]) -> float:
    """Steepness of the grading curve for a player of `rating`: GRADE_K_LOW up to GRADE_RATING_LOW, GRADE_K_HIGH
    from GRADE_RATING_HIGH, log-linear between."""
    r = GRADE_DEFAULT_RATING if rating is None else rating
    t = min(1.0, max(0.0, (r - GRADE_RATING_LOW) / (GRADE_RATING_HIGH - GRADE_RATING_LOW)))
    return math.exp(math.log(GRADE_K_LOW) + t * (math.log(GRADE_K_HIGH) - math.log(GRADE_K_LOW)))


def mover_rating(game: dict, mover: str) -> Optional[int]:
    return game.get("my_rating") if mover == game.get("my_colour") else game.get("opponent_rating")


def only_move(multipv: Optional[list[dict]], side: str) -> Optional[bool]:
    if not multipv:
        return None
    ranked = sorted(multipv, key=lambda r: r["rank"])
    if len(ranked) < 2:
        return True
    w1 = pov_win_pct(ranked[0]["eval_cp"], ranked[0]["mate_in"], side, side)
    w2 = pov_win_pct(ranked[1]["eval_cp"], ranked[1]["mate_in"], side, side)
    return w1 - w2 > ONLY_MOVE_GAP


def _increment(time_control: Optional[str]) -> int:
    if not time_control or "+" not in time_control:
        return 0
    try:
        return int(time_control.split("+")[1])
    except ValueError:
        return 0


def _base(time_control: Optional[str]) -> Optional[int]:
    if not time_control or "/" in time_control:
        return None
    try:
        return int(time_control.split("+")[0])
    except ValueError:
        return None


def classify_game(game: dict, rows: list[dict], multipv: Optional[dict[str, list[dict]]] = None) -> list[dict]:
    """rows: positions joined with evals for one game, ordered by ply (terminal row last).
    multipv: fen_key -> evals_multipv rows (optional)."""
    board = chess.Board(rows[0]["fen"])
    out = []
    inc, base = _increment(game["time_control"]), _base(game["time_control"])
    last_clock = {"white": base, "black": base}
    my_colour = game["my_colour"]
    prev_loss: Optional[float] = None
    last_capture: Optional[int] = None      # the square the previous move captured on
    multipv = multipv or {}

    for i, r in enumerate(rows[:-1]):
        nxt = rows[i + 1]
        mover = r["side_to_move"]
        move = chess.Move.from_uci(r["move_played"])
        n_legal = board.legal_moves.count()
        san = board.san(move)
        best_san = None
        if r["best_move"]:
            try:
                best_san = board.san(chess.Move.from_uci(r["best_move"]))
            except (ValueError, AssertionError):
                best_san = None

        has_evals = r["eval_cp"] is not None or r["mate_in"] is not None
        nxt_has = nxt["eval_cp"] is not None or nxt["mate_in"] is not None
        wp_before = pov_win_pct(r["eval_cp"], r["mate_in"], mover, mover) if has_evals else None
        wp_after = pov_win_pct(nxt["eval_cp"], nxt["mate_in"], nxt["side_to_move"], mover) if nxt_has else None
        wp_loss = max(0.0, wp_before - wp_after) if (wp_before is not None and wp_after is not None) else None
        k = grade_k(mover_rating(game, mover))
        loss = None if wp_loss is None else max(0.0, pov_win_pct(r["eval_cp"], r["mate_in"], mover, mover, k)
                                                - pov_win_pct(nxt["eval_cp"], nxt["mate_in"], nxt["side_to_move"], mover, k))
        # mover POV: eval before, and the mate the opponent has after (None if none)
        cp_before = r["eval_cp"]
        cp_after = None if nxt["eval_cp"] is None else -nxt["eval_cp"]
        mated_in_after = nxt["mate_in"] if (nxt["mate_in"] or 0) > 0 else None
        is_best = bool(r["best_move"]) and r["best_move"] == r["move_played"]
        only = only_move(multipv.get(r.get("fen_key") or fen_key(r["fen"])), mover) if has_evals else None
        # mate was available and the played move no longer forces one
        missed_mate = (r["mate_in"] or 0) > 0 and not ((nxt["mate_in"] or 0) < 0)

        board_before = board.copy(stack=False)
        is_capture = board.is_capture(move)
        recapture = is_capture and move.to_square == last_capture
        board.push(move)
        in_book = book.is_book(fen_key(board.fen()))

        if in_book:
            label = "book"
        elif n_legal == 1:
            label = "forced"
        elif loss is None:
            label = None
        elif is_best or loss <= EXCELLENT:
            if 10 < wp_before < 90 and wp_after >= 35 and is_sacrifice(board_before, move)                     and sacrifice_holds(board, nxt.get("pv") or [], board_before.turn, nxt["mate_in"]):
                label = "brilliant"
            elif is_best and only and not recapture and 10 < wp_before < 95:
                label = "great"
            elif is_best or (cp_before is not None and cp_after is not None and cp_after >= cp_before):
                label = "best"
            else:
                label = "excellent"
        else:
            label = label_for(loss)
            opportunity = (prev_loss is not None and prev_loss > MISTAKE) or missed_mate
            if opportunity and wp_before >= MISS_BEFORE_MIN and wp_after >= MISS_AFTER_MIN \
                    and (label in ("mistake", "blunder") or (missed_mate and label in ("good", "inaccuracy"))):
                label = "miss"

        if label in ("best", "excellent", "good", "inaccuracy", "great", "mistake") and not is_best \
                and r["eval_cp"] is not None and nxt["eval_cp"] is not None:
            cp_drop = r["eval_cp"] - (-nxt["eval_cp"])          # both mover POV
            if cp_drop >= CP_MISTAKE and is_sacrifice(board_before, move):
                label = "blunder" if cp_drop >= CP_BLUNDER else "mistake"
        if label in ("best", "excellent", "good", "inaccuracy", "great") and not is_best \
                and r["mate_in"] is None and nxt["mate_in"] is None \
                and gives_away(board_before, move, r.get("pv") or [], nxt.get("pv") or []):
            label = "mistake"

        if r["mate_in"] == 1 and not board.is_checkmate() and label in ("best", "excellent", "good", "inaccuracy"):
            label = "miss"
        if r["mate_in"] is not None and r["mate_in"] < 0 and mated_in_after is not None \
                and mated_in_after < -r["mate_in"] - 1 and label in ("best", "excellent", "good"):
            label = "inaccuracy"                                # walked into a faster mate than the one coming
        if cp_before is not None and mated_in_after is not None:
            if cp_before <= MATE_FROM_LOST_CP and label in ("best", "excellent", "good", "inaccuracy", "great", "mistake", "blunder"):
                label = "mistake" if mated_in_after <= 3 else "inaccuracy"      # lost already, now mated
            elif cp_before <= LOSING_MATERIAL_CP and label == "blunder":
                label = "mistake"
        if label in ("best", "excellent", "good", "inaccuracy", "great") and not is_best \
                and cp_before is not None and cp_before <= LOSING_MATERIAL_CP \
                and material_lost(board_before, move, r.get("pv") or [], nxt.get("pv") or []) >= MATERIAL_MISTAKE:
            label = "mistake"                                   # the losing side gives more away

        clk = r["clock_remaining"]
        spent = None
        if clk is not None and last_clock[mover] is not None:
            spent = max(0, last_clock[mover] - clk + inc)
        if clk is not None:
            last_clock[mover] = clk

        out.append({
            "game_id": r["game_id"], "ply": r["ply"], "side_to_move": mover, "is_mine": mover == my_colour,
            "move_played": r["move_played"], "san": san, "best_move": r["best_move"], "best_san": best_san,
            "n_legal": n_legal, "is_forced": n_legal == 1, "in_book": in_book,
            "wp_before": wp_before, "wp_after": wp_after, "wp_loss": wp_loss,
            "accuracy": move_accuracy(wp_loss) if wp_loss is not None else None,
            "label": label, "only_move": only, "clock_remaining": clk, "time_spent": spent,
        })
        prev_loss = loss
        last_capture = move.to_square if is_capture else None
    return out


def load_multipv(con, game_id: Optional[str] = None) -> dict[str, list[dict]]:
    where = "WHERE fen_key IN (SELECT fen_key FROM positions WHERE game_id = ?)" if game_id else ""
    where = (where + " AND" if where else "WHERE") + " rank > 0"     # rank 0 = terminal-position sentinel
    rows = con.execute(f"SELECT * FROM evals_multipv {where}", [game_id] if game_id else []).fetch_arrow_table().to_pylist()
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["fen_key"], []).append(r)
    return out


def classify_all(con) -> list[dict]:
    games = {g["game_id"]: g for g in con.execute("SELECT * FROM games").fetch_arrow_table().to_pylist()}
    rows = con.execute("""
        SELECT p.game_id, p.ply, p.fen, p.fen_key, p.side_to_move, p.move_played, p.clock_remaining,
               e.eval_cp, e.mate_in, e.best_move, e.pv
        FROM positions p LEFT JOIN evals e USING (fen_key)
        ORDER BY p.game_id, p.ply
    """).fetch_arrow_table().to_pylist()
    multipv = load_multipv(con)
    by_game: dict[str, list[dict]] = {}
    for r in rows:
        by_game.setdefault(r["game_id"], []).append(r)
    out: list[dict] = []
    for gid, grows in by_game.items():
        out.extend(classify_game(games[gid], grows, multipv))
    return out


def build(profile: Profile) -> dict:
    con = connect(profile)
    out = classify_all(con)
    profile.moves_parquet.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(out, schema=SCHEMA), profile.moves_parquet)
    con = connect(profile)
    dist = con.execute("""
        SELECT label, count(*) n, round(100.0 * count(*) / sum(count(*)) OVER (), 1) pct
        FROM moves GROUP BY label ORDER BY n DESC
    """).fetchall()
    return {"moves": len(out), "games": len({m["game_id"] for m in out}), "distribution": dist}


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="classify", description=__doc__)
    p.add_argument("--profile", help="profile id (default: the only profile)")
    args = p.parse_args(argv)
    stats = build(profiles.resolve(args.profile))
    log.info("moves=%d games=%d", stats["moves"], stats["games"])
    for label, n, pct in stats["distribution"]:
        log.info("  %-11s %6d  %5.1f%%", label, n, pct)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
