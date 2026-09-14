"""Stage 5: GROUP BY queries over my classified moves -> data/site/insights.html.

Everything here is my moves only (moves.is_mine). "Bleed" is average win% lost
per move. Endgame conversion compares the result actually scored against the
win% at the moment the game became an endgame (both sides <= 6 points of
non-pawn material, queens off).
"""

import argparse
import html
import json
import logging

import chess

from .accuracy import game_accuracy
from .config import META_JSON, SITE_DIR
from .db import connect
from .pov import pov_win_pct

log = logging.getLogger("aggregates")

CLOCK_BUCKETS = [(0, 10, "< 10s"), (10, 30, "10-30s"), (30, 60, "30-60s"), (60, 180, "1-3 min"), (180, 300, "3-5 min"), (300, 10 ** 9, "5+ min")]
PLY_BUCKETS = [(0, 10, "1-5"), (10, 20, "6-10"), (20, 30, "11-15"), (30, 40, "16-20"), (40, 60, "21-30"), (60, 10 ** 9, "31+")]


def _case(col: str, buckets) -> str:
    return "CASE " + " ".join(f"WHEN {col} >= {lo} AND {col} < {hi} THEN '{lbl}'" for lo, hi, lbl in buckets) + " END"


def _order(buckets) -> str:
    return "CASE " + " ".join(f"WHEN '{lbl}' THEN {i}" for i, (_, _, lbl) in enumerate(buckets)) + " END"


def game_accuracies(con) -> dict[str, float]:
    """game_id -> my game accuracy (lichess aggregation), same number the review pages show."""
    rows = con.execute("SELECT m.*, g.my_colour FROM moves m JOIN games g USING (game_id) ORDER BY game_id, ply").fetch_arrow_table().to_pylist()
    by: dict[str, list[dict]] = {}
    for r in rows:
        by.setdefault(r["game_id"], []).append(r)
    out = {}
    for gid, ms in by.items():
        a = game_accuracy(ms, ms[0]["my_colour"])
        if a is not None:
            out[gid] = a
    return out


