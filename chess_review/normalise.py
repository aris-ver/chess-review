"""Stage 2: parse raw archives + pasted PGNs into games.parquet and positions.parquet.

A pure function of data/raw and data/pgn; both parquet files are rebuilt from
scratch on every run, which makes the stage trivially idempotent.

positions.clock_remaining is the `[%clk]` annotation attached to move_played,
i.e. the mover's clock immediately AFTER making that move. time_spent is
derived downstream as the delta between consecutive same-side readings.
"""

import argparse
import io
import json
import logging
import re
from datetime import datetime, timezone
from typing import Iterator, Optional

import chess
import chess.pgn
import pyarrow as pa
import pyarrow.parquet as pq

from .config import DATA, GAMES_PARQUET, META_JSON, PGN_DIR, POSITIONS_PARQUET, RAW_DIR

log = logging.getLogger("normalise")

DRAW_CODES = {"agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"}

GAMES_SCHEMA = pa.schema([
    ("game_id", pa.string()),
    ("played_at", pa.timestamp("us")),
    ("time_control", pa.string()),
    ("time_class", pa.string()),
    ("my_colour", pa.string()),
    ("my_rating", pa.int32()),
    ("opponent_rating", pa.int32()),
    ("result", pa.string()),
    ("termination", pa.string()),
    ("eco", pa.string()),
    ("opening_name", pa.string()),
    ("opponent", pa.string()),      # not in the spec schema; needed to label games in the UI
])

POSITIONS_SCHEMA = pa.schema([
    ("game_id", pa.string()),
    ("ply", pa.int32()),
    ("fen", pa.string()),
    ("move_played", pa.string()),
    ("side_to_move", pa.string()),
    ("clock_remaining", pa.int32()),
])


def extract_positions(game: chess.pgn.Game, game_id: str) -> list[dict]:
    """One row per ply (position before the move), plus a terminal row with move_played=NULL."""
    board = game.board()
    rows = []
    for ply, node in enumerate(game.mainline()):
        clk = node.clock()
        rows.append({
            "game_id": game_id,
            "ply": ply,
            "fen": board.fen(),
            "move_played": node.move.uci(),
            "side_to_move": "white" if board.turn else "black",
            "clock_remaining": None if clk is None else int(round(clk)),
        })
        board.push(node.move)
    rows.append({
        "game_id": game_id,
        "ply": len(rows),
        "fen": board.fen(),
        "move_played": None,
        "side_to_move": "white" if board.turn else "black",
        "clock_remaining": None,
    })
    return rows


def _played_at(headers: chess.pgn.Headers, fallback_epoch: Optional[int] = None) -> Optional[datetime]:
    date = headers.get("UTCDate") or headers.get("Date")
    tm = headers.get("UTCTime") or headers.get("StartTime") or "00:00:00"
    if date and "?" not in date:
        try:
            return datetime.strptime(f"{date} {tm}", "%Y.%m.%d %H:%M:%S")
        except ValueError:
            pass
    if fallback_epoch is not None:
        return datetime.fromtimestamp(fallback_epoch, tz=timezone.utc).replace(tzinfo=None)
    return None


def _opening_name(headers: chess.pgn.Headers) -> Optional[str]:
    url = headers.get("ECOUrl")
    if url:
        slug = url.rstrip("/").split("/")[-1]
        return re.sub(r"-(?=[A-Za-z0-9])", " ", slug)
    return headers.get("Opening")


def _is_standard(game: chess.pgn.Game) -> bool:
    if game.headers.get("Variant", "Standard").lower() not in ("standard", "chess"):
        return False
    return game.board().fen() == chess.STARTING_FEN


def _time_class(time_control: Optional[str]) -> Optional[str]:
    """Derive chess.com's bucket for pasted PGNs (JSON archives carry it explicitly)."""
    if not time_control or time_control == "-":
        return None
    if "/" in time_control:
        return "daily"
    base, _, inc = time_control.partition("+")
    try:
        est = int(base) + 40 * int(inc or 0)
    except ValueError:
        return None
    if est < 180:
        return "bullet"
    if est < 600:
        return "blitz"
    return "rapid"


