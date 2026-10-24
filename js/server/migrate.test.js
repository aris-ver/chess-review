// The Python app's export (legacy/chess_review/migrate_sqlite.py, frozen) opened with the JS Store: the export of
// legacy/make_fixture.py's data (and of MIGRATE_DATA, a data directory of your own, copied first) has db.js's schema, and every table's row count
// and sampled rows are what Python reads from DuckDB, parquet and jsonl (the export's --dump). Then the browser's half:
// js/web/migrate.js's import from a Pyodide-like file system into a pool. Needs the Python venv (.venv, or PYTHON);
// skipped without it.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { same } from '../parity.js';
import { copyFiles, importExport, migratePyodide, walk } from '../web/migrate.js';
import { nodeSqlite } from './db-node.js';
import { ATTEMPTS_SCHEMA, DAILY_SCHEMA, EVALS, EVALS_MULTIPV_SCHEMA, EVALS_SCHEMA, GAMES_SCHEMA, MOVES_SCHEMA, POSITIONS_SCHEMA,
  PROGRESS, SCHEMA_VERSION, SOLVED_SCHEMA, Store } from './db.js';
import { MARKER, markerState, readMarker, verify } from './migrate.js';
import { memoryFiles } from './profiles-files.js';
import { nodeFiles } from './profiles-files-node.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function python() {
  if (process.env.PYTHON) return process.env.PYTHON;
  for (let d = ROOT; ; d = dirname(d)) {      // a worktree has the venv in the main checkout, up the tree
    const p = join(d, '.venv', 'bin', 'python');
    if (existsSync(p)) return p;
    if (dirname(d) === d) return null;
  }
}
const PY = python();
const SKIP = !PY && 'no Python venv (.venv or PYTHON)';

function run(args, data) {
  const r = spawnSync(PY, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: join(ROOT, 'legacy'), CHESS_REVIEW_DATA: data } });
  if (r.status !== 0) throw new Error(`${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** what the dump samples: sample rows evenly spread, int(i * step) as in Python */
function pick(rows, n = 25) {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  return Array.from({ length: n }, (_, i) => rows[Math.floor(i * step)]);
}

const TABLES = {
  evals: [EVALS_SCHEMA, 'fen_key'], evals_multipv: [EVALS_MULTIPV_SCHEMA, 'fen_key, rank'],
  games: [GAMES_SCHEMA, 'game_id'], positions: [POSITIONS_SCHEMA, 'game_id, ply'], moves: [MOVES_SCHEMA, 'game_id, ply'],
  puzzle_attempts: [ATTEMPTS_SCHEMA, 'seq'], puzzle_solved: [SOLVED_SCHEMA, 'seq'], puzzle_daily: [DAILY_SCHEMA, 'seq'],
};

const master = db => db.all("SELECT type, name, tbl_name, sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");

/** The Store over data opens every exported file as its own and reads back what Python read. */
async function check(data, dump) {
  const fresh = mkdtempSync(join(tmpdir(), 'migrate-fresh-'));
  const store = new Store(nodeSqlite(data));
  const blank = new Store(nodeSqlite(fresh));
  try {
    for (const [name, tables] of Object.entries(dump)) {
      // the names the app opens go through its own methods (a profile with evals.sqlite attached); an account set
      // aside is opened as a profile or progress database of its own
      const id = /^profiles\/([^/]+)\/games\.sqlite$/.exec(name)?.[1];
      const kind = name === EVALS ? 'evals' : name.endsWith(PROGRESS) ? 'progress' : 'profile';
      const db = name === EVALS ? await store.evals() : name === PROGRESS ? await store.progress() : id ? await store.profile(id)
        : await store.connect(name, '');      // no DDL of its own: user_version is set, so none would run
      same(db.value('PRAGMA user_version'), SCHEMA_VERSION, `${name} user_version`);
      const ref = kind === 'evals' ? await blank.evals() : kind === 'progress' ? await blank.progress() : await blank.profile('x');
      same(master(db), master(ref), `${name} schema`);
      for (const [table, { count, sample }] of Object.entries(tables)) {
        const [schema, order] = TABLES[table];
        const cols = schema.map(c => c[0]).filter(c => c !== 'seq');
        same(db.value(`SELECT count(*) FROM main.${table}`), count, `${name} ${table} count`);
        const rows = db.all(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM main.${table} ORDER BY ${order}`);
        same(pick(rows), sample, `${name} ${table} rows`);
      }
      if (id) {     // the cache answers unqualified on a profile's connection, as Python's views did
        same(db.value('SELECT count(*) FROM positions p JOIN evals e ON e.fen_key = p.fen_key'),
          db.value('SELECT count(*) FROM main.positions p JOIN ev.evals e ON e.fen_key = p.fen_key'), `${name} join`);
      }
    }
  } finally {
    await store.close();
    await blank.close();
    rmSync(fresh, { recursive: true, force: true });
  }
}

async function exportAndCheck(data) {
  const dumpPath = join(data, '..', 'dump.json');
  run(['-m', 'chess_review.migrate_sqlite', '--data', data, '--dump', dumpPath], data);
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  await check(data, dump);
  const marker = await readMarker(nodeFiles(data));
  same(markerState(marker), 'done', 'marker');
  same(Object.fromEntries(Object.entries(dump).map(([n, t]) => [n, Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.count]))])),
    marker.files, 'marker counts');
  same(await verify(nodeSqlite(data), marker), [], 'verify');
  return marker;
}

