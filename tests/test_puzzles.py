import random

import pyarrow as pa
import pyarrow.parquet as pq

from chess_review import puzzles as P

# a Lichess-format puzzle: the FEN is before the opponent's move, which is the first UCI move
SCHOLAR = {"fen": "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3", "moves": "g8f6 h5f7"}


def test_line_names_the_solver_and_replays_the_moves():
    ln = P.line({**SCHOLAR, "id": "s", "rating": 600, "themes": ["mateIn1"]})
    assert ln["colour"] == "white"                       # Black's ...Nf6 is the setup, so White solves
    assert [m["san"] for m in ln["moves"]] == ["Nf6", "Qxf7#"]
    assert ln["mates"] == []                             # Qxf7 is the only mate


def test_line_finds_alternative_mates():
    # setup ...Kh8, then Ra8# -- but Rb8# mates too (rooks on a7 and b1, black king boxed in on h8 by g7/h7 pawns)
    ln = P.line({"id": "alt", "fen": "6k1/R5pp/8/8/8/8/8/1R4K1 b - - 0 1", "moves": "g8h8 a7a8", "rating": 800, "themes": []})
    assert ln["colour"] == "white"
    assert ln["moves"][-1]["san"] == "Ra8#"
    assert [m["uci"] for m in ln["mates"]] == ["b1b8"]


def test_glicko_moves_toward_the_result_and_settles():
    r, rd = P.glicko(1500, 350, 1500, 1.0)
    assert r > 1600 and rd < 350
    r2, _ = P.glicko(1500, 350, 1500, 0.0)
    assert r2 < 1400
    r, rd = 1500.0, 350.0
    for i in range(200):
        r, rd = P.glicko(r, rd, 1500, float(i % 2))
    assert rd == P.MIN_RD                                 # never fully settled


def test_stats_counts_streaks():
    rec = [{"id": str(i), "rating": 1500, "solved": s} for i, s in enumerate([True, True, False, True, True, True])]
    st = P.stats(rec)
    assert (st["played"], st["solved"], st["streak"], st["best_streak"]) == (6, 5, 3, 3)
    assert P.stats([])["rating"] == 1500 and P.stats([])["provisional"]


def test_record_keeps_only_the_first_try(tmp_path):
    path = tmp_path / "attempts.jsonl"
    first = P.record("abc", 1400, solved=False, path=path)
    assert first["played"] == 1 and first["solved"] == 0
    assert P.record("abc", 1400, solved=True, path=path) is None      # solving it later changes nothing
    assert P.record("def", 1400, solved=True, hinted=True, path=path)["solved"] == 0   # a hint is not a solve
    with path.open("a", encoding="utf-8") as f:
        f.write('{"id": "cut sh')                         # a line a crash cut short
    assert len(P.attempts(path)) == 2


def test_pick_stays_near_the_rating_and_widens():
    rows = [{"id": str(r), "rating": r, "themes": ["fork"] if r % 200 else ["pin"]} for r in range(600, 2600, 50)]
    rng = random.Random(0)
    for _ in range(20):
        assert abs(P.pick(rows, 1500, rng=rng)["rating"] - 1500) <= P.WINDOW
    assert P.pick(rows, 1500, {"pin"}, rng=rng)["themes"] == ["pin"]
    assert P.pick(rows, 5000, rng=rng)["rating"] == 2550      # nothing near: the closest there is
    assert P.pick(rows, 1500, {"nope"}) is None
    assert P.pick(rows, 600, exclude={"600", "650", "700", "750"}, rng=rng)["rating"] == 800


def test_pack_reads_parquet(tmp_path):
    path = tmp_path / "p.parquet"
    pq.write_table(pa.Table.from_pylist([{"id": "a", "fen": SCHOLAR["fen"], "moves": SCHOLAR["moves"], "rating": 1500,
                                          "themes": "fork middlegame", "game_url": None}]), path)
    pack = P.Pack(path)
    assert pack.get("a")["themes"] == ["fork", "middlegame"]
    assert {t["id"]: t["count"] for t in pack.themes()} == {"fork": 1, "middlegame": 1}
    assert P.theme_name("discoveredAttack") == "Discovered attack" and P.theme_name("mateIn2") == "Mate in 2"


def test_shipped_pack_replays():
    rows = P.Pack().rows()
    assert len(rows) > 20_000
    for r in random.Random(1).sample(rows, 300):
        ln = P.line(r)
        assert len(ln["moves"]) % 2 == 0                  # setup + (answer, reply)* + final answer
