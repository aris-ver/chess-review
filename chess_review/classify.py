"""Stage 4a: join evals onto positions and classify every move -> data/moves.parquet.

Classification is on WIN% loss from the mover's point of view, never on
centipawns. win% before = eval of the position the mover faced; win% after =
eval of the position they left the opponent, re-signed to the mover.

Labels (chess.com vocabulary, deterministic definitions):
  book        resulting position is in the opening book
  forced      only legal move
  brilliant   engine-approved sacrifice (SEE says the piece can be won) that isn't already a crush
  great       the engine's move and the only good one (MultiPV #1 - #2 > ONLY_MOVE_GAP)
  best        the engine's move
  excellent   loss <= EXCELLENT
  good        loss <= GOOD
  inaccuracy  loss <= MISTAKE
  mistake     loss <= BLUNDER
  miss        a missed win: the opponent just erred or a forced mate was on, the move gave part of it
              back but the mover is still ahead (any size of loss - chess.com's "Miss")
  blunder     loss > BLUNDER

Material floor: win% barely moves in a decided position, so a move that hangs
material (per SEE) and drops the eval by CP_MISTAKE / CP_BLUNDER centipawns is
at least a mistake / blunder even at +10. Engine-approved sacrifices don't drop
the eval, so they are unaffected.
"""

import argparse
import logging
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
    INACCURACY,
    MISTAKE,
    ONLY_MOVE_GAP,
)
from . import profiles
from .db import connect
from .profiles import Profile
from .facts import see
from .fen import fen_key
from .pov import pov_win_pct

log = logging.getLogger("classify")

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
        is_best = bool(r["best_move"]) and r["best_move"] == r["move_played"]
        only = only_move(multipv.get(r.get("fen_key") or fen_key(r["fen"])), mover) if has_evals else None
        # mate was available and the played move no longer forces one
        missed_mate = (r["mate_in"] or 0) > 0 and not ((nxt["mate_in"] or 0) < 0)

        board_before = board.copy(stack=False)
        board.push(move)
        in_book = book.is_book(fen_key(board.fen()))

        if in_book:
            label = "book"
        elif n_legal == 1:
            label = "forced"
        elif wp_loss is None:
            label = None
        elif is_best or wp_loss <= EXCELLENT:
            if 10 < wp_before < 90 and wp_after >= 35 and is_sacrifice(board_before, move):
                label = "brilliant"
            elif is_best and only and 10 < wp_before < 95:
                label = "great"
            elif is_best:
                label = "best"
            else:
                label = "excellent"
        else:
            label = label_for(wp_loss)
            opportunity = (prev_loss is not None and prev_loss > MISTAKE) or missed_mate
            if opportunity and wp_after >= 50 and (label in ("mistake", "blunder") or (missed_mate and label in ("good", "inaccuracy"))):
                label = "miss"

        if label in ("best", "excellent", "good", "inaccuracy", "great") and not is_best                 and r["eval_cp"] is not None and nxt["eval_cp"] is not None:
            cp_drop = r["eval_cp"] - (-nxt["eval_cp"])          # both mover POV
            if cp_drop >= CP_MISTAKE and is_sacrifice(board_before, move):
                label = "blunder" if cp_drop >= CP_BLUNDER else "mistake"

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
        prev_loss = wp_loss
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
               e.eval_cp, e.mate_in, e.best_move
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
