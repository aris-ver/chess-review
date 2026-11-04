// The aggregates dumps (scripts/dump_aggregates_parity.py: tests/parity/aggregates.json, and with --local your own
// profiles in tests/parity/local/aggregates-*.json) replayed on SQLite: the same games, positions, moves and evals in,
// and Python's query_all, game_accuracies, insights.html and export CSVs out.
//
// Where DuckDB leaves the order open (rows tied on the ORDER BY key, any_value, a LIMIT cutting through a tie) any
// order and any choice is accepted; everything else matches exactly (floats at 1e-9 relative, as everywhere).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PARITY, load, same } from '../parity.js';
import { webSqlite } from '../web/db.js';
import { build, floatStr, gameAccuracies, queryAll, render, sqlRound } from './aggregates.js';
import { nodeSqlite } from './db-node.js';
import { EVALS_SCHEMA, MOVES_SCHEMA, Store, writeGames } from './db.js';
import { exportProfile } from './export.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';

const EVAL_COLS = EVALS_SCHEMA.map(([c]) => c);

/** dump_aggregates_parity.expand: a case's input as {games, positions, moves, evals}. */
export function expand(storage, inp) {
  if (inp.rows) return inp.rows;
  const base = storage[inp.base];
  const copy = inp.copy ?? {};
  const positions = [], moves = [];
  for (const g of inp.games) {
    const src = copy[g.game_id] ?? g.game_id;
    for (const r of base.positions) if (r.game_id === src) positions.push({ ...r, game_id: g.game_id });
    if (!inp.no_moves) for (const r of base.moves) if (r.game_id === src) moves.push({ ...r, game_id: g.game_id });
  }
  positions.push(...(inp.extra_positions ?? []));
  const evals = new Map(base.cache.evals.map(r => [r.fen_key, r]));
  for (const [k, m] of base.results) if (!evals.has(k)) evals.set(k, Object.fromEntries(EVAL_COLS.map(c => [c, c === 'fen_key' ? k : m[c]])));
  for (const r of inp.extra_evals ?? []) if (!evals.has(r.fen_key)) evals.set(r.fen_key, r);
  return { games: inp.games, positions, moves, evals: [...evals.values()] };
}

/** NaN as the dump writes it. */
const nan = v => (typeof v === 'number' && Number.isNaN(v) ? 'NaN' : Array.isArray(v) ? v.map(nan) : v);
const revive = v => (v === 'NaN' ? NaN : Array.isArray(v) ? v.map(revive) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)])) : v);
const byJson = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

/** js and py rows ordered by column key: equal, except that rows tied on the key may come in any order. With
 * `limited`, the last tie group may also have been cut by a LIMIT, so only its keys are compared. */
function sameOrdered(js, py, key, what, { limited = false } = {}) {
  same(js.length, py.length, `${what}.length`);
  for (let i = 0; i < py.length;) {
    let j = i;
    while (j < py.length && JSON.stringify(py[j][key]) === JSON.stringify(py[i][key])) j++;
    for (let k = i; k < j; k++) same(js[k][key], py[i][key], `${what}[${k}] key`);
    if (!(limited && j === py.length)) same(js.slice(i, j).sort(byJson), py.slice(i, j).sort(byJson), `${what}[${i}..${j}]`);
    i = j;
  }
}

function compare(db, d, py, games, what) {
  same(nan(d.headline), py.headline, `${what}.headline`);
  for (const k of ['by_ply', 'by_clock', 'by_colour', 'endgames']) same(d[k], py[k], `${what}.${k}`);
  sameOrdered(d.by_time_class, py.by_time_class, 1, `${what}.by_time_class`);
  sameOrdered(d.over_time, py.over_time, 1, `${what}.over_time`);

  // any_value(opening_name): one of the group's openings
  const openings = new Map();
  for (const g of games) {
    if (!g.eco) continue;
    const e = g.eco.slice(0, 3);
    if (!openings.has(e)) openings.set(e, new Set());
    openings.get(e).add(g.opening_name);
  }
  for (const r of d.by_eco) assert.ok(openings.get(r[0])?.has(r[1]), `${what}.by_eco ${r[0]}: ${r[1]}`);
  const noOpening = rows => rows.map(r => [r[0], null, ...r.slice(2)]);
  sameOrdered(noOpening(d.by_eco), noOpening(py.by_eco), 3, `${what}.by_eco`, { limited: py.by_eco.length === 15 });

  // the heatmap's top ten ECO codes by games: a tie at the cut may pick others
  const ecos = rows => [...new Set(rows.map(r => r[0]))].sort();
  const [je, pe] = [ecos(d.eco_ply), ecos(py.eco_ply)];
  let shared = je;
  if (JSON.stringify(je) !== JSON.stringify(pe)) {
    const count = Object.fromEntries(db.all(`SELECT substr(g.eco,1,3) eco, count(DISTINCT m.game_id) n FROM moves m JOIN games g USING (game_id)
      WHERE m.is_mine AND m.wp_loss IS NOT NULL AND NOT m.in_book AND NOT m.is_forced AND g.eco IS NOT NULL GROUP BY 1`).map(r => [r.eco, r.n]));
    const cut = Math.min(...pe.map(e => count[e]));
    for (const e of [...je, ...pe]) if (!(je.includes(e) && pe.includes(e))) same(count[e], cut, `${what}.eco_ply tie at the cut (${e})`);
    shared = je.filter(e => pe.includes(e));
  }
  const pick = rows => rows.filter(r => shared.includes(r[0])).sort(byJson);
  same(pick(d.eco_ply), pick(py.eco_ply), `${what}.eco_ply`);
}

