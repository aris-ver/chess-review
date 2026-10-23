// chess_review/aggregates.py: GROUP BY queries over my classified moves -> the profile's site/insights.html.
//
// Everything here is my moves only (moves.is_mine). "Bleed" is average win% lost per move. Endgame conversion compares
// the result actually scored against the win% at the moment the game became an endgame (both sides <= 6 points of
// non-pawn material, queens off).
//
// The queries are DuckDB's as they were, on SQLite (db.js's profile connection, evals attached). Where they can't be
// the same:
//   - round() is done here, not in SQL: SQLite's round() rounds the decimal digits, DuckDB's is
//     std::round(x * 10^n) / 10^n, and the two disagree on values just under a half (sqlRound below is DuckDB's).
//     So the queries select the unrounded value and ORDER BY it, which orders rounded ties among themselves where
//     DuckDB leaves them in any order.
//   - any_value(opening_name) is a bare column: SQLite takes it from some row of the group, as any_value does.
//   - DuckDB sorts NULLs last, SQLite first: over_time says NULLS LAST (a pasted game without a date).
//   - DuckDB's 0.0 / 0 is NaN, SQLite's NULL: the headline's win rate of a profile with no analysed move is NaN, as
//     in Python ("nan%" on the page).
//   - Python's connection is a fresh one per build; this one is shared, so the temp table and view are dropped after.
// Python fetches rows as tuples; they are arrays here, in the same column order, so render() reads them by index.

import { gameAccuracy } from '../core/accuracy.js';
import { povWinPct } from '../core/pov.js';
import { formatFixed, pyRound, pySum } from '../core/py.js';

export const CLOCK_BUCKETS = [[0, 10, '< 10s'], [10, 30, '10-30s'], [30, 60, '30-60s'], [60, 180, '1-3 min'], [180, 300, '3-5 min'], [300, 10 ** 9, '5+ min']];
export const PLY_BUCKETS = [[0, 10, '1-5'], [10, 20, '6-10'], [20, 30, '11-15'], [30, 40, '16-20'], [40, 60, '21-30'], [60, 10 ** 9, '31+']];

const caseOf = (col, buckets) => 'CASE ' + buckets.map(([lo, hi, lbl]) => `WHEN ${col} >= ${lo} AND ${col} < ${hi} THEN '${lbl}'`).join(' ') + ' END';
const orderOf = buckets => 'CASE ' + buckets.map(([, , lbl], i) => `WHEN '${lbl}' THEN ${i}`).join(' ') + ' END';

/** DuckDB's round(x, n) on a DOUBLE: std::round(x * 10^n) / 10^n, halves away from zero. NULL stays NULL. */
export function sqlRound(x, nd) {
  if (x === null || x === undefined) return null;
  if (!Number.isFinite(x)) return x;
  const m = 10 ** nd;
  return (Math.sign(x) * Math.round(Math.abs(x * m))) / m;
}

/** row (an object) as an array of its columns, each rounded to rounds[i] decimals where given. */
const tuple = (row, rounds = {}) => Object.values(row).map((v, i) => (i in rounds ? sqlRound(v, rounds[i]) : v));

/** game_id -> my game accuracy (lichess aggregation), same number the review pages show. */
export function gameAccuracies(db) {
  const rows = db.all('SELECT m.*, g.my_colour FROM moves m JOIN games g USING (game_id) ORDER BY game_id, ply');
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.game_id)) by.set(r.game_id, []);
    by.get(r.game_id).push(r);
  }
  const out = new Map();
  for (const [gid, ms] of by) {
    const a = gameAccuracy(ms, ms[0].my_colour);
    if (a !== null) out.set(gid, a);
  }
  return out;
}

/** Every number insights.html shows: {headline, by_eco, by_ply, eco_ply, by_clock, by_colour, by_time_class,
 * over_time, endgames}, rows as arrays in aggregates.query_all's column order. */
