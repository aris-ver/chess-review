"""Parity dumps for the games-in part of the JavaScript port (docs/js-port.md): normalise's rows and ingest's stored
PGNs, written to tests/parity/normalise.json for js/core/normalise.test.js and js/server/ingest.test.js to replay.

    python scripts/dump_parity_games.py            tests/fixtures, made-up games and PGN corner cases
    python scripts/dump_parity_games.py --local    also every profile's raw files and rows, to tests/parity/local/
                                                   (gitignored: it is your own data; CHESS_REVIEW_DATA picks the
                                                   data folder, as for the app)

Needs no engine. Regenerate after any change to normalise.py or ingest.store_pgn.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from chess_review import ingest, normalise  # noqa: E402

OUT = ROOT / "tests" / "parity"
FIXTURE = ROOT / "tests" / "fixtures" / "clocks.pgn"


def write(name: str, data, out: Path = OUT) -> None:
    out.mkdir(parents=True, exist_ok=True)
    path = out / name
    text = json.dumps(data, separators=(",", ":"), default=datetime.isoformat)
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


def rows(parsed):
    return None if parsed is None else list(parsed)


# --- pasted PGNs ------------------------------------------------------------------------------------------------

TAGS = '[Event "Casual"]\n[Site "?"]\n[White "me"]\n[Black "you"]\n[Result "{result}"]\n'

# Each a whole pasted text: python-chess's reader on its corner cases, and normalise's on its tags.
PGN_TEXTS = [
    # no tags at all; a BOM, % and ; lines before the game
    "1. e4 e5 2. Nf3 Nc6 *",
    "﻿% a comment line\n; another\n\n[White \"Me\"]\n[Black \"x\"]\n\n1. d4 d5 1-0\n",
    # comments: before the first move, padded, multi-line with a blank line inside, several on one move, ;-comments
    TAGS.format(result="0-1") + '\n{ opening remark } 1. e4 { [%clk 0:10:00] } { second\n\nline } e5 {[%clk 0:09:59.5]}'
    ' ; rest of line ignored Nf3\n2. Nf3 {[%emt 0:00:01] [%clk 0:09:58.49]} Nc6 {  [%clk 1:00:00.5]  } 0-1\n',
    # variations: nested, with comments and clocks inside, a comment right after a variation, NAGs
    TAGS.format(result="*") + '\n1. e4 {[%clk 0:05:00]} e5 (1... c5 {[%clk 0:04:00]} 2. Nf3 (2. c3 d5) d6) {after} '
    '2. Nf3 $1 Nc6 !? (2... d6 ?? {x}) 3. Bb5 ! a6 $14 *\n',
    # a variation with no moves, then a comment: it starts the next move
    TAGS.format(result="*") + '\n1. e4 e5 ( ) {starting} 2. Nf3 {[%clk 0:01:00]} *\n',
    # an illegal move in the mainline: the rest is skipped
    TAGS.format(result="1-0") + '\n1. e4 e5 2. Ke3 Nc6 3. Nf3 1-0\n',
    # an illegal move inside a variation: python-chess keeps reading the mainline on the variation's board
    TAGS.format(result="*") + '\n1. e4 e5 (1... c5 2. Qh5 Qxh5) 2. Nf3 Nc6 *\n',
    TAGS.format(result="*") + '\n1. e4 e5 (1... c5 2. Ke5) 2. Nf3 Nc6 *\n',
    # ambiguous and over-specified SAN, castling both ways and spellings, "Kg1" isn't castling, promotions
    TAGS.format(result="*") + '\n1. Nf3 Nf6 2. Nc3 Nc6 3. Nd4 Nd5 4. Nb5 Nb4 5. Nd4 e6 6. e3 Be7 7. Be2 O-O 8. 0-0 d6 *\n',
    TAGS.format(result="*") + '\n1. e4 e5 2. Nf3 Nf6 3. Bc4 Bc5 4. Kg1 Nc6 *\n',
    TAGS.format(result="*") + '\n1. e4 e5 2. Nf3 Nf6 3. Bc4 Bc5 4. e1h1 Nc6 5. Re1 O-O 6. Kh1 Kh8 7. Kg1 *\n',
    TAGS.format(result="*") + '\n1. Nf3 Nf6 2. g1g3 *\n',
    TAGS.format(result="*") + '\n1. d4 d5 2. Nc3 Nc6 3. Bf4 Bf5 4. Qd2 Qd7 5. 0-0-0 O-O-O 6. e1g1 *\n',
    '[White "me"]\n[Black "you"]\n[FEN "8/P6k/8/8/8/8/6pK/8 w - - 0 1"]\n\n1. a8=Q g1=N+ *\n',
    '[White "me"]\n[Black "you"]\n\n1. a4 b5 2. axb5 a6 3. bxa6 Bb7 4. axb7 Nc6 5. bxa8Q Nb8 6. Qxb8 Qxb8 *\n',
    '[White "me"]\n[Black "you"]\n\n1. a4 b5 2. axb5 a6 3. bxa6 Bb7 4. axb7 Nc6 5. bxa8=N Nd4 6. bxa8 *\n',
    '[White "me"]\n[Black "you"]\n\n1. a4 b5 2. axb5 a6 3. bxa6 Bb7 4. axb7 Nc6 5. b7a8 *\n',
    '[White "me"]\n[Black "you"]\n\n1. a4 b5 2. axb5 a6 3. bxa6 Bb7 4. axb7 Nc6 5. b7a8q *\n',
    # null moves, a result inside a variation, en passant
    TAGS.format(result="*") + '\n1. e4 -- 2. d4 Z0 3. e5 d5 4. exd6 *\n',
    TAGS.format(result="1/2-1/2") + '\n1. e4 e5 (1... c5 1-0) 2. Nf3 1/2-1/2\n',
    # start positions: the FEN tag of the start, one that isn't, a broken one (on a variant: python-chess raises on
    # a broken FEN of a standard game), variants
    '[White "me"]\n[Black "you"]\n[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]\n\n1. e4 *\n',
    '[White "me"]\n[Black "you"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1... e5 *\n',
    '[White "me"]\n[Black "you"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 0 1"]\n\n1. e4 *\n',
    '[White "me"]\n[Black "you"]\n[Variant "Crazyhouse"]\n[FEN "not a fen"]\n\n1. e4 { a { comment\n\n} e5 *\n\n[White "me"]\n\n1. d4 *\n',
    '[White "me"]\n[Black "you"]\n[Variant "Chess960"]\n\n1. e4 *\n',
    '[White "me"]\n[Black "you"]\n[Variant "Chess"]\n\n1. e4 *\n',
    '[White "me"]\n[Black "you"]\n[Variant "Crazyhouse"]\n\n1. e4 d5 2. exd5 Qxd5 3. P@e4 *\n',
    '[White "me"]\n[Black "you"]\n[Variant ""]\n\n1. e4 *\n',
    # tags: malformed ones, one blank line inside the tag section (two end it), duplicates, Result filled from the
    # movetext only while "*"
    '[White "me"]\n[Black "you"]\n[Bad tag]\n\n[ECO "B00"]\n[ECO "B01"]\n\n1. e4 d5 1-0\n',
    '[White "me"]\n[Black "you"]\n\n\n[ECO "B00"]\n\n1. e4 *\n',
    '[White "me"]\n[Black "you"]\n[Result "0-1"]\n\n1. e4 1-0\n',
    # several games in one text, with and without blank lines between; ReviewAs; the user on neither side
    TAGS.format(result="1-0") + '\n1. e4 1-0\n\n' + TAGS.format(result="0-1") + '\n1. d4 0-1\n'
    + TAGS.format(result="*") + '\n1. c4 *\n' + '[ReviewAs "Black"]\n[White "a"]\n[Black "b"]\n\n1. f4 *\n'
    + '[White "a"]\n[Black "b"]\n\n1. g4 *\n',
    # dates, times, ratings, time controls, links, openings
    '[White "Me"]\n[Black "x"]\n[Date "2024.02.29"]\n[StartTime "1:2:3"]\n[WhiteElo "1500"]\n[BlackElo "?"]\n'
    '[TimeControl "600+5"]\n[Link "https://example.com/g/1"]\n[Opening "Sicilian"]\n\n1. e4 *\n',
    '[White "Me"]\n[Black "x"]\n[UTCDate "2023.02.29"]\n[Date "2023.03.01"]\n[TimeControl "1/86400"]\n'
    '[Site "https://lichess.org/abc"]\n[ECOUrl "https://www.chess.com/openings/Kings-Pawn-Opening-1...e5/"]\n\n1. e4 *\n',
    '[White "Me"]\n[Black "x"]\n[UTCDate "2023.1.5"]\n[UTCTime "23:59:60"]\n[TimeControl "-"]\n\n1. e4 *\n',
    '[White "Me"]\n[Black "x"]\n[UTCDate "2023.12.31"]\n[UTCTime " 9:05:07"]\n[TimeControl "abc"]\n\n1. e4 *\n',
    '[White "Me"]\n[Black "x"]\n[UTCDate "2023.12.31"]\n[UTCTime "09:05:07x"]\n[TimeControl "45+0"]\n'
    '[WhiteElo ""]\n[BlackElo "2100"]\n\n1. e4 *\n',
    '[White "Me"]\n[Black "x"]\n[Date "????.??.??"]\n[TimeControl "180+1"]\n\n1. e4 *\n',
    '[White ""]\n[Black "me"]\n[Result "0-1"]\n\n1. e4 0-1\n',
    # no moves at all; text after the last game; an unclosed comment
    '[White "me"]\n[Black "you"]\n\n*\n',
    '[White "me"]\n[Black "you"]\n\n1. e4 *\n\n\n   \n',
    '[White "me"]\n[Black "you"]\n\n1. e4 {[%clk 0:00:09] never closed\n2. d4\n',
]


def pgn_cases() -> list[dict]:
    fixture = FIXTURE.read_text(encoding="utf-8")
    cases = [{"text": fixture, "username": u, "digest": "fixture"} for u in ("testuser", "someone", "nobody")]
    cases += [{"text": t, "username": "me", "digest": f"case{i}"} for i, t in enumerate(PGN_TEXTS)]
    for c in cases:
        c["out"] = [list(r) for r in normalise.parse_pgn_text(c["text"], c["username"], c["digest"])]
    return cases


# --- chess.com and lichess games --------------------------------------------------------------------------------

def fixture_pgns() -> list[str]:
    return [g.strip() + "\n" for g in FIXTURE.read_text(encoding="utf-8").split("\n\n[Event ")
            for g in [g if g.startswith("[Event ") else "[Event " + g]]


def chesscom_cases() -> list[dict]:
    pgns = fixture_pgns()
    base = {"url": "https://www.chess.com/game/live/1", "pgn": pgns[0], "time_control": "180+2", "end_time": 1709374400,
            "rated": True, "time_class": "blitz", "rules": "chess",
            "white": {"rating": 1500, "result": "win", "username": "someone"},
            "black": {"rating": 1480, "result": "checkmated", "username": "TestUser"}}

    def g(**kw):
        out = copy.deepcopy(base)
        for k, v in kw.items():
            if isinstance(v, dict) and k in out:
                out[k].update(v)
            else:
                out[k] = v
        return out

    no_tags = "\n".join(l for l in pgns[0].splitlines() if not l.startswith(("[Termination", "[ECO", "[UTCDate", "[Date")))
    games = [
        (base, "testuser"), (base, "someone"), (base, "nobody"),
        (g(rules="chess960"), "testuser"),
        (g(black={"result": "agreed"}, white={"result": "agreed"}), "testuser"),
        (g(black={"result": "timevsinsufficient"}), "testuser"),
        (g(black={"result": "win"}, white={"result": "resigned"}), "testuser"),
        (g(pgn=no_tags), "testuser"),                                      # end_time stands in for the date
        (g(pgn=no_tags, white={"result": "timeout"}, black={"result": "win"}), "testuser"),
        (g(pgn=no_tags, end_time=None), "someone"),
        (g(black={"rating": None}, white={"username": ""}), "testuser"),
        (g(pgn='[Event "x"]\n[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n\n*\n'), "testuser"),
    ]
    if len(pgns) > 1:
        games.append((g(pgn=pgns[1], url="https://www.chess.com/game/live/2"), "testuser"))
    return [{"g": gm, "username": u, "out": rows(normalise.parse_chesscom(gm, u))} for gm, u in games]


LICHESS_PGN = """[Event "rated blitz game"]
[Site "https://lichess.org/PndlSDZg"]
[UTCDate "2026.10.12"]
[UTCTime "14:04:47"]
[White "thibault"]
[Black "Pehachzed"]
[Result "0-1"]
[Variant "Standard"]
[TimeControl "300+3"]
[ECO "C20"]

