// handover.checkData: when the desktop app opens the data folder, and that a refusal leaves it as it was. The
// export itself is chess_review/migrate_sqlite.py's (js/server/migrate.test.js runs it); here the SQLite files are
// written by a Store, as the export's would read.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { nodeSqlite } from '../server/db-node.js';
import { EVALS, EVALS_DDL, PROGRESS, PROGRESS_DDL, SOLVED_ROW, Store } from '../server/db.js';
import { nodeFiles } from '../server/profiles-files-node.js';
import { bookKeys } from './book.js';
import { EnginePool } from './engines.js';
import { ACCEPTED, CLEAN_RESTORED, checkData, restoreClean } from './handover.js';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'blundr-handover-'));
  dirs.push(d);
  return d;
};
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

const check = dir => checkData(nodeFiles(dir), dir, d => nodeSqlite(d));

/** A data folder as the bridge leaves it: Python's files, the SQLite ones (n evals) and the marker (claiming m). */
async function exported(dir, { n = 2, m = n } = {}) {
  writeFileSync(join(dir, 'evals.duckdb'), 'duckdb');
  writeFileSync(join(dir, 'puzzle_attempts.jsonl'), '{}\n');
  const store = new Store(nodeSqlite(dir));
  const ev = await store.connect(EVALS, EVALS_DDL);
  for (let i = 0; i < n; i++) ev.run('INSERT INTO evals (fen_key, nodes) VALUES (?, 1)', [`k${i}`]);
  await store.connect(PROGRESS, PROGRESS_DDL);
  await store.close();
  // the export writes with journal_mode DELETE: no -wal left over
  for (const f of readdirSync(dir)) if (/-(wal|shm)$/.test(f)) rmSync(join(dir, f));
  writeFileSync(join(dir, 'sqlite-export.json'), JSON.stringify({
    format: 1, schema_version: 1, at: '2026-10-23T10:00:00+00:00',
    files: { [EVALS]: { evals: m, evals_multipv: 0 }, [PROGRESS]: { puzzle_attempts: 0, puzzle_solved: 0, puzzle_daily: 0 } },
  }));
}

const snapshot = dir => readdirSync(dir).sort().map(f => [f, statSync(join(dir, f)).size, statSync(join(dir, f)).mtimeMs]);

test('handover: an empty folder, or one the app has used, opens', async () => {
  const d = tmp();
  assert.deepEqual(await check(d), { ok: true, how: 'fresh' });
  writeFileSync(join(d, 'evals.sqlite'), '');
  writeFileSync(join(d, 'evals.duckdb'), '');
  assert.deepEqual(await check(d), { ok: true, how: 'own' });
});

test('handover: Python data without an export stops, nothing written', async () => {
  for (const f of ['evals.duckdb', 'puzzle_solved.jsonl', 'profiles/me/games.parquet']) {
    const d = tmp();
    mkdirSync(join(d, 'profiles', 'me'), { recursive: true });
    writeFileSync(join(d, f), 'x');
    const before = snapshot(d);
    const r = await check(d);
    assert.equal(r.ok, false);
    assert.match(r.title, /not been converted/);
    assert.deepEqual(snapshot(d), before);
  }
});

test('handover: a complete export is verified once, then trusted', async () => {
  const d = tmp();
  await exported(d);
  const files = readdirSync(d).filter(f => f.endsWith('.sqlite')).map(f => [f, statSync(join(d, f)).mtimeMs]);
  assert.deepEqual(await check(d), { ok: true, how: 'verified' });
  // verify counted a copy: the files the bridge wrote are as it left them (migrate_sqlite would see a change)
  assert.deepEqual(files.map(([f]) => [f, statSync(join(d, f)).mtimeMs]), files);
  assert.ok(!readdirSync(d).some(f => /-(wal|shm)$/.test(f)));
  assert.ok(existsSync(join(d, ACCEPTED)));
  assert.deepEqual(await check(d), { ok: true, how: 'accepted' });
});

