// app.js: the JS server over the browser's adapters (SQLite WASM, here on its memdb VFS), answered as the shim reads
// it; and sync's table-by-table database copy, which only the browser does, on SQLite WASM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EVALS, GAMES_SCHEMA, PROFILE_DDL, Store, profileDb } from '../server/db.js';
import { memoryFiles } from '../server/profiles-files.js';
import { Profiles } from '../server/profiles.js';
import { Sync } from '../server/sync.js';
import { answer, reclassifyAll, startApp } from './app.js';
import { webSqlite } from './db.js';
import { hasPyodideData, migrateOnce, DONE } from './legacy.js';

const wasmBinary = readFileSync(new URL('../vendor/sqlite-wasm/sqlite3.wasm', import.meta.url));
const PGN = readFileSync(new URL('../../tests/fixtures/clocks.pgn', import.meta.url), 'utf8').split('\n\n[Event')[0];
const dec = new TextDecoder();
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let roots = 0;

function fakePool(log) {
  return {
    size: 1, name: 'fake', async load() {},
    async search() { return ['info depth 1 seldepth 1 multipv 1 score cp 20 nodes 10 pv e2e4']; },
    async *stream() {
      try {
        for (let n = 1; ; n++) {
          yield `info depth ${n} seldepth 1 multipv 1 score cp 30 nodes ${n * 100} pv d2d4 d7d5`;
          await new Promise(r => setTimeout(r, 2));
        }
      } finally {
        log.push('stopped');
      }
    },
  };
}

async function app(extra = {}) {
  const driver = await webSqlite({ memory: true, root: `app-${roots++}`, wasmBinary });
  const files = memoryFiles(), log = [];
  const site = {
    book: async () => '',
    puzzles: async () => JSON.stringify([{ id: 'p1', fen: START, moves: 'e2e4 e7e5', rating: 1500, themes: 'opening' }]),
    packs: async () => JSON.stringify({ packs: [], daily: [] }),
  };
  const ready = startApp({ driver, files, pool: fakePool(log), site, scan: false, log: { info() {}, warn() {}, error() {}, debug() {} }, ...extra });
  const ask = async (method, path, body = null, signal = undefined) => {
    const msgs = [];
    await answer(ready, { method, path, body: body && new TextEncoder().encode(JSON.stringify(body)) }, m => msgs.push(m), signal);
    return msgs;
  };
  const json = async (method, path, body) => {
    const [m] = await ask(method, path, body);
    return { status: m.status, headers: m.headers, json: JSON.parse(dec.decode(m.body)) };
  };
  return { ready, ask, json, log, files, driver };
}

test('the server answers as messages: JSON with header pairs, a pasted game, the puzzle pack', async () => {
  const a = await app();
  const r = await a.json('GET', '/api/profiles');
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers, [['Content-Type', 'application/json']]);
  assert.deepEqual(r.json.profiles, []);
  const pgn = await a.json('POST', '/api/pgn', { pgn: PGN });
  assert.equal(pgn.status, 200, JSON.stringify(pgn.json));
  assert.equal(pgn.json.profile.id, 'pgn-pasted-games');
  const [file] = await a.ask('GET', `/p/pgn-pasted-games/games/${pgn.json.games[0]}.json`);
  assert.equal(file.status, 200);
  assert.ok(JSON.parse(dec.decode(file.body)).moves.length > 10);
  const themes = await a.json('GET', '/api/puzzles/themes');
  assert.equal(themes.status, 200);
  assert.deepEqual(themes.json.themes.map(t => t.id), ['opening']);
});

test('eval_stream: a response, chunks of NDJSON, and the engine stopped once the page lets go', async () => {
  const a = await app();
  const ac = new AbortController(), msgs = [];
  const done = answer(a.ready, { method: 'GET', path: `/api/eval_stream?fen=${encodeURIComponent(START)}` }, m => {
    msgs.push(m);
    if (msgs.filter(x => x.type === 'chunk').length === 3) ac.abort();
  }, ac.signal);
  await done;
  assert.equal(msgs[0].type, 'response');
  assert.equal(msgs[0].stream, true);
  assert.deepEqual(msgs[0].headers.find(h => h[0] === 'Content-Type'), ['Content-Type', 'application/x-ndjson']);
  const chunks = msgs.filter(m => m.type === 'chunk');
  assert.ok(chunks.length >= 3);
  assert.equal(JSON.parse(dec.decode(chunks[0].body)).lines[0].san, 'd4');
  assert.equal(msgs.at(-1).type, 'end');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(a.log, ['stopped']);
});

test('a router that fails to start answers 500, not silence', async () => {
  const msgs = [];
  await answer(Promise.reject(new Error('no OPFS')), { method: 'GET', path: '/api/profiles' }, x => msgs.push(x));
  assert.equal(msgs[0].status, 500);
  assert.match(dec.decode(msgs[0].body), /no OPFS/);
});