1. f3 { [%clk 0:05:00] } 1... e5 { [%clk 0:05:00] } 2. g4 { [%clk 0:04:58] } 2... Qh4# { [%clk 0:04:59] } 0-1
"""


def lichess_cases() -> list[dict]:
    def game(gid="PndlSDZg", created=1791813887348, **kw):
        g = {"id": gid, "rated": True, "variant": "standard", "speed": "blitz", "createdAt": created,
             "status": "mate", "winner": "black",
             "players": {"white": {"user": {"name": "thibault", "id": "thibault"}, "rating": 1749, "ratingDiff": -5},
                         "black": {"user": {"name": "Pehachzed", "id": "pehachzed"}, "rating": 1800, "ratingDiff": 7}},
             "opening": {"eco": "C20", "name": "Barnes Opening: Fool's Mate"},
             "clock": {"initial": 300, "increment": 3}, "pgn": LICHESS_PGN}
        g.update(kw)
        return g

    ai = {"white": {"user": {"name": "thibault", "id": "thibault"}, "rating": 1858}, "black": {"aiLevel": 3}}
    anon = {"white": {"user": {"name": "thibault", "id": "thibault"}}, "black": {}}
    games = [
        (game(), "Thibault"), (game(), "pehachzed"), (game(), "someone-else"),
        (game(speed="ultraBullet", winner=None, status="stalemate"), "pehachzed"),
        (game(speed="correspondence", clock=None, daysPerTurn=2), "thibault"),
        (game(clock=None), "thibault"),
        (game(clock={"initial": 60, "increment": 0}, speed="bullet", status="resign", winner="white"), "thibault"),
        (game(players=ai), "thibault"), (game(players=anon, winner="black", status="outoftime"), "thibault"),
        (game(winner=None, status="outoftime"), "thibault"), (game(winner=None, status="weird"), "thibault"),
        (game(winner=None, status=None), "thibault"), (game(winner="white", status="newStatus"), "thibault"),
        (game(opening=None), "thibault"), (game(opening={"name": ""}, speed="weird"), "thibault"),
        (game(variant="chess960"), "thibault"), (game(status="aborted"), "thibault"),
        (game(status="started"), "thibault"), (game(pgn=""), "thibault"),
        (game(created=1767225599999), "thibault"),
    ]
    return [{"g": gm, "username": u, "out": rows(normalise.parse_lichess(gm, u))} for gm, u in games]


# --- a whole build ------------------------------------------------------------------------------------------------

def build_case(files: dict, username: str) -> dict:
    """normalise.build over the given raw/ and pgn/ files, its rows caught on their way to parquet."""
    written = {}
    real = normalise.write_parquet
    normalise.write_parquet = lambda rs, schema, path: written.__setitem__(path.name, rs)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            prof = SimpleNamespace(username=username, dir=d, raw_dir=d / "raw", pgn_dir=d / "pgn",
                                   games_parquet=d / "games.parquet", positions_parquet=d / "positions.parquet")
            for kind, sub in (("chesscom", "raw"), ("lichess", "raw"), ("pgn", "pgn")):
                for f in files.get(kind, []):
                    (d / sub).mkdir(exist_ok=True)
                    (d / sub / f["name"]).write_bytes(f["text"].encode("utf-8"))
            stats = normalise.build(prof)
    finally:
        normalise.write_parquet = real
    return {"files": files, "username": username,
            "out": {"games": written["games.parquet"], "positions": written["positions.parquet"], "stats": stats}}


def made_up_builds() -> list[dict]:
    """Two profiles' worth of files: a chess.com player's months (a game in two of them: the first one counts) and
    pasted PGNs, then a lichess player's export."""
    games = [dict(c["g"], url=f'{c["g"]["url"]}{i}') for i, c in enumerate(chesscom_cases())]
    month = {"games": games[1:]}
    fixture = FIXTURE.read_text(encoding="utf-8")
    lines = [json.dumps(dict(c["g"], id=f'{c["g"]["id"]}{i}')) for i, c in enumerate(lichess_cases())]
    return [
        build_case({
            "chesscom": [{"name": "2024-03.json", "text": json.dumps(month, indent=1).replace("\n", "\r\n")},
                         {"name": "2024-02.json", "text": json.dumps({"games": games[:2]})}],
            "pgn": [{"name": "abc.pgn", "text": PGN_TEXTS[2] + "\n" + fixture.replace("someone", "TestUser", 1)},
                    {"name": "0ff.pgn", "text": fixture}],
        }, "testuser"),
        build_case({"lichess": [{"name": "2026-10.ndjson", "text": "\n".join(lines[:5]) + "\n\n"},
                                {"name": "2026-09.ndjson", "text": "\r\n".join(lines[5:]) + "\n"}]}, "thibault"),
    ]