export function queryAll(db) {
  const acc = gameAccuracies(db);
  db.exec('DROP VIEW IF EXISTS temp.my; DROP TABLE IF EXISTS temp.game_acc;');
  try {
    db.exec('CREATE TEMP TABLE game_acc (game_id TEXT, accuracy DOUBLE)');
    db.tx(() => {
      for (const [gid, a] of acc) db.run('INSERT INTO game_acc VALUES (?, ?)', [gid, a]);
    });
    db.exec(`
      CREATE TEMP VIEW my AS
      SELECT m.*, g.eco, g.opening_name, g.time_class, g.my_colour, g.result, g.played_at, g.my_rating
      FROM moves m JOIN games g USING (game_id)
      WHERE m.is_mine AND m.wp_loss IS NOT NULL AND NOT m.in_book AND NOT m.is_forced
    `);
    return query(db);
  } finally {
    db.exec('DROP VIEW IF EXISTS temp.my; DROP TABLE IF EXISTS temp.game_acc;');
  }
}

function query(db) {
  const out = {};

  const h = tuple(db.get(`
    SELECT count(DISTINCT game_id) games,
           100.0 * count(DISTINCT CASE WHEN result='win' THEN game_id END) / count(DISTINCT game_id) win_rate,
           (SELECT avg(accuracy) FROM game_acc) accuracy,
           avg(wp_loss) bleed,
           1.0 * sum(label='blunder') / count(DISTINCT game_id) blunders_per_game
    FROM my
  `), { 1: 1, 2: 1, 3: 2, 4: 2 });
  if (h[0] === 0) h[1] = NaN;     // DuckDB: 0.0 / 0
  out.headline = h;

  out.by_eco = db.all(`
    SELECT substr(eco, 1, 3) eco, opening_name AS opening, count(DISTINCT game_id) games,
           avg(wp_loss) bleed, 100.0 * sum(label='blunder') / count(*) blunder_pct,
           100.0 * count(DISTINCT CASE WHEN result='win' THEN game_id END) / count(DISTINCT game_id) win_rate
    FROM my WHERE eco IS NOT NULL GROUP BY 1 HAVING games >= 3 ORDER BY bleed DESC LIMIT 15
  `).map(r => tuple(r, { 3: 2, 4: 1, 5: 0 }));

  out.by_ply = db.all(`
    SELECT ${caseOf('ply', PLY_BUCKETS)} bucket, count(*) moves, avg(wp_loss) bleed,
           100.0 * sum(label='blunder') / count(*) blunder_pct
    FROM my GROUP BY 1 ORDER BY ${orderOf(PLY_BUCKETS).replace('CASE', 'CASE bucket')}
  `).map(r => tuple(r, { 2: 2, 3: 1 }));

  out.eco_ply = db.all(`
    WITH top AS (SELECT substr(eco,1,3) eco FROM my WHERE eco IS NOT NULL GROUP BY 1 ORDER BY count(DISTINCT game_id) DESC LIMIT 10)
    SELECT substr(eco,1,3) eco, ${caseOf('ply', PLY_BUCKETS)} bucket, avg(wp_loss) bleed, count(*) n
    FROM my WHERE substr(eco,1,3) IN (SELECT eco FROM top) GROUP BY 1, 2
  `).map(r => tuple(r, { 2: 2 }));

  out.by_clock = db.all(`
    SELECT ${caseOf('clock_remaining', CLOCK_BUCKETS)} bucket, count(*) moves,
           100.0 * sum(label='blunder') / count(*) blunder_pct,
           100.0 * sum(label IN ('mistake','miss','blunder')) / count(*) mistake_pct,
           avg(wp_loss) bleed
    FROM my WHERE clock_remaining IS NOT NULL GROUP BY 1 ORDER BY ${orderOf(CLOCK_BUCKETS).replace('CASE', 'CASE bucket')}
  `).map(r => tuple(r, { 2: 1, 3: 1, 4: 2 }));

  out.by_colour = db.all(`
    SELECT my_colour, count(DISTINCT game_id) games,
           100.0 * count(DISTINCT CASE WHEN result='win' THEN game_id END) / count(DISTINCT game_id) win_rate,
           (SELECT avg(accuracy) FROM game_acc a JOIN games g2 USING (game_id) WHERE g2.my_colour = my.my_colour) accuracy,
           avg(wp_loss) bleed,
           100.0 * sum(label='blunder') / count(*) blunder_pct
    FROM my GROUP BY 1 ORDER BY 1 DESC
  `).map(r => tuple(r, { 2: 1, 3: 1, 4: 2, 5: 1 }));

  out.by_time_class = db.all(`
    SELECT time_class, count(DISTINCT game_id) games,
           (SELECT avg(accuracy) FROM game_acc a JOIN games g2 USING (game_id) WHERE g2.time_class = my.time_class) accuracy,
           avg(wp_loss) bleed, 100.0 * sum(label='blunder') / count(*) blunder_pct
    FROM my GROUP BY 1 ORDER BY games DESC
  `).map(r => tuple(r, { 2: 1, 3: 2, 4: 1 }));

  out.over_time = db.all(`
    SELECT g.game_id, g.played_at, a.accuracy, g.result, g.my_rating
    FROM games g JOIN game_acc a USING (game_id) ORDER BY g.played_at NULLS LAST
  `).map(r => tuple(r, { 2: 1 }));

  out.endgames = endgameConversion(db);
  return out;
}

