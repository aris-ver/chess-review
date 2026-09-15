"""Stage 4d: emit the review site.

    data/site/index.html                    the app (vanilla JS, no framework, no board library), shared
    data/profiles/<id>/site/games.json      {username, games: [summary...]}   served at /p/<id>/games.json
    data/profiles/<id>/site/games/<slug>.json   full review: every move with eval/label/clock/comment, key moments

Each game is classified live from positions ⋈ evals, so `write_game` can be
called for one game while the server is still analysing it.
"""

import argparse
import hashlib
import json
import logging
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

import chess
import chess.svg

from . import explain
from .accuracy import game_accuracy
from .classify import classify_game, load_multipv
from . import profiles
from .config import SITE_DIR
from .critical import select
from .db import connect
from .profiles import Profile
from .facts import extract
from .pov import pov_win_pct, to_white_pov

log = logging.getLogger("site")
STATIC = Path(__file__).parent / "static"

POSITIONS_SQL = """
    SELECT p.game_id, p.ply, p.fen, p.fen_key, p.side_to_move, p.move_played, p.clock_remaining,
           e.eval_cp, e.mate_in, e.best_move, e.pv
    FROM positions p LEFT JOIN evals e USING (fen_key)
    {where} ORDER BY p.game_id, p.ply
"""


def slug(game_id: str) -> str:
    tail = game_id.rstrip("/").split("/")[-1]
    return tail if tail.isdigit() else hashlib.sha1(game_id.encode()).hexdigest()[:12]


def eval_text(eval_cp, mate_in, side_to_move: str) -> Optional[str]:
    """White-POV display string: '+0.4', '-2.1', 'M3', '-M2', '#' for checkmate on board."""
    cp, mate = to_white_pov(eval_cp, mate_in, side_to_move)
    if mate is not None:
        if mate == 0:
            return "#"
        return f"M{mate}" if mate > 0 else f"-M{-mate}"
    if cp is None:
        return None
    return f"{cp / 100:+.1f}"


def _wp_white(p: dict) -> Optional[float]:
    if p["eval_cp"] is None and p["mate_in"] is None:
        return None
    return round(pov_win_pct(p["eval_cp"], p["mate_in"], p["side_to_move"], "white"), 1)


def _accuracy(moves: list[dict], side: str, start_wp_white: Optional[float] = 50.0) -> Optional[float]:
    return game_accuracy(moves, side, start_wp_white)


def _counts(moves: list[dict], side: str) -> dict:
    out: dict[str, int] = {}
    for m in moves:
        if m["side_to_move"] == side and m["label"]:
            out[m["label"]] = out.get(m["label"], 0) + 1
    return out


def build_game(game: dict, positions: list[dict], moves: list[dict], critical: list[dict],
               multipv: dict[str, list[dict]], username: str = "me") -> dict:
    """positions: positions ⋈ evals rows (terminal row last); moves: classified rows; both ordered by ply."""
    pos_by_ply = {p["ply"]: p for p in positions}
    crit_by_ply = {c["ply"]: c for c in critical}
    p0 = positions[0]

    out_moves, key_moments = [], []
    for m in moves:
        before, after = pos_by_ply[m["ply"]], pos_by_ply[m["ply"] + 1]
        facts = extract(m, chess.Board(before["fen"]), before, after, multipv.get(before["fen_key"])) if m["label"] else None
        out_moves.append({
            "ply": m["ply"], "san": m["san"], "uci": m["move_played"], "fen": after["fen"],
            "label": m["label"], "is_mine": m["is_mine"],
            "wp_white": _wp_white(after), "eval": eval_text(after["eval_cp"], after["mate_in"], after["side_to_move"]),
            "wp_loss": None if m["wp_loss"] is None else round(m["wp_loss"], 1),
            "best_san": m["best_san"], "best_uci": before["best_move"],
            "clock": m["clock_remaining"], "spent": m["time_spent"],
            "comment": explain.comment(facts, game["opening_name"] if m["in_book"] else None) if facts else [],
            "hung": [h["square"] for h in facts.hung_pieces] if facts else [],
            "reply_uci": facts.refutation_uci[0] if facts and facts.refutation_uci else None,
        })
        c = crit_by_ply.get(m["ply"])
        if c and facts:
            key_moments.append({
                "ply": c["ply"], "rank": c["rank"], "label": m["label"],
                "move": explain.move_label(c["ply"], m["san"]),
                "headline": explain.headline(facts), "text": explain.explain(facts),
                "refutation_uci": facts.refutation_uci, "best_uci": before["best_move"],
                "hung": [h["square"] for h in facts.hung_pieces], "motif": facts.motif,
            })

    left_book = next((m["ply"] for m in moves if not m["in_book"]), len(moves))
    me = {"name": username, "rating": game["my_rating"]}
    them = {"name": game["opponent"] or "opponent", "rating": game["opponent_rating"]}
    white, black = (me, them) if game["my_colour"] == "white" else (them, me)
    evaluated = sum(1 for p in positions if p["eval_cp"] is not None or p["mate_in"] is not None)
    return {
        "id": slug(game["game_id"]), "url": game["game_id"],
        "played_at": game["played_at"].isoformat() if isinstance(game["played_at"], datetime) else game["played_at"],
        "time_control": game["time_control"], "time_class": game["time_class"],
        "my_colour": game["my_colour"], "result": game["result"], "termination": game["termination"],
        "eco": game["eco"], "opening_name": game["opening_name"], "left_book_ply": left_book,
        "white": {**white, "accuracy": _accuracy(moves, "white", _wp_white(p0)), "counts": _counts(moves, "white")},
        "black": {**black, "accuracy": _accuracy(moves, "black", _wp_white(p0)), "counts": _counts(moves, "black")},
        "start_fen": p0["fen"], "start_wp_white": _wp_white(p0),
        "analysed": round(evaluated / len(positions), 3) if positions else 0.0,
        "moves": out_moves, "key_moments": sorted(key_moments, key=lambda k: k["ply"]),
    }


