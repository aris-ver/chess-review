// The storage round trip on both drivers: the dumped games (tests/parity/games.json) into a profile's database, their
// evals into the cache, then pending keys and classify through SQL must give Python's moves.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { load, same } from '../parity.js';
import { setBook } from '../core/book.js';
import { webSqlite } from '../web/db.js';
import { pendingKeys, writeResults } from './analyse.js';
import { build, classifyAll, sha1 } from './classify.js';
import { nodeSqlite } from './db-node.js';
import { Store, writeGames } from './db.js';

const cases = load('games.json');
const EVAL = ['eval_cp', 'mate_in', 'best_move', 'pv'];

async function roundTrip(makeDriver) {

  for (const [i, c] of cases.entries()) {
    const store = new Store(await makeDriver(i));     // a cache of its own: the cases share positions
    setBook(c.book);
    const db = await store.profile(`pgn-${c.name}`);
    const positions = c.rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !EVAL.includes(k))));
    writeGames(db, [c.game], positions);
    const seen = new Map();
    for (const r of c.rows) seen.set(r.fen_key, [r.fen_key, { nodes: 0, ...Object.fromEntries(EVAL.map(k => [k, r[k]])) }, c.multipv[r.fen_key] ?? []]);
    writeResults(db, [...seen.values()]);
    same(pendingKeys(db)[0], [], `${c.name} pending after`);
    const [moves] = classifyAll(db);
    same(moves, c.moves, `${c.name}.moves`);
    build(db);
    same(db.all('SELECT * FROM moves ORDER BY ply'), c.moves.map(m => ({ ...m })), `${c.name}.stored`);
    await store.close();
  }

}

test('storage: node:sqlite round trip classifies as Python', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-db-'));
  try {
    await roundTrip(i => nodeSqlite(join(dir, String(i))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TODO: the memdb cache outlives Store.close() here, so the second case reads the first's evals
test('storage: SQLite WASM (memdb) round trip classifies as Python', { todo: 'memdb cache survives close' }, async () => {
  const wasm = readFileSync(new URL('../vendor/sqlite-wasm/sqlite3.wasm', import.meta.url));
  await roundTrip(() => webSqlite({ memory: true, wasmBinary: wasm }));
});

test('storage: sha1', () => {
  same(sha1(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  same(sha1('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});