def query_all(con) -> dict:
    acc = game_accuracies(con)
    con.execute("CREATE TEMP TABLE game_acc (game_id TEXT, accuracy DOUBLE)")
    con.executemany("INSERT INTO game_acc VALUES (?, ?)", list(acc.items()))
    con.execute("""
        CREATE TEMP VIEW my AS
        SELECT m.*, g.eco, g.opening_name, g.time_class, g.my_colour, g.result, g.played_at, g.my_rating
        FROM moves m JOIN games g USING (game_id)
        WHERE m.is_mine AND m.wp_loss IS NOT NULL AND NOT m.in_book AND NOT m.is_forced
    """)
    out: dict = {}

    out["headline"] = con.execute("""
        SELECT count(DISTINCT game_id) games,
               round(100.0 * count(DISTINCT CASE WHEN result='win' THEN game_id END) / count(DISTINCT game_id), 1) win_rate,
               (SELECT round(avg(accuracy), 1) FROM game_acc) accuracy,
               round(avg(wp_loss), 2) bleed,
               round(1.0 * sum(label='blunder') / count(DISTINCT game_id), 2) blunders_per_game
        FROM my
    """).fetchone()

    out["by_eco"] = con.execute("""
        SELECT substr(eco, 1, 3) eco, any_value(opening_name) AS opening, count(DISTINCT game_id) games,
               round(avg(wp_loss), 2) bleed, round(100.0 * sum(label='blunder') / count(*), 1) blunder_pct,
               round(100.0 * count(DISTINCT CASE WHEN result='win' THEN game_id END) / count(DISTINCT game_id), 0) win_rate
        FROM my WHERE eco IS NOT NULL GROUP BY 1 HAVING games >= 3 ORDER BY bleed DESC LIMIT 15
    """).fetchall()

    out["by_ply"] = con.execute(f"""
        SELECT {_case('ply', PLY_BUCKETS)} bucket, count(*) moves, round(avg(wp_loss), 2) bleed,
               round(100.0 * sum(label='blunder') / count(*), 1) blunder_pct
        FROM my GROUP BY 1 ORDER BY {_order(PLY_BUCKETS).replace("CASE", "CASE bucket")}
    """).fetchall()

    out["eco_ply"] = con.execute(f"""
        WITH top AS (SELECT substr(eco,1,3) eco FROM my WHERE eco IS NOT NULL GROUP BY 1 ORDER BY count(DISTINCT game_id) DESC LIMIT 10)
        SELECT substr(eco,1,3) eco, {_case('ply', PLY_BUCKETS)} bucket, round(avg(wp_loss), 2) bleed, count(*) n
        FROM my WHERE substr(eco,1,3) IN (SELECT eco FROM top) GROUP BY 1, 2
    """).fetchall()

    out["by_clock"] = con.execute(f"""
        SELECT {_case('clock_remaining', CLOCK_BUCKETS)} bucket, count(*) moves,
               round(100.0 * sum(label='blunder') / count(*), 1) blunder_pct,
               round(100.0 * sum(label IN ('mistake','miss','blunder')) / count(*), 1) mistake_pct,
               round(avg(wp_loss), 2) bleed
        FROM my WHERE clock_remaining IS NOT NULL GROUP BY 1 ORDER BY {_order(CLOCK_BUCKETS).replace("CASE", "CASE bucket")}
    """).fetchall()

    out["by_colour"] = con.execute("""
        SELECT my_colour, count(DISTINCT game_id) games,
               round(100.0 * count(DISTINCT CASE WHEN result='win' THEN game_id END) / count(DISTINCT game_id), 1) win_rate,
               (SELECT round(avg(accuracy), 1) FROM game_acc a JOIN games g2 USING (game_id) WHERE g2.my_colour = my.my_colour) accuracy,
               round(avg(wp_loss), 2) bleed,
               round(100.0 * sum(label='blunder') / count(*), 1) blunder_pct
        FROM my GROUP BY 1 ORDER BY 1 DESC
    """).fetchall()

    out["by_time_class"] = con.execute("""
        SELECT time_class, count(DISTINCT game_id) games,
               (SELECT round(avg(accuracy), 1) FROM game_acc a JOIN games g2 USING (game_id) WHERE g2.time_class = my.time_class) accuracy,
               round(avg(wp_loss), 2) bleed, round(100.0 * sum(label='blunder') / count(*), 1) blunder_pct
        FROM my GROUP BY 1 ORDER BY games DESC
    """).fetchall()

    out["over_time"] = con.execute("""
        SELECT g.game_id, g.played_at, round(a.accuracy, 1) accuracy, g.result, g.my_rating
        FROM games g JOIN game_acc a USING (game_id) ORDER BY g.played_at
    """).fetchall()

    out["endgames"] = endgame_conversion(con)
    return out


def _config(board: chess.Board, colour: chess.Color) -> tuple[int, str]:
    pts, letters = 0, ""
    for pt, v in ((chess.QUEEN, 9), (chess.ROOK, 5), (chess.BISHOP, 3), (chess.KNIGHT, 3)):
        n = len(board.pieces(pt, colour))
        pts += n * v
        letters += chess.piece_symbol(pt).upper() * n
    return pts, letters or "P"