test('reclassifyAll rebuilds every profile from what is stored', async () => {
  const a = await app();
  await a.json('POST', '/api/pgn', { pgn: PGN });
  const { env } = await a.ready;
  const db = await env.store.profile('pgn-pasted-games');
  db.run('DELETE FROM moves');
  assert.equal(db.value('SELECT count(*) FROM moves'), 0);
  assert.deepEqual(await reclassifyAll(env), ['pgn-pasted-games']);
  assert.ok(db.value('SELECT count(*) FROM moves') > 10);
});

test('the migration is skipped without Pyodide data and runs once with it', async () => {
  const files = memoryFiles();
  const none = { databases: async () => [{ name: 'other' }] };
  assert.equal(await hasPyodideData(none), false);
  assert.equal(await migrateOnce({ driver: null, files, legacy: {}, idb: none, load: () => assert.fail('loaded') }), null);
  const some = { databases: async () => [{ name: '/data' }] };
  // Pyodide's data with nothing the export reads: only the files are copied
  const FS = fakeFS({ '/data/settings.json': '{"a": 1}', '/data/serve.log': 'x' });
  let loads = 0;
  const out = await migrateOnce({ driver: null, files, legacy: {}, idb: some, load: async () => { loads++; return { FS }; }, log: { error() {}, info() {} } });
  assert.equal(out.status, 'empty');
  assert.equal(await files.readText('settings.json'), '{"a": 1}');
  assert.equal(await files.exists('serve.log'), false);
  assert.equal(JSON.parse(await files.readText(DONE)).status, 'empty');
  assert.equal(await migrateOnce({ driver: null, files, legacy: {}, idb: some, load: async () => { loads++; return { FS }; } }), null);
  assert.equal(loads, 1);
});

test('a migration that fails is tried again, three times at most', async () => {
  const files = memoryFiles(), some = { databases: async () => [{ name: '/data' }] };
  const quiet = { error() {}, info() {} };
  const fail = async () => { throw new Error('no network'); };
  for (const want of ['retry', 'retry', 'failed']) {
    const out = await migrateOnce({ driver: null, files, legacy: {}, idb: some, load: fail, log: quiet });
    assert.equal(out.status, want);
  }
  assert.equal(await migrateOnce({ driver: null, files, legacy: {}, idb: some, load: fail, log: quiet }), null);
});

/** Pyodide's FS calls migrate.js makes (readdir, stat, isDir, analyzePath, readFile) over {path: text}. */
function fakeFS(tree) {
  const enc = new TextEncoder();
  const isFile = p => p in tree;
  const isDirPath = p => Object.keys(tree).some(k => k.startsWith(p + '/'));
  return {
    analyzePath: p => ({ exists: isFile(p) || isDirPath(p) }),
    stat: p => ({ mode: isFile(p) ? 0 : 1 }),
    isDir: mode => mode === 1,
    readdir: p => ['.', '..', ...new Set(Object.keys(tree).filter(k => k.startsWith(p + '/')).map(k => k.slice(p.length + 1).split('/')[0]))],
    readFile: p => enc.encode(tree[p]),
  };
}

const game = { game_id: 'g1', played_at: '2026-01-01T00:00:00', time_control: '600', time_class: 'rapid', my_colour: 'white',
               my_rating: 1500, opponent_rating: 1500, result: 'win', termination: 'mate', eco: 'C50', opening_name: 'Italian',
               opponent: 'x', my_name: 'alice' };

test("sync on SQLite WASM: a profile's database is copied table by table into the workspace and back", async () => {
  const driver = await webSqlite({ memory: true, root: `sync-${roots++}`, wasmBinary });
  const files = memoryFiles(), store = new Store(driver), profiles = new Profiles(files, store);
  const sync = new Sync({ files, store, onSwitch: () => {} });
  const p = await profiles.create('chesscom', 'alice');
  (await store.profile(p)).insert('games', GAMES_SCHEMA, [game]);
  await sync.saveBase('u1', {});
  assert.deepEqual(await sync.switch(null), { switched: true });
  assert.equal(await store.driver.exists(profileDb('chesscom-alice')), false);
  const aside = await store.connect(`.accounts/u1/${profileDb('chesscom-alice')}`, PROFILE_DDL, [[EVALS, 'ev']]);
  assert.deepEqual(aside.all('SELECT game_id, my_rating FROM games'), [{ game_id: 'g1', my_rating: 1500 }]);
  await store.close(`.accounts/u1/${profileDb('chesscom-alice')}`);
  assert.deepEqual(await sync.switch('u1'), { switched: true });
  assert.deepEqual((await store.profile('chesscom-alice')).column('SELECT game_id FROM games'), ['g1']);
  assert.equal(await store.driver.exists(`.accounts/u1/${profileDb('chesscom-alice')}`), false);
  await store.close();
});