/** games.csv's lines in any order among games played in the same second (or both without a date). */
function sameGamesCsv(js, py, what) {
  const lines = t => t.split('\n');
  const [jl, pl] = [lines(js), lines(py)];
  same(jl[0], pl[0], `${what} header`);
  same([...jl].sort(), [...pl].sort(), `${what} lines`);
  const at = l => l.split(',')[1];
  for (let i = 1; i < jl.length - 2; i++) {
    if (at(jl[i]) && at(jl[i + 1])) assert.ok(at(jl[i]) <= at(jl[i + 1]), `${what} order at line ${i}`);
    else assert.ok(!at(jl[i + 1]), `${what}: a game without a date before one with`);
  }
}

async function replay(c, storage, driver, { html = true } = {}) {
  const store = new Store(driver);
  const files = memoryFiles();
  const profiles = new Profiles(files, store);
  try {
    const rows = expand(storage, c.input);
    const p = await profiles.create(c.source, c.username);
    same(p.id, c.id, 'profile id');
    const db = await store.profile(p);
    writeGames(db, rows.games, rows.positions);
    db.insert('moves', MOVES_SCHEMA, rows.moves);
    db.insert('evals', EVALS_SCHEMA, rows.evals);

    same(Object.fromEntries(gameAccuracies(db)), c.accuracies, `${c.name}.accuracies`);
    const d = queryAll(db);
    compare(db, d, c.out, rows.games, c.name);
    same(render(revive(c.out), c.username, c.id), c.html, `${c.name}: render of Python's numbers`);
    const built = await build(db, files, p);
    same(built, { games: d.headline[0], out: `${p.siteDir}/insights.html` }, `${c.name}.build`);
    if (html) same(await files.readText(built.out), c.html, `${c.name}: insights.html`);
    assert.equal(db.value("SELECT count(*) FROM sqlite_temp_master WHERE name IN ('my', 'game_acc')"), 0, 'temp objects dropped');

    const counts = await exportProfile(db, files, p);
    same(await files.readText(`${p.exportDir}/positions_evals.csv`), c.export['positions_evals.csv'], `${c.name} positions_evals.csv`);
    sameGamesCsv(await files.readText(`${p.exportDir}/games.csv`), c.export['games.csv'], `${c.name} games.csv`);
    same(counts, { games: rows.games.length, positions: rows.positions.length, evaluated: counts.evaluated, out: p.exportDir }, `${c.name} export`);
  } finally {
    await store.close();
  }
}

// tied rows (by_time_class, over_time) put the page's rows in another order than DuckDB did
const TIES = new Set(['mixed']);

test('aggregates parity: node:sqlite answers as Python', async () => {
  const { cases } = load('aggregates.json');
  const storage = load('storage.json');
  const dir = mkdtempSync(join(tmpdir(), 'blundr-aggregates-'));
  try {
    for (const [i, c] of cases.entries()) await replay(c, storage, nodeSqlite(join(dir, String(i))), { html: !TIES.has(c.name) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregates parity: SQLite WASM answers as Python', async () => {
  const { cases } = load('aggregates.json');
  const storage = load('storage.json');
  const wasmBinary = readFileSync(new URL('../vendor/sqlite-wasm/sqlite3.wasm', import.meta.url));
  for (const [i, c] of cases.entries()) {
    await replay(c, storage, await webSqlite({ memory: true, root: `aggregates-${i}`, wasmBinary }), { html: !TIES.has(c.name) });
  }
});

const local = existsSync(PARITY + 'local/')
  ? readdirSync(PARITY + 'local/').filter(f => /^aggregates-.*\.json$/.test(f)).sort().map(f => PARITY + 'local/' + f) : [];

test('aggregates parity: your profiles, as in Python', { skip: !local.length && 'no tests/parity/local aggregates dump' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-aggregates-'));
  try {
    for (const [i, f] of local.entries()) {
      await replay(JSON.parse(readFileSync(f, 'utf8')), null, nodeSqlite(join(dir, String(i))), { html: false });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlRound is DuckDB's round", () => {
  same([2.5, 0.125, -2.5, 1.005, 2.675, 0.285, -0.04].map(x => [sqlRound(x, 0), sqlRound(x, 1), sqlRound(x, 2)]),
    [[3, 2.5, 2.5], [0, 0.1, 0.13], [-3, -2.5, -2.5], [1, 1, 1], [3, 2.7, 2.68], [0, 0.3, 0.28], [-0, -0, -0.04]]);
  assert.equal(sqlRound(null, 1), null);
});

test('floatStr is str() of a Python float', () => {
  same([1.5, 50, -0, 0.1, 1e-5, 0.0001, 1e16, 123456789012345.6, 1.5e300, NaN, -Infinity, null].map(floatStr),
    ['1.5', '50.0', '-0.0', '0.1', '1e-05', '0.0001', '1e+16', '123456789012345.6', '1.5e+300', 'nan', '-inf', 'None']);
});