def endgame_conversion(con) -> list[tuple]:
    """Per material configuration at endgame entry: expected points (from win%) vs actual."""
    rows = con.execute("""
        SELECT p.game_id, p.ply, p.fen, g.my_colour, g.result, e.eval_cp, e.mate_in, p.side_to_move
        FROM positions p JOIN games g USING (game_id) LEFT JOIN evals e USING (fen_key)
        ORDER BY p.game_id, p.ply
    """).fetchall()
    entries: dict[str, list[tuple[float, float]]] = {}
    seen = set()
    for gid, _ply, fen, colour, result, cp, mate, stm in rows:
        if gid in seen or (cp is None and mate is None):
            continue
        b = chess.Board(fen)
        wpts, wcfg = _config(b, chess.WHITE)
        bpts, bcfg = _config(b, chess.BLACK)
        if wpts > 6 or bpts > 6:
            continue
        seen.add(gid)
        mine, theirs = (wcfg, bcfg) if colour == "white" else (bcfg, wcfg)
        key = f"{mine} vs {theirs}"
        expected = pov_win_pct(cp, mate, stm, colour) / 100
        actual = {"win": 1.0, "draw": 0.5, "loss": 0.0}.get(result)
        if actual is None:
            continue
        entries.setdefault(key, []).append((expected, actual))
    out = []
    for key, vals in entries.items():
        n = len(vals)
        exp = sum(v[0] for v in vals) / n
        act = sum(v[1] for v in vals) / n
        out.append((key, n, round(exp * 100, 0), round(act * 100, 0), round((act - exp) * 100, 0)))
    out.sort(key=lambda r: -r[1])
    return out[:15]


# --- rendering ---------------------------------------------------------------

def _bars(rows, label_i, value_i, fmt="{:.1f}", unit="", width=420, colour="#81b64c", tip=None) -> str:
    if not rows:
        return '<div class="empty">no data</div>'
    vmax = max(r[value_i] or 0 for r in rows) or 1
    h, gap = 22, 6
    height = len(rows) * (h + gap)
    parts = [f'<svg class="chart" viewBox="0 0 {width} {height}" width="{width}" height="{height}">']
    for i, r in enumerate(rows):
        y = i * (h + gap)
        v = r[value_i] or 0
        w = max(2, (width - 200) * v / vmax)
        t = tip(r) if tip else f"{r[label_i]}: {fmt.format(v)}{unit}"
        parts.append(f'<text x="0" y="{y + 15}" class="lbl">{html.escape(str(r[label_i]))}</text>')
        parts.append(f'<rect x="130" y="{y + 3}" width="{w:.1f}" height="{h - 6}" rx="3" fill="{colour}"><title>{html.escape(t)}</title></rect>')
        parts.append(f'<text x="{134 + w:.1f}" y="{y + 15}" class="val">{fmt.format(v)}{unit}</text>')
    parts.append("</svg>")
    return "".join(parts)


def _line(points: list[tuple[str, float]], rolling: int = 10, width=760, height=180) -> str:
    if len(points) < 2:
        return '<div class="empty">not enough games</div>'
    vals = [p[1] for p in points]
    roll = [sum(vals[max(0, i - rolling + 1):i + 1]) / len(vals[max(0, i - rolling + 1):i + 1]) for i in range(len(vals))]
    n = len(vals)
    pad_l, pad_b = 34, 18
    x = lambda i: pad_l + i * (width - pad_l - 8) / (n - 1)  # noqa: E731
    y = lambda v: (height - pad_b) - v / 100 * (height - pad_b - 8)  # noqa: E731
    dots = "".join(f'<circle cx="{x(i):.1f}" cy="{y(v):.1f}" r="2.5" fill="#9a958d" opacity=".7"><title>{html.escape(points[i][0])}: {v:.1f}%</title></circle>' for i, v in enumerate(vals))
    path = "M" + " L".join(f"{x(i):.1f},{y(v):.1f}" for i, v in enumerate(roll))
    grid = "".join(f'<line x1="{pad_l}" x2="{width}" y1="{y(g):.1f}" y2="{y(g):.1f}" stroke="#45423d" stroke-width=".8"/>'
                   f'<text x="{pad_l - 6}" y="{y(g) + 4:.1f}" class="tick" text-anchor="end">{g}</text>' for g in (25, 50, 75, 100))
    first, last = points[0][0][:10], points[-1][0][:10]
    return (f'<svg class="chart" viewBox="0 0 {width} {height}" width="100%" height="{height}">{grid}{dots}'
            f'<path d="{path}" fill="none" stroke="#81b64c" stroke-width="2"/>'
            f'<text x="{pad_l}" y="{height - 4}" class="tick">{first}</text><text x="{width}" y="{height - 4}" class="tick" text-anchor="end">{last}</text></svg>'
            f'<div class="legend"><span class="sw" style="background:#81b64c"></span>{rolling}-game rolling accuracy '
            f'<span class="sw" style="background:#9a958d;border-radius:50%"></span>per game</div>')