# --- ingest.store_pgn ---------------------------------------------------------------------------------------------

def store_pgn_cases() -> list[list]:
    texts = ["1. e4 e5 *", "\r\n\r\n" + FIXTURE.read_text(encoding="utf-8") + "\r\n  \t",
             '[Event "a"]\n[Event "b"]\n1. e4 *\n\n[Event "c"]\n\n1. d4 *', 'x[Event "a"]\n\r[Event "b"]',
             "\x1c 1. e4 \x85", "﻿[Event \"é\"]\n\n1. e4 * ", "  ", ""]
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, text in enumerate(texts):
            for review_as in (None, "white", "black", "nobody"):
                prof = SimpleNamespace(pgn_dir=Path(tmp) / f"{i}-{review_as}")
                digest = ingest.store_pgn(prof, text, review_as)
                stored = (prof.pgn_dir / f"{digest}.pgn").read_bytes().decode("utf-8")
                out.append([text, review_as, digest, stored])
    return out


# --- local data -------------------------------------------------------------------------------------------------

def local() -> None:
    from chess_review import profiles
    out = OUT / "local"
    for profile in profiles.list_profiles():
        files = {"chesscom": [], "lichess": [], "pgn": []}
        for kind, d, ext in (("chesscom", profile.raw_dir, "json"), ("lichess", profile.raw_dir, "ndjson"),
                             ("pgn", profile.pgn_dir, "pgn")):
            for f in sorted(d.glob(f"*.{ext}")) if d.exists() else []:
                files[kind].append({"name": f.name, "text": f.read_bytes().decode("utf-8")})
        if any(files.values()):
            write(f"normalise-{profile.id}.json", build_case(files, profile.username), out)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--local", action="store_true", help="also dump every profile's raw files and rows to tests/parity/local/")
    args = p.parse_args(argv)
    write("normalise.json", {
        "time_class": [[tc, normalise._time_class(tc)] for tc in
                       [None, "", "-", "600", "600+0", "180+2", "60+1", "1/86400", "abc", "10+x", "+5", "300+",
                        " 300 + 2 ", "1_000", "179", "180", "599+0", "560+1", "-5+10"]],
        "pgn": pgn_cases(),
        "chesscom": chesscom_cases(),
        "lichess": lichess_cases(),
        "build": made_up_builds(),
        "store_pgn": store_pgn_cases(),
    })
    if args.local:
        local()


if __name__ == "__main__":
    main()
