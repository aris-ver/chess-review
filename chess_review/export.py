"""Build-order step 1 check: dump games and positions-joined-with-evals to CSV.

eval_cp / mate_in in the CSV are re-signed to WHITE POV via SQL so the file is
directly eyeballable; the stored cache stays side-to-move POV.
"""

import argparse
import logging

from . import profiles
from .config import sql_path
from .db import connect

log = logging.getLogger("export")


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="export", description=__doc__)
    p.add_argument("--profile", help="profile id (default: the only profile)")
    args = p.parse_args(argv)
    profile = profiles.resolve(args.profile)
    EXPORT_DIR = profile.export_dir
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    con = connect(profile)

    con.execute(f"COPY (SELECT * FROM games ORDER BY played_at) TO {sql_path(EXPORT_DIR / 'games.csv')} (HEADER)")
    con.execute(f"""
        COPY (
            SELECT p.game_id, p.ply, p.side_to_move, p.move_played, p.clock_remaining,
                   e.nodes,
                   CASE WHEN p.side_to_move = 'white' THEN e.eval_cp ELSE -e.eval_cp END AS eval_cp_white,
                   CASE WHEN p.side_to_move = 'white' THEN e.mate_in ELSE -e.mate_in END AS mate_in_white,
                   e.best_move, array_to_string(e.pv, ' ') AS pv, p.fen
            FROM positions p LEFT JOIN evals e USING (fen_key)
            ORDER BY p.game_id, p.ply
        ) TO {sql_path(EXPORT_DIR / 'positions_evals.csv')} (HEADER)
    """)

    games, positions, evaluated = con.execute("""
        SELECT (SELECT count(*) FROM games),
               (SELECT count(*) FROM positions),
               (SELECT count(*) FROM positions p JOIN evals e USING (fen_key))
    """).fetchone()
    log.info("games=%d positions=%d evaluated=%d (%.1f%%) -> %s", games, positions, evaluated,
             100 * evaluated / positions if positions else 0, EXPORT_DIR)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