def parse_chesscom(g: dict, username: str) -> Optional[tuple[dict, list[dict]]]:
    if g.get("rules") != "chess":
        return None
    white, black = g["white"], g["black"]
    uname = username.lower()
    if white["username"].lower() == uname:
        me, them, colour = white, black, "white"
    elif black["username"].lower() == uname:
        me, them, colour = black, white, "black"
    else:
        return None

    game = chess.pgn.read_game(io.StringIO(g["pgn"]))
    if game is None or not _is_standard(game):
        return None

    my_code = me["result"]
    result = "win" if my_code == "win" else "draw" if my_code in DRAW_CODES else "loss"
    h = game.headers
    game_row = {
        "game_id": g["url"],
        "played_at": _played_at(h, g.get("end_time")),
        "time_control": g.get("time_control"),
        "time_class": g.get("time_class"),
        "my_colour": colour,
        "my_rating": me.get("rating"),
        "opponent_rating": them.get("rating"),
        "result": result,
        "termination": h.get("Termination") or (them["result"] if my_code == "win" else my_code),
        "eco": h.get("ECO") or None,
        "opening_name": _opening_name(h),
        "opponent": them.get("username"),
    }
    return game_row, extract_positions(game, g["url"])


def parse_pgn_text(text: str, username: str, digest: str) -> Iterator[tuple[dict, list[dict]]]:
    stream = io.StringIO(text)
    idx = 0
    while (game := chess.pgn.read_game(stream)) is not None:
        idx += 1
        if not _is_standard(game):
            continue
        h = game.headers
        uname = username.lower()
        if h.get("White", "").lower() == uname:
            colour = "white"
        elif h.get("Black", "").lower() == uname:
            colour = "black"
        else:
            log.warning("pgn %s game %d: %s is neither player, skipping", digest, idx, username)
            continue
        res = h.get("Result", "*")
        if res == "1/2-1/2":
            result = "draw"
        elif res in ("1-0", "0-1"):
            result = "win" if (res == "1-0") == (colour == "white") else "loss"
        else:
            result = None
        me, them = ("White", "Black") if colour == "white" else ("Black", "White")
        link = h.get("Link") or h.get("Site") or ""
        game_id = link if link.startswith("http") else f"pgn:{digest}:{idx}"
        tc = h.get("TimeControl")
        game_row = {
            "game_id": game_id,
            "played_at": _played_at(h),
            "time_control": tc,
            "time_class": _time_class(tc),
            "my_colour": colour,
            "my_rating": int(h[f"{me}Elo"]) if h.get(f"{me}Elo", "?").isdigit() else None,
            "opponent_rating": int(h[f"{them}Elo"]) if h.get(f"{them}Elo", "?").isdigit() else None,
            "result": result,
            "termination": h.get("Termination"),
            "eco": h.get("ECO") or None,
            "opening_name": _opening_name(h),
            "opponent": h.get(them),
        }
        yield game_row, extract_positions(game, game_id)


def build(username: str) -> dict:
    games: dict[str, dict] = {}
    positions: list[dict] = []
    stats = {"raw_games": 0, "skipped_variant_or_other": 0, "pgn_files": 0}

    for f in sorted(RAW_DIR.glob("*.json")):
        for g in json.loads(f.read_text(encoding="utf-8")).get("games", []):
            stats["raw_games"] += 1
            parsed = parse_chesscom(g, username)
            if parsed is None:
                stats["skipped_variant_or_other"] += 1
                continue
            row, pos = parsed
            if row["game_id"] in games:
                continue
            games[row["game_id"]] = row
            positions.extend(pos)

    for f in sorted(PGN_DIR.glob("*.pgn")):
        stats["pgn_files"] += 1
        for row, pos in parse_pgn_text(f.read_text(encoding="utf-8"), username, f.stem):
            if row["game_id"] in games:
                continue
            games[row["game_id"]] = row
            positions.extend(pos)

    DATA.mkdir(parents=True, exist_ok=True)
    META_JSON.write_text(json.dumps({"username": username}), encoding="utf-8")
    pq.write_table(pa.Table.from_pylist(list(games.values()), schema=GAMES_SCHEMA), GAMES_PARQUET)
    pq.write_table(pa.Table.from_pylist(positions, schema=POSITIONS_SCHEMA), POSITIONS_PARQUET)
    stats["games"] = len(games)
    stats["positions"] = len(positions)
    return stats


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="normalise", description=__doc__)
    p.add_argument("--username", required=True, help="your chess.com username (decides my_colour)")
    args = p.parse_args(argv)
    stats = build(args.username)
    log.info("done: %s", stats)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