const VALUES = [['Q', 9], ['R', 5], ['B', 3], ['N', 3]];

/** aggregates._config: [points, letters] of one side's non-pawn pieces, from a FEN's board. */
function config(placement, white) {
  let pts = 0, letters = '';
  for (const [p, v] of VALUES) {
    const n = placement.split(white ? p : p.toLowerCase()).length - 1;
    pts += n * v;
    letters += p.repeat(n);
  }
  return [pts, letters || 'P'];
}

const POINTS = { win: 1.0, draw: 0.5, loss: 0.0 };

/** Per material configuration at endgame entry: expected points (from win%) vs actual. */
export function endgameConversion(db) {
  const rows = db.all(`
    SELECT p.game_id, p.ply, p.fen, g.my_colour, g.result, e.eval_cp, e.mate_in, p.side_to_move
    FROM positions p JOIN games g USING (game_id) LEFT JOIN evals e USING (fen_key)
    ORDER BY p.game_id, p.ply
  `);
  const entries = new Map();
  const seen = new Set();
  for (const { game_id: gid, fen, my_colour: colour, result, eval_cp: cp, mate_in: mate, side_to_move: stm } of rows) {
    if (seen.has(gid) || (cp === null && mate === null)) continue;
    const placement = fen.split(' ')[0];
    const [wpts, wcfg] = config(placement, true);
    const [bpts, bcfg] = config(placement, false);
    if (wpts > 6 || bpts > 6) continue;
    seen.add(gid);
    const [mine, theirs] = colour === 'white' ? [wcfg, bcfg] : [bcfg, wcfg];
    const key = `${mine} vs ${theirs}`;
    const expected = povWinPct(cp, mate, stm, colour) / 100;
    const actual = POINTS[result];
    if (actual === undefined) continue;
    if (!entries.has(key)) entries.set(key, []);
    entries.get(key).push([expected, actual]);
  }
  const out = [];
  for (const [key, vals] of entries) {
    const n = vals.length;
    const exp = pySum(vals.map(v => v[0])) / n;
    const act = pySum(vals.map(v => v[1])) / n;
    out.push([key, n, pyRound(exp * 100, 0), pyRound(act * 100, 0), pyRound((act - exp) * 100, 0)]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out.slice(0, 15);
}

// --- rendering ---------------------------------------------------------------

/** html.escape(s) */
export const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** str(x) of a Python float: repr's shortest digits, ".0" on whole numbers, exponent outside 1e-4 <= |x| < 1e16. */
export function floatStr(x) {
  if (x === null || x === undefined) return 'None';
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, e] = x.toExponential().split('e');
  const exp = Number(e);
  const sign = mant.startsWith('-') ? '-' : '';
  const digits = mant.replace(/^-/, '').replace('.', '');
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
  return `${sign}${int}.${digits.slice(exp + 1) || '0'}`;
}

/** str(v) for what a query gives back: an int column's int, a float column's float (floats[i]), None, a string. */
const str = (v, isFloat = false) => (v === null || v === undefined ? 'None' : typeof v === 'number' ? (isFloat ? floatStr(v) : String(v)) : String(v));

/** A format spec of the ones the page uses ("{:.2f}", "{:+.0f}") applied to a number. */
function format(spec, v) {
  const m = /^\{:(\+?)\.(\d)f\}$/.exec(spec);
  if (!m) throw new Error(`unknown format ${spec}`);
  const s = formatFixed(v, Number(m[2]));
  return m[1] && !s.startsWith('-') ? '+' + s : s;
}

function bars(rows, labelI, valueI, { fmt = '{:.1f}', unit = '', width = 420, colour = '#81b64c', tip = null } = {}) {
  if (!rows.length) return '<div class="empty">no data</div>';
  const vmax = Math.max(...rows.map(r => r[valueI] || 0)) || 1;
  const h = 22, gap = 6;
  const height = rows.length * (h + gap);
  const parts = [`<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`];
  rows.forEach((r, i) => {
    const y = i * (h + gap);
    const v = r[valueI] || 0;
    const w = Math.max(2, ((width - 200) * v) / vmax);
    const t = tip ? tip(r) : `${str(r[labelI])}: ${format(fmt, v)}${unit}`;
    parts.push(`<text x="0" y="${y + 15}" class="lbl">${escape(str(r[labelI]))}</text>`);
    parts.push(`<rect x="130" y="${y + 3}" width="${formatFixed(w, 1)}" height="${h - 6}" rx="3" fill="${colour}"><title>${escape(t)}</title></rect>`);
    parts.push(`<text x="${formatFixed(134 + w, 1)}" y="${y + 15}" class="val">${format(fmt, v)}${unit}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/** str(played_at) of a datetime: isoformat with a space. */
const pyDatetime = v => (v === null || v === undefined ? 'None' : String(v).replace('T', ' '));

function line(points, rolling = 10, width = 760, height = 180) {
  if (points.length < 2) return '<div class="empty">not enough games</div>';
  const vals = points.map(p => p[1]);
  const roll = vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - rolling + 1), i + 1);
    return pySum(w) / w.length;
  });
  const n = vals.length;
  const padL = 34, padB = 18;
  const x = i => padL + (i * (width - padL - 8)) / (n - 1);
  const y = v => (height - padB) - (v / 100) * (height - padB - 8);
  const f1 = v => formatFixed(v, 1);
  const dots = vals.map((v, i) => `<circle cx="${f1(x(i))}" cy="${f1(y(v))}" r="2.5" fill="#9a958d" opacity=".7"><title>${escape(points[i][0])}: ${f1(v)}%</title></circle>`).join('');
  const path = 'M' + roll.map((v, i) => `${f1(x(i))},${f1(y(v))}`).join(' L');
  const grid = [25, 50, 75, 100].map(g => `<line x1="${padL}" x2="${width}" y1="${f1(y(g))}" y2="${f1(y(g))}" stroke="#45423d" stroke-width=".8"/>`
    + `<text x="${padL - 6}" y="${f1(y(g) + 4)}" class="tick" text-anchor="end">${g}</text>`).join('');
  const first = points[0][0].slice(0, 10), last = points.at(-1)[0].slice(0, 10);
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}">${grid}${dots}`
    + `<path d="${path}" fill="none" stroke="#81b64c" stroke-width="2"/>`
    + `<text x="${padL}" y="${height - 4}" class="tick">${first}</text><text x="${width}" y="${height - 4}" class="tick" text-anchor="end">${last}</text></svg>`
    + `<div class="legend"><span class="sw" style="background:#81b64c"></span>${rolling}-game rolling accuracy `
    + '<span class="sw" style="background:#9a958d;border-radius:50%"></span>per game</div>';
}

function table(headers, rows, fmts = {}) {
  const th = headers.map(h => `<th>${escape(h)}</th>`).join('');
  const body = rows.map(r => '<tr>' + r.map((v, i) => {
    const s = v === null || v === undefined ? '' : i in fmts ? format(fmts[i], v) : str(v);
    const cls = typeof v === 'number' ? ' class="num"' : '';
    return `<td${cls}>${escape(s)}</td>`;
  }).join('') + '</tr>');
  return `<table class="t"><thead><tr>${th}</tr></thead><tbody>${body.join('')}</tbody></table>`;
}

function heatmap(ecoPly) {
  const ecos = [...new Set(ecoPly.map(r => r[0]))].sort();
  const buckets = PLY_BUCKETS.map(b => b[2]);
  const cell = new Map(ecoPly.map(r => [`${r[0]}\0${r[1]}`, [r[2], r[3]]]));
  const vmax = (ecoPly.length ? Math.max(...ecoPly.map(r => r[2])) : 1) || 1;
  const head = '<th>ECO</th>' + buckets.map(b => `<th>${b}</th>`).join('');
  const rows = ecos.map(e => {
    const tds = [`<td>${e}</td>`];
    for (const b of buckets) {
      const [v, n] = cell.get(`${e}\0${b}`) ?? [null, 0];
      if (v === null) tds.push('<td></td>');
      else {
        const a = 0.15 + (0.75 * v) / vmax;
        tds.push(`<td class="num" style="background:rgba(250,65,45,${formatFixed(a, 2)})" title="${n} moves">${formatFixed(v, 1)}</td>`);
      }
    }
    return '<tr>' + tds.join('') + '</tr>';
  });
  return `<table class="t heat"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table><div class="note">avg win% lost per move; darker = worse. Move ranges are move numbers.</div>`;
}

/** The insights page for queryAll's numbers, as aggregates.render writes it. */
export function render(d, username, profileId = '') {
  const h = d.headline;
  const f = v => floatStr(v);
  const tiles = [['games', String(h[0])], ['win rate', `${f(h[1])}%`], ['avg accuracy', `${f(h[2])}%`],
    ['win% lost / move', f(h[3])], ['blunders / game', f(h[4])]]
    .map(([k, v]) => `<div class="tile"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Insights · ${escape(username)}</title>
<style>
:root { --bg:#262421; --panel:#302e2b; --panel2:#3a3733; --line:#45423d; --text:#e6e3de; --muted:#9a958d; --accent:#81b64c; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
header { display:flex; gap:16px; align-items:center; padding:10px 18px; background:var(--panel); border-bottom:1px solid var(--line); }
header h1 { font-size:18px; margin:0; } header a { color:inherit; text-decoration:none; } header .nav a { color:var(--muted); margin-left:14px; }
main { max-width:1100px; margin:0 auto; padding:16px 18px; }
.tiles { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:18px; }
.tile { background:var(--panel); border-radius:8px; padding:12px 14px; } .tile .v { font-size:24px; font-weight:700; } .tile .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
section { background:var(--panel); border-radius:8px; padding:14px 16px; margin-bottom:14px; }
h2 { font-size:15px; margin:0 0 4px; } .sub { color:var(--muted); font-size:12px; margin-bottom:10px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; } @media (max-width:800px) { .grid2 { grid-template-columns:1fr; } .tiles { grid-template-columns:repeat(2,1fr);} }
svg.chart { max-width:100%; display:block; } svg .lbl { fill:var(--text); font-size:12px; } svg .val { fill:var(--muted); font-size:11px; } svg .tick { fill:var(--muted); font-size:10px; }
table.t { border-collapse:collapse; width:100%; } table.t th, table.t td { padding:5px 8px; border-bottom:1px solid var(--line); text-align:left; }
table.t th { color:var(--muted); font-weight:500; font-size:12px; } td.num { text-align:right; font-variant-numeric:tabular-nums; }
table.heat td.num { text-align:center; } .note { color:var(--muted); font-size:12px; margin-top:6px; }
.legend { color:var(--muted); font-size:12px; margin-top:6px; } .sw { display:inline-block; width:10px; height:10px; margin:0 4px 0 10px; vertical-align:-1px; }
.empty { color:var(--muted); padding:16px; }
</style></head><body>
<header><h1><a href="../../">♞ Blundr</a></h1><span class="nav"><a href="../../#/p/${profileId}">Games</a><a href="insights.html" style="color:var(--text)">Insights</a></span></header>
<main>
<div class="tiles">${tiles}</div>

<section><h2>Accuracy over time</h2><div class="sub">Per game, with a rolling average. Am I improving?</div>
${line(d.over_time.filter(r => r[2] !== null).map(r => [pyDatetime(r[1]), r[2]]))}</section>

<div class="grid2">
<section><h2>Blunder rate by clock remaining</h2><div class="sub">% of my moves that were blunders, by time left when I played them.</div>
${bars(d.by_clock, 0, 2, { unit: '%', colour: '#fa412d', tip: r => `${str(r[0])}: ${f(r[2])}% blunders, ${f(r[3])}% mistakes+, ${r[1]} moves` })}</section>
<section><h2>Win% lost by game phase</h2><div class="sub">Average win% lost per move, by move number.</div>
${bars(d.by_ply, 0, 2, { tip: r => `moves ${str(r[0])}: ${f(r[2])} win% lost/move, ${f(r[3])}% blunders, ${r[1]} moves` })}</section>
</div>

<section><h2>Openings that cost me most</h2><div class="sub">Average win% lost per move in games by ECO code (min 3 games).</div>
${table(['ECO', 'Opening (example)', 'Games', 'Win% lost / move', 'Blunder %', 'Win rate %'], d.by_eco, { 3: '{:.2f}', 4: '{:.1f}', 5: '{:.0f}' })}</section>

<section><h2>Where in the game each opening bleeds</h2><div class="sub">Top 10 ECO codes by games played.</div>${heatmap(d.eco_ply)}</section>

<div class="grid2">
<section><h2>White vs Black</h2>
${table(['Colour', 'Games', 'Win rate %', 'Accuracy', 'Win% lost / move', 'Blunder %'], d.by_colour, { 2: '{:.1f}', 3: '{:.1f}', 4: '{:.2f}', 5: '{:.1f}' })}</section>
<section><h2>By time control</h2>
${table(['Class', 'Games', 'Accuracy', 'Win% lost / move', 'Blunder %'], d.by_time_class, { 2: '{:.1f}', 3: '{:.2f}', 4: '{:.1f}' })}</section>
</div>

<section><h2>Endgame conversion</h2><div class="sub">Material when the game became an endgame (my pieces vs theirs, queens off, ≤ 6 points each). Expected = engine win% at that moment; actual = points scored. Positive diff = I convert better than the engine expects.</div>
${table(['Material', 'Games', 'Expected %', 'Actual %', 'Diff'], d.endgames, { 2: '{:.0f}', 3: '{:.0f}', 4: '{:+.0f}' })}</section>
</main></body></html>`;
}

/** aggregates.build: the profile's site/insights.html from its database. db: store.profile(p); files: the
 * profiles-files adapter. Returns {games, out}. */
export async function build(db, files, profile) {
  const d = queryAll(db);
  const out = `${profile.siteDir}/insights.html`;
  await files.writeText(out, render(d, profile.username, profile.id));
  return { games: d.headline[0], out };
}