/** Pyodide's FS API (readdir, stat, isDir, analyzePath, readFile) over a real directory */
function pyFS(root) {
  const real = p => join(root, p);
  return {
    readdir: p => ['.', '..', ...readdirSync(real(p))],
    stat: p => ({ mode: statSync(real(p)).isDirectory() ? 1 : 0 }),
    isDir: mode => mode === 1,
    analyzePath: p => ({ exists: existsSync(real(p)) }),
    readFile: (p, opts) => (opts?.encoding ? readFileSync(real(p), 'utf8') : new Uint8Array(readFileSync(real(p)))),
  };
}

test('migrate: the Python export opens in the JS Store as Python read it', { skip: SKIP }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'migrate-'));
  try {
    const data = join(tmp, 'data');
    mkdirSync(data);
    run(['legacy/make_fixture.py', data], data);
    const marker = await exportAndCheck(data);
    same(Object.keys(marker.files).sort(), ['.accounts/guest/profiles/pgn-fuzz/games.sqlite', '.accounts/guest/progress.sqlite',
      'evals.sqlite', 'profiles/pgn-fuzz/games.sqlite', 'profiles/pgn-testuser/games.sqlite', 'progress.sqlite'], 'files');

    // a file gone missing or short of rows is caught before the switch trusts the export
    const short = { ...marker, files: { ...marker.files, 'progress.sqlite': { ...marker.files['progress.sqlite'], puzzle_daily: 2 },
      'profiles/gone/games.sqlite': { games: 1 } } };
    same(await verify(nodeSqlite(data), short), [
      { name: 'progress.sqlite', table: 'puzzle_daily', expected: 2, found: 1 },
      { name: 'profiles/gone/games.sqlite', table: 'games', expected: 1, found: null }], 'verify differences');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrate: the browser half puts the export into a pool and the rest into files', { skip: SKIP }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'migrate-web-'));
  try {
    const data = join(tmp, 'data'), out = join(tmp, 'out'), pool = join(tmp, 'pool');
    mkdirSync(data);
    run(['legacy/make_fixture.py', data], data);
    mkdirSync(join(data, 'profiles', 'pgn-fuzz', 'site'), { recursive: true });
    writeFileSync(join(data, 'profiles', 'pgn-fuzz', 'site', 'games.json'), '{"games": []}');
    writeFileSync(join(data, 'settings.json'), '{"theme": "dark"}');
    run(['-m', 'chess_review.migrate_sqlite', '--data', data, '--out', out], data);
    same(walk(pyFS(data), '').filter(p => p.endsWith('.sqlite')), [], 'nothing written beside the old files');

    const driver = { ...nodeSqlite(pool), importFile: (name, bytes) => {
      mkdirSync(dirname(join(pool, name)), { recursive: true });
      writeFileSync(join(pool, name), bytes);
    } };
    const files = memoryFiles();
    const res = await importExport(pyFS(out), driver, files, '');
    same(res.problems, [], 'problems');
    same(res.imported.length, 6, 'imported');
    same(JSON.parse(await files.readText(MARKER)).files, res.marker.files, 'marker written');
    const store = new Store(driver);
    try {
      same((await store.profile('pgn-fuzz')).value('SELECT count(*) FROM moves'), res.marker.files['profiles/pgn-fuzz/games.sqlite'].moves, 'moves');
    } finally {
      await store.close();
    }

    const copied = await copyFiles(pyFS(data), files, { data: '', skip: p => p.startsWith('.accounts/') });
    same(copied, ['profiles/pgn-fuzz/meta.json', 'profiles/pgn-fuzz/site/games.json', 'profiles/pgn-testuser/meta.json', 'settings.json'], 'copied');
    same(await files.readText('settings.json'), '{"theme": "dark"}', 'settings');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrate: migratePyodide end to end, with Python standing in for Pyodide', { skip: SKIP }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'migrate-py-'));
  try {
    const data = join(tmp, 'data'), out = join(tmp, 'out'), pool = join(tmp, 'pool');
    mkdirSync(data);
    run(['legacy/make_fixture.py', data], data);
    const FS = { ...pyFS(''), rmdir: p => rmSync(p, { recursive: true }), unlink: p => rmSync(p) };
    const loaded = [];
    const py = {
      FS,
      loadPackage: async names => void loaded.push(...names),
      runPython(code) {      // the last line is the value, as in Pyodide
        const lines = code.trim().split('\n');
        const last = lines.pop();
        return run(['-c', [...lines, `print(${last})`].join('\n')], data);
      },
    };
    const driver = { ...nodeSqlite(pool), importFile: (name, bytes) => {
      mkdirSync(dirname(join(pool, name)), { recursive: true });
      writeFileSync(join(pool, name), bytes);
    } };
    const files = memoryFiles();
    const res = await migratePyodide(py, driver, files, { data, out, skip: p => p.startsWith('.accounts/') });
    same(loaded, ['duckdb', 'sqlite3'], 'packages');
    same(res.report.status, 'done', 'report');
    same(res.problems, [], 'problems');
    same(res.copied, ['profiles/pgn-fuzz/meta.json', 'profiles/pgn-testuser/meta.json'], 'copied');
    same(JSON.parse(await files.readText(MARKER)).files, res.report.files, 'marker');
    same(existsSync(out), false, 'memory copy removed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const LOCAL = process.env.MIGRATE_DATA;
test('migrate: your own data (MIGRATE_DATA, copied first)', { skip: (SKIP || (!LOCAL && 'no MIGRATE_DATA')) }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'migrate-local-'));
  try {
    const data = join(tmp, 'data');
    mkdirSync(data);
    for (const f of readdirSync(LOCAL)) {
      if (/^(evals\.duckdb|puzzle_.*\.jsonl|profiles|\.accounts)$/.test(f)) cpSync(join(LOCAL, f), join(data, f), { recursive: true });
    }
    const marker = await exportAndCheck(data);
    console.log(JSON.stringify(marker.files));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


