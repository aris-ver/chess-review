// The drills' record and progression (server/drills.js) on the 3-piece tables made here: the level from the record, the
// checks on an attempt, the table loader, the deal, the schema of drill_attempts on both drivers, and its sync.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { LEVELS, positionKey } from '../core/drills.js';
import { mirrorFen, rookStart } from '../core/rook-drills.js';
import { ROOK_STARTS } from '../core/rook-starts.js';
import { generate, pack, tableSize } from '../core/endgame-table.js';
import { webSqlite } from '../web/db.js';
import { nodeSqlite } from './db-node.js';
import { DRILL_ATTEMPTS_SCHEMA, PROGRESS_DDL, SCHEMA_VERSION, Store } from './db.js';
import * as D from './drills.js';
import { BadRequest } from './http.js';
import { memoryFiles } from './profiles-files.js';
import { Sync, locate, merge, rowLine, tidy } from './sync.js';

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

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-drills-'));
  const store = new Store(nodeSqlite(dir));
  try {
    return await fn(store, dir);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const KQK = '8/8/8/8/8/2k5/8/K6Q w - - 0 1';        // any KQK start: positionKey only reads the pieces and the side
const KPK = '8/8/8/8/8/2k5/4P3/4K3 w - - 0 1';
const HOLD = '4k3/4p3/8/8/8/2K5/8/8 w - - 0 1';
const row = (ending, level, result) => ({ ending, level, result });
const run = (ending, list) => D.progress(ending, list.map(([level, result]) => row(ending, level, result)));
const S = 'solved', F = 'budget';

test('progress: up on 3 solved of the last 4, down on 2 fails in a row, never below 1', () => {
  assert.deepEqual(run('KQK', []), { level: 1, top: 5, star: false, run: [] });
  assert.equal(run('KQK', [[1, S], [1, S], [1, S]]).level, 2);
  assert.equal(run('KQK', [[1, S], [1, F], [1, S], [1, S]]).level, 2, '3 of 4');
  assert.equal(run('KQK', [[1, S], [1, F], [1, S], [1, F]]).level, 1, '2 of 4 is not enough');
  assert.equal(run('KQK', [[1, F], [1, S], [1, S], [1, F], [1, S]]).level, 2, 'window slides: the last 4 are S S F S');
  assert.equal(run('KQK', [[1, F], [1, F]]).level, 1, 'min level 1');
  assert.equal(run('KQK', [[1, S], [1, S], [1, S], [2, F], [2, F]]).level, 1, 'two fails in a row go down');
  assert.equal(run('KQK', [[1, S], [1, S], [1, S], [2, F], [2, S], [2, F]]).level, 2, 'not in a row');
});

test('progress: a move clears the run, and attempts at another level move nothing', () => {
  // up at the third solve; the next level starts with an empty run, so one fail there doesn't go down
  const p = run('KQK', [[1, S], [1, S], [1, S], [2, F]]);
  assert.deepEqual([p.level, p.run], [2, [false]]);
  // after falling back to 1 the old solves don't count: 3 fresh ones are needed
  assert.equal(run('KQK', [[1, S], [1, S], [1, S], [2, F], [2, F], [1, S], [1, S]]).level, 1);
  assert.equal(run('KQK', [[1, S], [1, S], [1, S], [2, F], [2, F], [1, S], [1, S], [1, S]]).level, 2);
  // a practice attempt at level 3 while at 1: on the record, no effect
  assert.equal(run('KQK', [[3, F], [3, F], [3, F]]).level, 1);
  assert.equal(run('KQK', [[1, S], [3, S], [1, S], [3, S], [1, S]]).level, 2);
});

test('progress: the top level, and the star', () => {
  const up = n => Array.from({ length: n }, () => [1, S]);
  // KQRK has 3 levels: 3 solves per level
  const climb = [...up(3), ...[2, 2, 2].map(l => [l, S])];
  let p = run('KQRK', climb);
  assert.deepEqual([p.level, p.top, p.star], [3, 3, false], 'reaching the top is not the star');
  p = run('KQRK', [...climb, [3, S]]);
  assert.deepEqual([p.level, p.star], [3, true], 'a solve at the top level is');
  // more solves at the top stay at the top; a fall keeps the star
  assert.equal(run('KQRK', [...climb, [3, S], [3, S], [3, S], [3, S]]).level, 3);
  p = run('KQRK', [...climb, [3, S], [3, F], [3, F]]);
  assert.deepEqual([p.level, p.star], [2, true]);
  assert.equal(run('KQRK', [...climb, [3, F]]).star, false);
  // a practice solve at the top level (chosen with ?level=) while the ending is at level 1 earns no star
  assert.equal(run('KQRK', [[3, S], [3, S]]).star, false);
  assert.equal(run('KQRK', [[3, S], ...climb, [3, S]]).star, true, 'a counted one later does');
  // one level on a one-level ending can't go up or down: KPK solves are 'promoted'
  assert.equal(run('KPK', [[1, 'promoted'], [1, 'promoted'], [1, 'promoted']]).level, 2);
  assert.equal(run('KPK-hold', [[1, 'held'], [1, 'pawn_taken'], [1, 'stalemate']]).level, 2);
  assert.equal(run('KPK-hold', [[1, 'threw'], [1, 'threw']]).level, 1);
});

test('what solves and what fails, per ending', () => {
  assert.ok(D.isSolved('KQK', 'solved') && !D.isSolved('KQK', 'budget') && !D.isSolved('KQK', 'abandoned'));
  assert.ok(D.isSolved('KPK', 'promoted') && !D.isSolved('KPK', 'solved') && !D.isSolved('KPK', 'threw'));
  assert.ok(D.isSolved('KPK-hold', 'held') && D.isSolved('KPK-hold', 'pawn_taken') && !D.isSolved('KPK-hold', 'promoted'));
  assert.ok(!D.isEnding('toString') && !D.isEnding(null) && D.isEnding('KPK-hold'));
});

const good = { ending: 'KQK', level: 2, fen: KQK, dtm: 6, budget: 12, moves_used: 9, result: 'solved', ms: 41000, worst_loss: 1 };

test('parseAttempt: checks the body, and says what is wrong', () => {
  assert.deepEqual(D.parseAttempt(good), { id: null, ...good });
  assert.deepEqual(D.parseAttempt({ ...good, id: 'abc_1', ms: null, worst_loss: null }).ms, null);
  const kpk = { ending: 'KPK', level: 1, fen: KPK, moves_used: 4, result: 'threw', ms: 100, worst_loss: null };
  assert.deepEqual(D.parseAttempt(kpk), { id: null, ...kpk, dtm: null, budget: null });
  assert.equal(D.parseAttempt({ ...kpk, dtm: null, budget: null, level: 4 }).level, 4);
  assert.equal(D.parseAttempt({ ending: 'KPK-hold', level: 2, fen: HOLD, moves_used: 20, result: 'held', worst_loss: -1 }).ms, null);
  const no = (o, re) => assert.throws(() => D.parseAttempt(o), e => e instanceof BadRequest && re.test(e.message), JSON.stringify(o));
  no(null, /object/);
  no([], /object/);
  no({ ...good, ending: 'KNNK' }, /ending/);
  // KBBK: the bishops on opposite colours only (c1 and f1), never on one (c1 and g1)
  const kbbk = { ...good, ending: 'KBBK', level: 1, dtm: 8, budget: 20, fen: '4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1' };
  assert.equal(D.parseAttempt(kbbk).ending, 'KBBK');
  no({ ...kbbk, fen: '4k3/8/8/8/8/8/8/2B1K1B1 w - - 0 1' }, /one colour/);
  no({ ...good, ending: 'constructor' }, /ending/);
  no({ ...good, ending: undefined }, /ending/);
  no({ ...good, level: 0 }, /level/);
  no({ ...good, level: 6 }, /level/);
  no({ ...good, level: 1.5 }, /level/);
  no({ ...good, level: '2' }, /level/);
  no({ ...good, fen: 'nonsense' }, /fen/);
  no({ ...good, fen: 5 }, /fen/);
  no({ ...good, fen: KPK }, /not a KQK/);
  no({ ...good, ending: 'KPK', level: 1, fen: KQK, dtm: null, budget: null }, /KPK/);
  no({ ...kpk, fen: HOLD }, /not a KPK start/);
  no({ ...kpk, ending: 'KPK-hold', result: 'held', fen: KPK }, /KPK-hold start/);
  no({ ...good, result: 'promoted' }, /result/);
  no({ ...good, result: undefined }, /result/);
  no({ ...kpk, result: 'solved' }, /result/);
  no({ ...good, dtm: null }, /dtm/);
  no({ ...good, budget: -1 }, /budget/);
  no({ ...kpk, dtm: 3 }, /no dtm or budget/);
  no({ ...kpk, budget: 3 }, /no dtm or budget/);
  no({ ...kpk, worst_loss: 2 }, /threw/);
  no({ ...good, moves_used: null }, /moves_used/);
  no({ ...good, moves_used: -1 }, /moves_used/);
  no({ ...good, ms: 'x' }, /ms/);
  no({ ...good, worst_loss: -2 }, /worst_loss/);
  no({ ...good, id: 'a b' }, /id/);
  no({ ...good, id: 7 }, /id/);
});

test('record: rows in order, a repeated id counted once, the level worked out from them', async () => {
  await withStore(async store => {
    const db = await store.progress();
    let n = 0;
    const make = () => `id${++n}`;
    const at = (result, extra = {}) => D.parseAttempt({ ...good, level: 1, result, ...extra });
    const first = D.record(db, at('solved'), 1000.7, make);
    assert.deepEqual([first.counted, first.id, first.before, first.status.level], [true, 'id1', 1, 1]);
    D.record(db, at('solved'), 1001, make);
    const third = D.record(db, at('solved'), 1002, make);
    assert.deepEqual([third.before, third.status.level, third.status.played, third.status.solved], [1, 2, 3, 3]);
    // the same id again: no new row, the standing unchanged
    const again = D.record(db, at('budget', { id: 'id2' }), 1003, make);
    assert.deepEqual([again.counted, again.id, again.status.played, again.status.level], [false, 'id2', 3, 2]);
    // another ending has its own level
    const other = D.record(db, D.parseAttempt({ ...good, ending: 'KRK', level: 1, fen: '8/8/8/8/8/2k5/8/K6R w - - 0 1', dtm: 9, budget: 21 }), 1004, make);
    assert.deepEqual([other.status.ending, other.status.level, other.status.played], ['KRK', 1, 1]);
    assert.equal(D.status(db, 'KQK').level, 2);
    assert.deepEqual(D.statuses(db).map(s => [s.ending, s.level, s.played]),
      [['KQRK', 1, 0], ['KRRK', 1, 0], ['KQK', 2, 3], ['KRK', 1, 1], ['KPK', 1, 0], ['KPK-hold', 1, 0], ['KBBK', 1, 0], ['KBNK', 1, 0],
        ['Lucena', 1, 0], ['Philidor', 1, 0]]);
    const rows = D.attempts(db, 'KQK');
    assert.deepEqual(rows.map(r => r.ts), [1000, 1001, 1002]);
    assert.deepEqual(Object.keys(rows[0]), ['id', 'ts', 'ending', 'level', 'fen', 'dtm', 'budget', 'moves_used', 'result', 'ms', 'worst_loss']);
    assert.equal(D.status(db, 'KQK').recent.length, 3);
    // recent is capped
    for (let i = 0; i < 12; i++) D.record(db, at('budget'), 2000 + i, make);
    assert.equal(D.status(db, 'KQK').recent.length, D.RECENT_SHOWN);
    // KPK rows keep their nulls
    D.record(db, D.parseAttempt({ ending: 'KPK', level: 1, fen: KPK, moves_used: 3, result: 'threw', ms: 5, worst_loss: null }), 3000, make);
    const k = D.attempts(db, 'KPK')[0];
    assert.deepEqual([k.dtm, k.budget, k.worst_loss, k.result], [null, null, null, 'threw']);
  });
});

test('tables: loaded on first use, kept, retried after a failure; files plain or gzipped', async () => {
  assert.deepEqual(D.tablesFor('KQRK'), ['KQK', 'KRK', 'KQRK']);
  assert.deepEqual(D.tablesFor('KPK-hold'), ['KQK', 'KRK', 'KPK']);
  assert.deepEqual(D.tablesFor('KRRK'), ['KRK', 'KRRK']);
  assert.deepEqual(D.tablesFor('KBNK'), ['KBNK']);
  assert.deepEqual(D.tablesFor('KBBK'), ['KBBK']);
  assert.throws(() => D.tablesFor('KNNK'), RangeError);
  const asked = [];
  let broken = true;
  const t = new D.DrillTables(async name => {
    asked.push(name);
    if (broken && name === 'KRK') throw new Error('not there yet');
    return tables[name];
  });
  assert.deepEqual(asked, [], 'lazy');
  await assert.rejects(t.get('KRK'), /not there yet/);
  broken = false;
  const got = await t.get('KRK');
  assert.deepEqual(Object.keys(got), ['KRK']);
  assert.equal(got.KRK, tables.KRK);
  await t.get('KRK');
  assert.deepEqual(asked, ['KRK', 'KRK'], 'the failure was asked again, the success kept');

  const files = {
    'endgames/kqk.bin': gzipSync(pack(tables.KQK)),
    'endgames/krk.bin': pack(tables.KRK),
    'endgames/kpk.bin': gzipSync(pack(tables.KQK)),    // the wrong table in a file
  };
  const load = D.tablesFromFiles(async p => files[p] ?? null);
  assert.equal((await load('KQK')).data.length, tableSize('KQK'));
  assert.deepEqual((await load('KRK')).data, tables.KRK.data);
  await assert.rejects(load('KPK'), /holds the KQK table/);
  await assert.rejects(load('KQRK'), /no KQRK table file/);
});

test('nextDrill: the level from the record, never a position just played, KPK drills carry no budget', async () => {
  await withStore(async store => {
    const db = await store.progress();
    const r = rng(7);
    let out = D.nextDrill(db, tables, 'KQK', { rng: r });
    assert.deepEqual([out.level, out.drill.level, out.drill.mode, out.drill.counter], [1, 1, 'mate', true]);
    assert.ok(out.drill.dtm >= 3 && out.drill.dtm <= 5 && out.drill.budget === out.drill.dtm + 10);
    assert.equal(out.status.played, 0);
    // play the dealt position (solved), and the next deal is another one, three solves take the level up
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
      out = D.nextDrill(db, tables, 'KQK', { rng: r });
      const key = positionKey(out.drill.fen);
      assert.ok(!seen.has(key), 'a repeat');
      seen.add(key);
      D.record(db, D.parseAttempt({ ...out.drill, ending: 'KQK', moves_used: 5, result: 'solved' }), 100 + i);
    }
    out = D.nextDrill(db, tables, 'KQK', { rng: r });
    assert.deepEqual([out.level, out.status.level], [2, 2]);
    assert.ok(out.drill.dtm >= 5 && out.drill.dtm <= 7);
    // a practice level overrides the record's
    assert.equal(D.nextDrill(db, tables, 'KQK', { level: 5, rng: r }).drill.level, 5);
    assert.throws(() => D.nextDrill(db, tables, 'KQK', { level: 6 }), RangeError);

    const attack = D.nextDrill(db, tables, 'KPK', { rng: r }).drill;
    assert.deepEqual([attack.mode, attack.dtm, attack.budget, attack.counter, attack.hold_moves], ['attack', null, null, false, null]);
    const hold = D.nextDrill(db, tables, 'KPK-hold', { rng: r }).drill;
    assert.deepEqual([hold.mode, hold.dtm, hold.budget, hold.hold_moves], ['hold', null, null, 20]);
    // what is dealt can be recorded as it stands
    D.parseAttempt({ ...hold, ending: 'KPK-hold', moves_used: 20, result: 'held', worst_loss: -1 });
    D.parseAttempt({ ...attack, ending: 'KPK', moves_used: 6, result: 'promoted', worst_loss: 0 });
  });
});