def _table(headers: list[str], rows, fmts=None) -> str:
    fmts = fmts or {}
    th = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
    body = []
    for r in rows:
        tds = []
        for i, v in enumerate(r):
            s = "" if v is None else (fmts[i].format(v) if i in fmts else str(v))
            cls = ' class="num"' if isinstance(v, (int, float)) else ""
            tds.append(f"<td{cls}>{html.escape(s)}</td>")
        body.append("<tr>" + "".join(tds) + "</tr>")
    return f'<table class="t"><thead><tr>{th}</tr></thead><tbody>{"".join(body)}</tbody></table>'


def _heatmap(eco_ply) -> str:
    ecos = sorted({r[0] for r in eco_ply})
    buckets = [b[2] for b in PLY_BUCKETS]
    cell = {(r[0], r[1]): (r[2], r[3]) for r in eco_ply}
    vmax = max((r[2] for r in eco_ply), default=1) or 1
    head = "<th>ECO</th>" + "".join(f"<th>{b}</th>" for b in buckets)
    rows = []
    for e in ecos:
        tds = [f"<td>{e}</td>"]
        for b in buckets:
            v, n = cell.get((e, b), (None, 0))
            if v is None:
                tds.append("<td></td>")
            else:
                a = 0.15 + 0.75 * v / vmax
                tds.append(f'<td class="num" style="background:rgba(250,65,45,{a:.2f})" title="{n} moves">{v:.1f}</td>')
        rows.append("<tr>" + "".join(tds) + "</tr>")
    return f'<table class="t heat"><thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table><div class="note">avg win% lost per move; darker = worse. Move ranges are move numbers.</div>'