test('handover: an incomplete export stops and says what is missing, nothing written', async () => {
  const d = tmp();
  await exported(d, { n: 2, m: 3 });
  rmSync(join(d, PROGRESS));
  const before = snapshot(d);
  const r = await check(d);
  assert.equal(r.ok, false);
  assert.match(r.title, /incomplete/);
  assert.deepEqual(r.problems.map(p => [p.name, p.table, p.expected, p.found]), [
    [EVALS, 'evals', 3, 2],
    [PROGRESS, 'puzzle_attempts', 0, null], [PROGRESS, 'puzzle_solved', 0, null], [PROGRESS, 'puzzle_daily', 0, null],
  ]);
  assert.deepEqual(snapshot(d), before);
});

test('handover: an export for a newer schema stops', async () => {
  const d = tmp();
  writeFileSync(join(d, 'sqlite-export.json'), JSON.stringify({ schema_version: 99, files: {} }));
  assert.equal((await check(d)).ok, false);
});

test('handover: the clean solves the bridge left out come back once, from puzzle_solved.jsonl', async () => {
  const d = tmp();
  writeFileSync(join(d, 'puzzle_solved.jsonl'), [
    '{"id": "a", "ts": 10}', '{"id": "b", "ts": 11, "clean": true}', '{"id": "c", "ts": 12, "clean": true}',
    '{"id": "d", "ts": 13, "clean": true}', '{"id": "torn', ''].join('\n'));
  const store = new Store(nodeSqlite(d));
  const db = await store.progress();
  // as the bridge exported it: every row without clean, d not there at all; c made clean here since
  db.insert('puzzle_solved', SOLVED_ROW, [{ id: 'a', ts: 10, clean: null }, { id: 'b', ts: 11, clean: null }, { id: 'c', ts: 12, clean: true }]);
  const files = nodeFiles(d);
  assert.equal(await restoreClean(files, db), 2);
  assert.deepEqual(db.all('SELECT id, ts, clean FROM puzzle_solved ORDER BY id').map(r => [r.id, r.ts, !!r.clean]),
    [['a', 10, false], ['b', 11, true], ['c', 12, true], ['d', 13, true]]);
  assert.ok(existsSync(join(d, CLEAN_RESTORED)));
  db.run('UPDATE puzzle_solved SET clean = NULL');
  assert.equal(await restoreClean(files, db), null);     // once only
  assert.equal(db.value('SELECT count(*) FROM puzzle_solved WHERE clean'), 0);
  await store.close();
});

test('handover: no puzzle_solved.jsonl, nothing to restore', async () => {
  const d = tmp();
  const store = new Store(nodeSqlite(d));
  assert.equal(await restoreClean(nodeFiles(d), await store.progress()), 0);
  await store.close();
});

test('book: the keys of a line are the positions after each of its moves', () => {
  const tsv = 'eco\tname\tpgn\nA00\tX\t1. e4 e5\nA00\tY\t1. e4 c5 2. Nf3\nA00\tbad\t1. e5\n';
  assert.deepEqual(bookKeys([tsv]), [
    'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -',
    'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
  ]);
});

test('engines: reapIdle closes a loaded pool only when idle long enough and nothing is in use', async () => {
  const pool = new EnginePool({ size: 1, path: 'none' });
  assert.equal(await pool.reapIdle(0), false);          // never started
  let closed = 0;
  pool.loaded = Promise.resolve();
  pool.close = async () => { closed++; pool.loaded = null; };
  pool.lastUsed = 1000;
  assert.equal(await pool.reapIdle(600_000, 2000), false);
  pool.inUse = 1;
  assert.equal(await pool.reapIdle(600_000, 1_000_000), false);
  pool.inUse = 0;
  assert.equal(await pool.reapIdle(600_000, 1_000_000), true);
  assert.equal(closed, 1);
});