def index_entry(game: dict, review: dict) -> dict:
    mine, theirs = game["my_colour"], "black" if game["my_colour"] == "white" else "white"
    return {k: review[k] for k in ("id", "played_at", "time_class", "time_control", "my_colour", "result",
                                    "termination", "eco", "opening_name", "analysed")} | {
        "opponent": game["opponent"], "opponent_rating": game["opponent_rating"], "my_rating": game["my_rating"],
        "my_accuracy": review[mine]["accuracy"], "opp_accuracy": review[theirs]["accuracy"],
        "n_moves": len(review["moves"]), "n_key": len(review["key_moments"]),
        "blunders": review[mine]["counts"].get("blunder", 0),
        "brilliants": review[mine]["counts"].get("brilliant", 0),
        "brilliants_any": review["white"]["counts"].get("brilliant", 0) + review["black"]["counts"].get("brilliant", 0),
    }


def game_review(con, profile: Profile, game: dict) -> dict:
    positions = con.execute(POSITIONS_SQL.format(where="WHERE p.game_id = ?"), [game["game_id"]]).fetch_arrow_table().to_pylist()
    multipv = load_multipv(con, game["game_id"])
    moves = classify_game(game, positions, multipv)
    return build_game(game, positions, moves, select(moves), multipv, profile.username)


def write_game(con, profile: Profile, game_id: str) -> dict:
    """Rebuild one game's JSON (used by the server during on-demand analysis). Returns the index entry."""
    game = con.execute("SELECT * FROM games WHERE game_id = ?", [game_id]).fetch_arrow_table().to_pylist()[0]
    review = game_review(con, profile, game)
    (profile.site_dir / "games").mkdir(parents=True, exist_ok=True)
    (profile.site_dir / "games" / f"{review['id']}.json").write_text(json.dumps(review, ensure_ascii=False), encoding="utf-8")
    return index_entry(game, review)


def update_index(profile: Profile, entry: dict) -> None:
    path = profile.site_dir / "games.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"username": profile.username, "games": []}
    data["games"] = [entry if g["id"] == entry["id"] else g for g in data["games"]]
    if entry["id"] not in {g["id"] for g in data["games"]}:
        data["games"].append(entry)
    data["games"].sort(key=lambda g: g["played_at"] or "", reverse=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def write_static() -> None:
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    html = html.replace("/*__PIECES__*/", json.dumps(chess.svg.PIECES))
    (SITE_DIR / "index.html").write_text(html, encoding="utf-8")


def build(profile: Profile) -> dict:
    """Every game's review JSON + the index for one profile; also refreshes the shared index.html."""
    con = connect(profile)
    games = con.execute("SELECT * FROM games ORDER BY played_at DESC").fetch_arrow_table().to_pylist()
    positions = con.execute(POSITIONS_SQL.format(where="")).fetch_arrow_table().to_pylist()
    multipv = load_multipv(con)
    pos_g: dict[str, list[dict]] = {}
    for r in positions:
        pos_g.setdefault(r["game_id"], []).append(r)

    username = profile.username
    (profile.site_dir / "games").mkdir(parents=True, exist_ok=True)
    index = []
    for g in games:
        pos = pos_g.get(g["game_id"])
        if not pos or len(pos) < 2:
            continue
        moves = classify_game(g, pos, multipv)
        review = build_game(g, pos, moves, select(moves), multipv, username)
        (profile.site_dir / "games" / f"{review['id']}.json").write_text(json.dumps(review, ensure_ascii=False), encoding="utf-8")
        index.append(index_entry(g, review))
    (profile.site_dir / "games.json").write_text(json.dumps({"username": username, "games": index}, ensure_ascii=False), encoding="utf-8")
    write_static()
    return {"games": len(index), "dir": str(profile.site_dir)}


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="site", description=__doc__)
    p.add_argument("--clean", action="store_true", help="remove the profile's site dir first")
    p.add_argument("--profile", help="profile id (default: the only profile)")
    args = p.parse_args(argv)
    profile = profiles.resolve(args.profile)
    if args.clean and profile.site_dir.exists():
        shutil.rmtree(profile.site_dir)
    log.info("done: %s", build(profile))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