test('nextDrill: no start position is a null drill, not a crash', async () => {
  await withStore(async store => {
    const db = await store.progress();
    // an all-draw KQRK table: nothing is in any band
    const empty = { ...tables, KQRK: { name: 'KQRK', data: new Uint8Array(tableSize('KQRK')) } };
    const out = D.nextDrill(db, empty, 'KQRK', { rng: rng(1) });
    assert.deepEqual([out.drill, out.level, out.status.level], [null, 1, 1]);
  });
});

test('drill_attempts: every level of KQK to KPK-hold is a level core/drills.js has', () => {
  for (const e of Object.keys(LEVELS)) assert.equal(D.topLevel(e), LEVELS[e].length);
});

// ---------- the table and its sync ----------

const master = db => db.all("SELECT type, name, sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").map(r => ({ ...r }));

test('db: a progress database at schema 4 gets drill_attempts, the same schema as a new one, on both drivers', async () => {
  assert.equal(SCHEMA_VERSION, 5);
  const dir = mkdtempSync(join(tmpdir(), 'blundr-drills-'));
  const fresh = mkdtempSync(join(tmpdir(), 'blundr-drills-'));
  try {
    const raw = await nodeSqlite(dir).open('progress.sqlite');
    raw.exec(PROGRESS_DDL);
    raw.exec('ALTER TABLE puzzle_solved ADD COLUMN "clean" BOOLEAN');     // schema 2's addition
    raw.exec("PRAGMA user_version = 4; INSERT INTO puzzle_solved (id, ts) VALUES ('a', 5)");
    raw.close();
    const old = new Store(nodeSqlite(dir)), blank = new Store(nodeSqlite(fresh));
    try {
      const db = await old.progress(), ref = await blank.progress();
      assert.deepEqual(master(db), master(ref));
      assert.ok(master(db).some(r => r.name === 'drill_attempts'));
      assert.equal(db.value('PRAGMA user_version'), 5);
      assert.equal(db.value("SELECT count(*) FROM puzzle_solved WHERE id = 'a'"), 1);
      // the columns are the schema's, in order
      assert.deepEqual(db.all("SELECT name FROM pragma_table_info('drill_attempts')").map(r => r.name), DRILL_ATTEMPTS_SCHEMA.map(c => c[0]));
      // a profile or an evals database has none
      assert.equal((await old.profile('x')).value("SELECT count(*) FROM main.sqlite_master WHERE name = 'drill_attempts'"), 0);
      assert.equal((await old.evals()).value("SELECT count(*) FROM main.sqlite_master WHERE name = 'drill_attempts'"), 0);
    } finally {
      await old.close();
      await blank.close();
    }
    const wasm = readFileSync(new URL('../vendor/sqlite-wasm/sqlite3.wasm', import.meta.url));
    const web = new Store(await webSqlite({ memory: true, root: 'drills-schema', wasmBinary: wasm }));
    try {
      const wdb = await web.progress(), node = new Store(nodeSqlite(fresh));
      assert.deepEqual(master(wdb), master(await node.progress()));
      await node.close();
      D.record(wdb, D.parseAttempt(good), 5, () => 'w1');
      assert.equal(D.status(wdb, 'KQK').played, 1);
    } finally {
      await web.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

const FILE = 'drill_attempts.jsonl';
const LINE = '{"id": "a1", "ts": 5, "ending": "KQK", "level": 2, "fen": "8/8/8/8/8/2k5/8/K6Q w - - 0 1", "dtm": 6, "budget": 12, "moves_used": 9, "result": "solved", "ms": 41000, "worst_loss": 1}';

test('sync: drill_attempts.jsonl lines as the rows write them, merged one line per id', () => {
  assert.deepEqual(locate(FILE), { db: 'progress.sqlite', table: 'drill_attempts', archive: null, dir: null });
  assert.equal(locate('profiles/chesscom-alice/drill_attempts.jsonl'), null);
  assert.equal(rowLine('drill_attempts', { seq: 1, ...D.parseAttempt({ ...good, id: 'a1', ms: 41000 }), ts: 5 }), LINE);
  // KPK: the nulls are keys the line doesn't have, except ms
  assert.equal(rowLine('drill_attempts', { id: 'k', ts: 1, ending: 'KPK', level: 1, fen: KPK, dtm: null, budget: null, moves_used: 4,
    result: 'threw', ms: null, worst_loss: null }),
  `{"id": "k", "ts": 1, "ending": "KPK", "level": 1, "fen": "${KPK}", "moves_used": 4, "result": "threw", "ms": null}`);
  const l = (id, ts) => `{"id": "${id}", "ts": ${ts}}`;
  assert.deepEqual(tidy(FILE, [l('b', 2), l('a', 1), l('b', 3)]), [l('a', 1), l('b', 2)]);
  assert.deepEqual(merge({ [FILE]: [l('a', 1)] }, { [FILE]: [l('a', 1), l('c', 3)] }, { [FILE]: [l('a', 1), l('b', 2)] }),
    { [FILE]: [l('a', 1), l('b', 2), l('c', 3)] });
});

test('sync: the record goes out as lines, comes in on another device, and the level follows', async () => {
  const mk = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blundr-drills-sync-'));
    const store = new Store(nodeSqlite(dir)), files = memoryFiles();
    return { dir, store, files, sync: new Sync({ files, store }), done: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); } };
  };
  const A = await mk(), B = await mk();
  try {
    const db = await A.store.progress();
    let n = 0;
    for (const result of ['solved', 'solved', 'solved', 'budget']) {
      D.record(db, D.parseAttempt({ ...good, level: result === 'budget' ? 2 : 1, result }), 100 + n, () => `a${++n}`);
    }
    const kpk = D.parseAttempt({ ending: 'KPK', level: 1, fen: KPK, moves_used: 4, result: 'threw', ms: null, worst_loss: null });
    D.record(db, kpk, 200, () => 'k1');
    const local = await A.sync.local();
    assert.deepEqual(Object.keys(local), [FILE]);
    assert.equal(local[FILE].length, 5);
    assert.ok(local[FILE].every(x => x === x.trim() && JSON.parse(x).id));
    // device B takes the account's lines
    await B.sync.writeLines('', FILE, local[FILE]);
    const bdb = await B.store.progress();
    assert.deepEqual(D.attempts(bdb).map(r => ({ ...r })), D.attempts(db).map(r => ({ ...r })));
    assert.deepEqual([D.status(bdb, 'KQK').level, D.status(bdb, 'KPK').played], [2, 1]);
    assert.deepEqual(await B.sync.readLines('', FILE), local[FILE]);
    // B's own attempt travels back, the others aren't doubled
    D.record(bdb, D.parseAttempt({ ...good, level: 2, result: 'solved' }), 300, () => 'b1');
    const delta = await B.sync.delta('u1');
    assert.deepEqual(Object.keys(delta.add), [FILE]);
    assert.equal(delta.add[FILE].length, 6);
    // deleting the lines (a switch away) empties the table
    await B.sync.deleteLines('', FILE);
    assert.equal(bdb.value('SELECT count(*) FROM drill_attempts'), 0);
  } finally {
    await A.done();
    await B.done();
  }
});

test('nextDrill: a synced row without a usable fen is skipped when working out what was dealt', async () => {
  await withStore(async store => {
    const db = await store.progress();
    db.run("INSERT INTO drill_attempts (id, ts, ending, level, result) VALUES ('x', 1, 'KQK', 1, 'solved')");
    db.run("INSERT INTO drill_attempts (id, ts, ending, level, fen, result) VALUES ('y', 2, 'KQK', 1, 'junk', 'budget')");
    const out = D.nextDrill(db, tables, 'KQK', { rng: rng(5) });
    assert.ok(out.drill);
    assert.equal(out.status.played, 2);
  });
});

// ---------- the rook drills ----------

const LUC = ROOK_STARTS.Lucena[0][3], PHI = ROOK_STARTS.Philidor[3][7];
const rookAttempt = (extra = {}) => ({ ending: 'Lucena', level: 1, fen: LUC.fen, dtm: null, budget: LUC.promote + 8,
  moves_used: 7, result: 'promoted', ms: 42000, worst_loss: null, ...extra });

test('rook drills: their results, tables, and the checks on an attempt', () => {
  assert.deepEqual(D.RESULTS.Lucena.solved, ['promoted', 'won']);
  assert.deepEqual(D.RESULTS.Philidor.solved, ['held', 'pawn_taken', 'rook_won', 'stalemate']);
  assert.ok(D.isSolved('Philidor', 'rook_won') && !D.isSolved('Philidor', 'promoted') && D.isSolved('Lucena', 'promoted'));
  assert.deepEqual([D.topLevel('Lucena'), D.topLevel('Philidor')], [4, 4]);
  assert.deepEqual(D.tablesFor('Lucena'), ['KQK', 'KRK', 'KPK', 'KQRK', 'KRRK', 'KQKR', 'KRKR']);
  assert.deepEqual(D.tablesFor('Philidor'), D.tablesFor('Lucena'));
  const a = D.parseAttempt(rookAttempt());
  assert.deepEqual([a.ending, a.level, a.dtm, a.budget, a.worst_loss, a.result], ['Lucena', 1, null, LUC.promote + 8, null, 'promoted']);
  assert.equal(D.parseAttempt(rookAttempt({ fen: mirrorFen(LUC.fen) })).fen, mirrorFen(LUC.fen));
  const p = D.parseAttempt({ ending: 'Philidor', level: 4, fen: PHI.fen, moves_used: 30, result: 'held', ms: 1 });
  assert.deepEqual([p.budget, p.dtm, p.worst_loss], [null, null, null]);
  const refused = (b, re) => assert.throws(() => D.parseAttempt(b), e => e instanceof BadRequest && re.test(e.message), re);
  refused(rookAttempt({ level: 2 }), /not a Lucena start position/);                 // a level 1 start sent as level 2
  refused(rookAttempt({ fen: PHI.fen }), /not a Lucena start position/);
  refused(rookAttempt({ fen: '8/8/8/8/8/2k5/8/K6Q w - - 0 1' }), /not a Lucena start position/);
  refused(rookAttempt({ result: 'solved' }), /result: one of promoted, won, pawn_lost/);
  refused(rookAttempt({ result: 'rook_won' }), /result/);
  refused(rookAttempt({ dtm: 5 }), /no dtm/);
  refused(rookAttempt({ budget: LUC.promote + 9 }), /budget: \d+ for this Lucena start/);
  refused(rookAttempt({ budget: null }), /budget/);
  refused(rookAttempt({ worst_loss: -1 }), /worst_loss is null for Lucena/);
  refused({ ending: 'Philidor', level: 4, fen: PHI.fen, budget: 3, moves_used: 1, result: 'held' }, /budget: null/);
  refused({ ending: 'Philidor', level: 4, fen: PHI.fen, moves_used: 1, result: 'won' }, /result/);
});

test('rook drills: dealt from ROOK_STARTS at the level, never one of the last 30 there, the drill shaped for them', async () => {
  await withStore(async store => {
    const db = await store.progress();
    const out = D.nextDrill(db, {}, 'Lucena', { rng: rng(9) });
    const { drill } = out;
    assert.deepEqual([drill.ending, drill.level, drill.mode, drill.dtm, drill.counter, drill.hold_moves, drill.post_promo],
      ['Lucena', 1, 'lucena', null, false, null, 10]);
    const at = rookStart(drill.fen);
    assert.equal(at.level, 1);
    assert.equal(drill.budget, at.entry.promote + 8);
    const ph = D.nextDrill(db, {}, 'Philidor', { level: 4, rng: rng(9) }).drill;
    assert.deepEqual([ph.mode, ph.level, ph.budget, ph.hold_moves, ph.post_promo], ['philidor', 4, null, 30, null]);
    // 45 attempts at Philidor level 4 (of its 49), recorded: the next is none of the last 30
    let n = 0;
    for (let k = 0; k < 45; k++) {
      const d = D.nextDrill(db, {}, 'Philidor', { level: 4, rng: rng(100 + k) }).drill;
      D.record(db, D.parseAttempt({ ending: 'Philidor', level: 4, fen: d.fen, moves_used: 30, result: 'held', ms: 1 }), 10 + k, () => `p${++n}`);
    }
    const keys = D.attempts(db, 'Philidor').map(r => positionKey(r.fen));
    for (let k = 30; k < keys.length; k++) assert.ok(!keys.slice(k - 30, k).includes(keys[k]), `deal ${k} repeats`);
    const next = positionKey(D.nextDrill(db, {}, 'Philidor', { level: 4, rng: rng(7) }).drill.fen);
    assert.ok(!keys.slice(-30).includes(next));
  });
});

test('sync: a row of an ending this version does not know survives an import and an export unchanged', async () => {
  const mk = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blundr-drills-unknown-'));
    const store = new Store(nodeSqlite(dir)), files = memoryFiles();
    return { store, sync: new Sync({ files, store }), done: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); } };
  };
  const A = await mk(), B = await mk();
  try {
    // what a v1.1.0 client meets: a Lucena row, and one of an ending nobody has made yet
    const lines = [
      '{"id": "r1", "ts": 7, "ending": "Lucena", "level": 2, "fen": "1K6/1P6/4k3/3r4/8/8/8/2R5 w - - 0 1", "budget": 8, "moves_used": 5, "result": "promoted", "ms": 30000}',
      '{"id": "r2", "ts": 8, "ending": "KQKR", "level": 1, "fen": "8/8/8/8/2r5/8/2k5/K6Q w - - 0 1", "dtm": 35, "moves_used": 40, "result": "mated_in_time", "ms": 1}',
    ];
    await A.sync.writeLines('', FILE, lines);
    const db = await A.store.progress();
    assert.equal(db.value('SELECT count(*) FROM drill_attempts'), 2);
    assert.deepEqual(await A.sync.readLines('', FILE), lines);
    // the standing skips the unknown ending, the next export still carries it, and a second device gets the same
    assert.deepEqual(D.statuses(db).map(s => s.ending).includes('KQKR'), false);
    await B.sync.writeLines('', FILE, await A.sync.readLines('', FILE));
    assert.deepEqual(await B.sync.readLines('', FILE), await A.sync.readLines('', FILE));
    assert.equal(D.status(await B.store.progress(), 'Lucena').played, 1);
  } finally {
    await A.done();
    await B.done();
  }
});