def render(d: dict, username: str) -> str:
    h = d["headline"]
    tiles = "".join(f'<div class="tile"><div class="v">{v}</div><div class="k">{k}</div></div>' for k, v in (
        ("games", h[0]), ("win rate", f"{h[1]}%"), ("avg accuracy", f"{h[2]}%"),
        ("win% lost / move", h[3]), ("blunders / game", h[4])))
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Insights · {html.escape(username)}</title>
<style>
:root {{ --bg:#262421; --panel:#302e2b; --panel2:#3a3733; --line:#45423d; --text:#e6e3de; --muted:#9a958d; --accent:#81b64c; }}
body {{ margin:0; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }}
header {{ display:flex; gap:16px; align-items:center; padding:10px 18px; background:var(--panel); border-bottom:1px solid var(--line); }}
header h1 {{ font-size:18px; margin:0; }} header a {{ color:inherit; text-decoration:none; }} header .nav a {{ color:var(--muted); margin-left:14px; }}
main {{ max-width:1100px; margin:0 auto; padding:16px 18px; }}
.tiles {{ display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:18px; }}
.tile {{ background:var(--panel); border-radius:8px; padding:12px 14px; }} .tile .v {{ font-size:24px; font-weight:700; }} .tile .k {{ color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }}
section {{ background:var(--panel); border-radius:8px; padding:14px 16px; margin-bottom:14px; }}
h2 {{ font-size:15px; margin:0 0 4px; }} .sub {{ color:var(--muted); font-size:12px; margin-bottom:10px; }}
.grid2 {{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }} @media (max-width:800px) {{ .grid2 {{ grid-template-columns:1fr; }} .tiles {{ grid-template-columns:repeat(2,1fr);}} }}
svg.chart {{ max-width:100%; display:block; }} svg .lbl {{ fill:var(--text); font-size:12px; }} svg .val {{ fill:var(--muted); font-size:11px; }} svg .tick {{ fill:var(--muted); font-size:10px; }}
table.t {{ border-collapse:collapse; width:100%; }} table.t th, table.t td {{ padding:5px 8px; border-bottom:1px solid var(--line); text-align:left; }}
table.t th {{ color:var(--muted); font-weight:500; font-size:12px; }} td.num {{ text-align:right; font-variant-numeric:tabular-nums; }}
table.heat td.num {{ text-align:center; }} .note {{ color:var(--muted); font-size:12px; margin-top:6px; }}
.legend {{ color:var(--muted); font-size:12px; margin-top:6px; }} .sw {{ display:inline-block; width:10px; height:10px; margin:0 4px 0 10px; vertical-align:-1px; }}
.empty {{ color:var(--muted); padding:16px; }}
</style></head><body>
<header><h1><a href="index.html">♞ Chess Review</a></h1><span class="nav"><a href="index.html">Games</a><a href="insights.html" style="color:var(--text)">Insights</a></span></header>
<main>
<div class="tiles">{tiles}</div>

<section><h2>Accuracy over time</h2><div class="sub">Per game, with a rolling average. Am I improving?</div>
{_line([(str(r[1]), r[2]) for r in d["over_time"] if r[2] is not None])}</section>

<div class="grid2">
<section><h2>Blunder rate by clock remaining</h2><div class="sub">% of my moves that were blunders, by time left when I played them.</div>
{_bars(d["by_clock"], 0, 2, unit="%", colour="#fa412d", tip=lambda r: f"{r[0]}: {r[2]}% blunders, {r[3]}% mistakes+, {r[1]} moves")}</section>
<section><h2>Win% lost by game phase</h2><div class="sub">Average win% lost per move, by move number.</div>
{_bars(d["by_ply"], 0, 2, tip=lambda r: f"moves {r[0]}: {r[2]} win% lost/move, {r[3]}% blunders, {r[1]} moves")}</section>
</div>

<section><h2>Openings that cost me most</h2><div class="sub">Average win% lost per move in games by ECO code (min 3 games).</div>
{_table(["ECO", "Opening (example)", "Games", "Win% lost / move", "Blunder %", "Win rate %"], d["by_eco"], {3: "{:.2f}", 4: "{:.1f}", 5: "{:.0f}"})}</section>

<section><h2>Where in the game each opening bleeds</h2><div class="sub">Top 10 ECO codes by games played.</div>{_heatmap(d["eco_ply"])}</section>

<div class="grid2">
<section><h2>White vs Black</h2>
{_table(["Colour", "Games", "Win rate %", "Accuracy", "Win% lost / move", "Blunder %"], d["by_colour"], {2: "{:.1f}", 3: "{:.1f}", 4: "{:.2f}", 5: "{:.1f}"})}</section>
<section><h2>By time control</h2>
{_table(["Class", "Games", "Accuracy", "Win% lost / move", "Blunder %"], d["by_time_class"], {2: "{:.1f}", 3: "{:.2f}", 4: "{:.1f}"})}</section>
</div>

<section><h2>Endgame conversion</h2><div class="sub">Material when the game became an endgame (my pieces vs theirs, queens off, ≤ 6 points each). Expected = engine win% at that moment; actual = points scored. Positive diff = I convert better than the engine expects.</div>
{_table(["Material", "Games", "Expected %", "Actual %", "Diff"], d["endgames"], {2: "{:.0f}", 3: "{:.0f}", 4: "{:+.0f}"})}</section>
</main></body></html>"""


def build() -> dict:
    con = connect()
    d = query_all(con)
    username = json.loads(META_JSON.read_text())["username"] if META_JSON.exists() else "me"
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    (SITE_DIR / "insights.html").write_text(render(d, username), encoding="utf-8")
    return {"games": d["headline"][0], "out": str(SITE_DIR / "insights.html")}


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="aggregates", description=__doc__)
    p.parse_args(argv)
    log.info("done: %s", build())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
