// The storage dumps (scripts/dump_storage_parity.py: tests/parity/storage.json, and with --local your own profiles
// in tests/parity/local/storage-*.json) replayed on SQLite: the same games, positions and cache rows in, and Python's
// answers out of pending_keys, load_multipv, classify.build and profiles.summary, row for row.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PARITY, load, same } from '../parity.js';
import { setBook } from '../core/book.js';
import { webSqlite } from '../web/db.js';
import { pendingKeys, writeResults } from './eval-cache.js';
import { build, loadMultipv } from './classify.js';
import { nodeSqlite } from './db-node.js';
import { EVALS_MULTIPV_SCHEMA, EVALS_SCHEMA, Store, writeGames } from './db.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';

const byDistribution = (a, b) => b[1] - a[1] || ((a[0] ?? '') < (b[0] ?? '') ? -1 : (a[0] ?? '') > (b[0] ?? '') ? 1 : 0);

function pending(db, gameId) {
  const [keys, stats] = pendingKeys(db, gameId);
  return { game_id: gameId, keys: [...keys].sort(), stats };
}

async function replay(c, driver) {
  const store = new Store(driver);
  const files = memoryFiles();
  const profiles = new Profiles(files, store);
  const now = Date.parse(c.now);
  try {
    setBook(c.book);
    const p = await profiles.create(c.source, c.username, now);
    same(p.id, c.name, 'profile id');
    const db = await store.profile(p);
    writeGames(db, c.games, c.positions);
    same(db.all('SELECT * FROM games ORDER BY game_id'), c.games, `${c.name}.games`);
    same(db.column('SELECT fen_key FROM positions ORDER BY game_id, ply'), c.fen_keys, `${c.name}.fen_keys`);
    db.insert('evals', EVALS_SCHEMA, c.cache.evals);
    db.insert('evals_multipv', EVALS_MULTIPV_SCHEMA, c.cache.multipv);

    const first = c.games[0].game_id;
    same([pending(db, null), pending(db, first)], c.pending_before, `${c.name}.pending_before`);
    writeResults(db, c.results);
    same([pending(db, null), pending(db, first)], c.pending_after, `${c.name}.pending_after`);
    same(loadMultipv(db, first), c.multipv_game, `${c.name}.multipv_game`);

    const stats = build(db);
    same(build(db).moves, stats.moves, `${c.name} second build`);
    same(db.all('SELECT * FROM moves ORDER BY game_id, ply'), c.moves, `${c.name}.moves`);
    same({ ...stats, distribution: [...stats.distribution].sort(byDistribution) }, c.build, `${c.name}.build`);

    await files.writeText(`${p.siteDir}/games.json`, c.games_json);
    await profiles.addUnseen(p.id, c.games.slice(0, 2).map(g => g.game_id));
    await profiles.setPinned(p.id, true, now);
    same(await files.readText(p.metaJson), c.meta_json, `${c.name}.meta_json`);
    same(await profiles.summary(p, now), c.summary, `${c.name}.summary`);
  } finally {
    await store.close();
  }
}

const local = existsSync(PARITY + 'local/')
  ? readdirSync(PARITY + 'local/').filter(f => /^storage-.*\.json$/.test(f)).sort().map(f => PARITY + 'local/' + f) : [];

test('storage parity: node:sqlite answers as Python', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-parity-'));
  try {
    for (const [i, c] of load('storage.json').entries()) await replay(c, nodeSqlite(join(dir, String(i))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storage parity: SQLite WASM answers as Python', async () => {
  const wasmBinary = readFileSync(new URL('../vendor/sqlite-wasm/sqlite3.wasm', import.meta.url));
  for (const [i, c] of load('storage.json').entries()) await replay(c, await webSqlite({ memory: true, root: `parity-${i}`, wasmBinary }));
});

test('storage parity: your profiles, as in Python', { skip: !local.length && 'no tests/parity/local storage dump' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-parity-'));
  try {
    for (const [i, f] of local.entries()) await replay(JSON.parse(readFileSync(f, 'utf8')), nodeSqlite(join(dir, String(i))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
