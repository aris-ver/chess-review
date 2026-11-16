// The drill routes through the router (as routes-puzzles.test.js builds it), over the 3-piece tables made here and
// fakes for the rest: the deal, recording an attempt, the standing, and every refusal.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { setBook } from '../core/book.js';
import { generate, tableSize } from '../core/endgame-table.js';
import { nodeSqlite } from './db-node.js';
import { Store } from './db.js';
import { DrillTables } from './drills.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';
import { serve } from './router.js';

const tables = {};
for (const name of ['KQK', 'KRK', 'KPK']) tables[name] = generate(name, tables);

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pool = { size: 1, name: 'none', async load() {}, async search() { throw new Error('no engine here'); } };

/** A router over a data folder of its own; `load` is what the DrillTables reads (undefined: none given at all). */
async function withRouter(load, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-routes-drills-'));
  setBook([]);
  const store = new Store(nodeSqlite(dir)), files = memoryFiles();
  const env = { store, files, profiles: new Profiles(files, store), rng: rng(3) };
  if (load) env.drillTables = new DrillTables(load);
  try {
    const router = await serve({ env, pool, nodes: 1, scan: false });
    router.runner.now = () => 5000.5;
    const ask = async (method, path, body) => {
      const out = await router.handle(method, path, body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
        body === undefined ? null : 'application/json');
      assert.equal(out.headers['Content-Type'], 'application/json', `${method} ${path} type`);
      return { status: out.status, body: JSON.parse(out.body) };
    };
    await fn(ask, router);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const real = async name => tables[name];
const attemptOf = (drill, result, extra = {}) => ({ ...drill, moves_used: 6, result, ms: 30000, worst_loss: 0, ...extra });

test('next: a drill at the level the record gives, status beside it', async () => {
  await withRouter(real, async ask => {
    const r = await ask('GET', '/api/drills/next?ending=KQK');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ['drill', 'status']);
    const { drill, status } = r.body;
    assert.deepEqual([drill.ending, drill.level, drill.mode, drill.counter], ['KQK', 1, 'mate', true]);
    assert.ok(drill.dtm >= 3 && drill.dtm <= 5);
    assert.equal(drill.budget, drill.dtm + 10);
    assert.match(drill.fen, / w - - 0 1$/);
    assert.deepEqual([status.ending, status.level, status.top, status.star, status.played], ['KQK', 1, 5, false, 0]);
    for (const [ending, mode] of [['KRK', 'mate'], ['KPK', 'attack'], ['KPK-hold', 'hold']]) {
      const k = (await ask('GET', `/api/drills/next?ending=${ending}`)).body.drill;
      assert.equal(k.mode, mode);
      assert.equal(k.dtm === null, ending.startsWith('KPK'));
    }
    const l = await ask('GET', '/api/drills/next?ending=KQK&level=3');
    assert.equal(l.body.drill.level, 3);
  });
});

test('attempt, status and the level that follows', async () => {
  await withRouter(real, async ask => {
    const solved = [];
    for (let i = 0; i < 3; i++) {
      const { drill } = (await ask('GET', '/api/drills/next?ending=KRK')).body;
      const r = await ask('POST', '/api/drills/attempt', attemptOf(drill, 'solved'));
      assert.equal(r.status, 200);
      assert.equal(r.body.counted, true);
      assert.equal(r.body.before, 1);
      assert.equal(r.body.status.level, i === 2 ? 2 : 1);
      solved.push(r.body.id);
    }
    assert.equal(new Set(solved).size, 3);
    const s = await ask('GET', '/api/drills/status?ending=KRK');
    assert.equal(s.status, 200);
    assert.deepEqual([s.body.ending, s.body.level, s.body.played, s.body.solved, s.body.star], ['KRK', 2, 3, 3, false]);
    assert.equal(s.body.recent.length, 3);
    assert.deepEqual(Object.keys(s.body.recent[0]), ['id', 'ts', 'level', 'result', 'solved', 'moves_used', 'ms', 'worst_loss']);
    assert.equal(s.body.recent[0].ts, 5000);
    assert.equal(s.body.recent[0].solved, true);
    // the next drill is level 2 now
    assert.equal((await ask('GET', '/api/drills/next?ending=KRK')).body.drill.level, 2);
    // all endings
    const all = await ask('GET', '/api/drills/status');
    assert.deepEqual(all.body.endings.map(e => [e.ending, e.level]),
      [['KQRK', 1], ['KRRK', 1], ['KQK', 1], ['KRK', 2], ['KPK', 1], ['KPK-hold', 1]]);
    // a client id makes a retry harmless
    const { drill } = (await ask('GET', '/api/drills/next?ending=KPK')).body;
    const body = attemptOf(drill, 'threw', { id: 'try-1', worst_loss: null });
    const one = await ask('POST', '/api/drills/attempt', body);
    const two = await ask('POST', '/api/drills/attempt', body);
    assert.deepEqual([one.body.counted, two.body.counted, two.body.id, two.body.status.played], [true, false, 'try-1', 1]);
  });
});

test('refusals: a bad ending, level or body is a 400 with a reason; no start position is a 404', async () => {
  await withRouter(real, async ask => {
    const err = async (method, path, body, status, re) => {
      const r = await ask(method, path, body);
      assert.equal(r.status, status, `${method} ${path} ${JSON.stringify(body)}`);
      assert.match(r.body.error, re);
    };
    await err('GET', '/api/drills/next', undefined, 400, /ending/);
    await err('GET', '/api/drills/next?ending=KBNK', undefined, 400, /ending/);
    await err('GET', '/api/drills/next?ending=toString', undefined, 400, /ending/);
    await err('GET', '/api/drills/next?ending=KQK&level=0', undefined, 400, /levels 1 to 5/);
    await err('GET', '/api/drills/next?ending=KQK&level=6', undefined, 400, /levels 1 to 5/);
    await err('GET', '/api/drills/next?ending=KQK&level=x', undefined, 400, /levels 1 to 5/);
    await err('GET', '/api/drills/next?ending=KQK&level=', undefined, 400, /levels 1 to 5/);
    await err('GET', '/api/drills/next?ending=KQK&level=1.5', undefined, 400, /levels 1 to 5/);
    await err('GET', '/api/drills/status?ending=nope', undefined, 400, /ending/);
    await err('POST', '/api/drills/attempt', '{not json', 400, /JSON/);
    await err('POST', '/api/drills/attempt', '[]', 400, /object/);
    await err('POST', '/api/drills/attempt', undefined, 400, /ending/);
    await err('POST', '/api/drills/attempt', { ending: 'KQK', level: 9 }, 400, /level/);
    await err('POST', '/api/drills/attempt', { ending: 'KQK', level: 1, fen: 'x', result: 'solved' }, 400, /fen/);
    await err('GET', '/api/drills/other', undefined, 404, /not found/);
    await err('POST', '/api/drills/next', {}, 404, /not found/);
    // nothing was recorded
    assert.equal((await ask('GET', '/api/drills/status?ending=KQK')).body.played, 0);
  });
});

test('tables that are missing or empty are an answer, not a crash', async () => {
  // no tables given: 503, and the page can say so
  await withRouter(undefined, async ask => {
    const r = await ask('GET', '/api/drills/next?ending=KQK');
    assert.equal(r.status, 503);
    assert.match(r.body.error, /not installed/);
    assert.equal((await ask('GET', '/api/drills/status?ending=KQK')).status, 200);
  });
  // a loader that fails once, then works: the next ask gets a drill
  let calls = 0;
  await withRouter(async name => {
    if (++calls === 1) throw new Error('offline');
    return tables[name];
  }, async ask => {
    assert.equal((await ask('GET', '/api/drills/next?ending=KQK')).status, 503);
    assert.equal((await ask('GET', '/api/drills/next?ending=KQK')).status, 200);
  });
  // pickStart finds nothing (an all-draw table): 404, with the status
  await withRouter(async name => (name === 'KQRK' ? { name, data: new Uint8Array(tableSize('KQRK')) } : tables[name]), async ask => {
    const r = await ask('GET', '/api/drills/next?ending=KQRK');
    assert.equal(r.status, 404);
    assert.match(r.body.error, /no start position found for KQRK level 1/);
    assert.equal(r.body.status.level, 1);
  });
});
