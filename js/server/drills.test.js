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
import { DRILL_ATTEMPTS_SCHEMA, DRILL_ROW, PROGRESS_DDL, SCHEMA_VERSION, Store } from './db.js';
import * as D from './drills.js';
import { BadRequest } from './http.js';
import { memoryFiles } from './profiles-files.js';
import { Sync, diff, locate, merge, rowLine, tidy } from './sync.js';

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
  assert.deepEqual(run('KQK', []), { level: 1, top: 5, tiers: 3, star: false, clock_star: false, run: [] });
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
  // three solves at the top go on to the clock (level 4, Clock 1); a fall keeps the star
  assert.equal(run('KQRK', [...climb, [3, S], [3, S], [3, S], [3, S]]).level, 4);
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
  assert.deepEqual(D.parseAttempt(good), { id: null, ...good, clock: null, move_ms: null, paused: null });
  assert.deepEqual(D.parseAttempt({ ...good, id: 'abc_1', ms: null, worst_loss: null }).ms, null);
  const kpk = { ending: 'KPK', level: 1, fen: KPK, moves_used: 4, result: 'threw', ms: 100, worst_loss: null };
  assert.deepEqual(D.parseAttempt(kpk), { id: null, ...kpk, dtm: null, budget: null, clock: null, move_ms: null, paused: null });
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
  no({ ...good, level: 9 }, /level/);
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
    assert.deepEqual(Object.keys(rows[0]), ['id', 'ts', 'ending', 'level', 'fen', 'dtm', 'budget', 'moves_used', 'result', 'ms', 'worst_loss',
      'clock', 'move_ms', 'paused']);
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
    assert.throws(() => D.nextDrill(db, tables, 'KQK', { level: 9 }), RangeError);

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

test('drill_attempts: every level is one core/drills.js has, or a clock tier above its top', () => {
  for (const e of Object.keys(LEVELS)) {
    assert.equal(D.untimedTop(e), LEVELS[e].length);
    assert.equal(D.topLevel(e), LEVELS[e].length + (e === 'Lucena' || e === 'Philidor' ? 2 : 3));
  }
});

// ---------- the table and its sync ----------

const master = db => db.all("SELECT type, name, sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").map(r => ({ ...r }));

test('db: a progress database at schema 4 gets drill_attempts, the same schema as a new one, on both drivers', async () => {
  assert.equal(SCHEMA_VERSION, 6);
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
      assert.equal(db.value('PRAGMA user_version'), 6);
      assert.equal(db.value("SELECT count(*) FROM puzzle_solved WHERE id = 'a'"), 1);
      // the columns are the schema's, in order
      assert.deepEqual(db.all("SELECT name FROM pragma_table_info('drill_attempts')").map(r => r.name), DRILL_ROW.map(c => c[0]));
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
  assert.deepEqual(locate(FILE), { db: 'progress.sqlite', table: 'drill_attempts', archive: null, dir: null, keys: 'drill_attempts',
    where: 'clock IS NULL' });
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
const rookAttempt = (extra = {}) => ({ ending: 'Lucena', level: 1, fen: LUC.fen, dtm: null, budget: LUC.promote + 12,
  moves_used: 7, result: 'promoted', ms: 42000, worst_loss: null, ...extra });

test('rook drills: their results, tables, and the checks on an attempt', () => {
  assert.deepEqual(D.RESULTS.Lucena.solved, ['promoted', 'won']);
  assert.deepEqual(D.RESULTS.Philidor.solved, ['held', 'pawn_taken', 'rook_won', 'stalemate']);
  assert.ok(D.isSolved('Philidor', 'rook_won') && !D.isSolved('Philidor', 'promoted') && D.isSolved('Lucena', 'promoted'));
  assert.deepEqual([D.untimedTop('Lucena'), D.untimedTop('Philidor'), D.topLevel('Lucena'), D.topLevel('Philidor')], [4, 4, 6, 6]);
  assert.deepEqual(D.tablesFor('Lucena'), ['KQK', 'KRK', 'KPK', 'KQRK', 'KRRK', 'KQKR', 'KRKR']);
  assert.deepEqual(D.tablesFor('Philidor'), D.tablesFor('Lucena'));
  const a = D.parseAttempt(rookAttempt());
  assert.deepEqual([a.ending, a.level, a.dtm, a.budget, a.worst_loss, a.result], ['Lucena', 1, null, LUC.promote + 12, null, 'promoted']);
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
  refused(rookAttempt({ budget: LUC.promote + 13 }), /budget: \d+ for this Lucena start/);
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
    assert.equal(drill.budget, at.entry.promote + 12);
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

// ---------- the clock (phase 6) ----------

// main's progress() before the clock, the oracle for records made then (no rows above the top)
function oldProgress(ending, rows) {
  const top = LEVELS[ending].length;
  let level = 1, run = [], star = false;
  for (const r of rows) {
    const ok = D.isSolved(ending, r.result);
    if (r.level !== level) continue;
    if (ok && level === top) star = true;
    run.push(ok);
    if (run.length > 4) run.shift();
    if (level < top && run.filter(Boolean).length >= 3) {
      level++;
      run = [];
    } else if (level > 1 && run.length >= 2 && run.slice(-2).every(x => !x)) {
      level--;
      run = [];
    }
  }
  return { level, top, star, run };
}

const CLOCK = { tier: 1, base_ms: 1, inc_ms: 1 };     // what progress() looks at: a clock or none
const trun = (ending, list) => D.progress(ending, list.map(([level, result, extra = {}]) =>
  ({ ending, level, result, clock: level > LEVELS[ending].length ? CLOCK : null, ...extra })));
const kindKey = e => (e === 'KPK' || e === 'KPK-hold' || e === 'Lucena' || e === 'Philidor' ? e : 'mate');

test('progress: every record made before the clock replays to the level it had, or Clock 1 when it qualified', () => {
  const r = rng(11);
  for (const e of Object.keys(LEVELS)) {
    const top = LEVELS[e].length, ok = D.RESULTS[kindKey(e)];
    let qualified = 0;
    for (let k = 0; k < 2000; k++) {
      const rows = [];
      for (let n = Math.floor(r() * 50); n > 0; n--) {
        const at = oldProgress(e, rows).level;
        const level = r() < 0.85 ? at : 1 + Math.floor(r() * top);
        const list = r() < 0.6 ? ok.solved : ok.failed.filter(x => x !== 'time');
        rows.push({ ending: e, level, result: list[Math.floor(r() * list.length)], clock: null });
      }
      const was = oldProgress(e, rows), now = D.progress(e, rows);
      const ready = was.level === top && was.run.filter(Boolean).length >= 3;
      qualified += ready;
      assert.deepEqual([now.level, now.run, now.star, now.clock_star], ready ? [top + 1, [], was.star, false] : [was.level, was.run, was.star, false],
        `${e} ${JSON.stringify(rows.map(x => [x.level, x.result]))}`);
    }
    assert.ok(qualified > 20, `${e}: ${qualified} of 2000 records qualified, too few to test`);
  }
});

test('progress: the step onto the clock, down from it, and the clock star', () => {
  const climb = [[1, S], [1, S], [1, S], [2, S], [2, S], [2, S]];     // KQRK: 3 levels, then Clock 1 to 3 (4 to 6)
  // S S F S at the top: ready, on Clock 1 with an empty run; the first Clock 1 row is counted there
  let p = trun('KQRK', [...climb, [3, S], [3, S], [3, F], [3, S]]);
  assert.deepEqual([p.level, p.run, p.star, p.tiers, p.top], [4, [], true, 3, 3]);
  p = trun('KQRK', [...climb, [3, S], [3, S], [3, F], [3, S], [4, S]]);
  assert.deepEqual([p.level, p.run], [4, [true]]);
  // ready, then two fails at the top (an older page dealt the top): the run slides, not ready, down
  p = trun('KQRK', [...climb, [3, S], [3, S], [3, F], [3, S], [3, F]]);
  assert.deepEqual([p.level, p.run], [3, [true, false, true, false]]);
  p = trun('KQRK', [...climb, [3, S], [3, S], [3, F], [3, S], [3, F], [3, F]]);
  assert.deepEqual([p.level, p.run], [2, []]);
  // two fails at Clock 1: back to the top level, the run cleared
  const onClock = [...climb, [3, S], [3, S], [3, S], [4, S]];
  p = trun('KQRK', [...onClock, [4, 'time'], [4, F]]);
  assert.deepEqual([p.level, p.run], [3, []]);
  // and three fresh solves at the top to come back
  assert.equal(trun('KQRK', [...onClock, [4, 'time'], [4, F], [3, S], [3, S]]).level, 3);
  assert.equal(trun('KQRK', [...onClock, [4, 'time'], [4, F], [3, S], [3, S], [3, S]]).level, 4);
  // up the tiers to the last one, its star sticky
  const last = [...onClock, [4, S], [4, S], [5, S], [5, S], [5, S]];
  p = trun('KQRK', last);
  assert.deepEqual([p.level, p.clock_star], [6, false], 'reaching the last tier is not the clock star');
  p = trun('KQRK', [...last, [6, S]]);
  assert.deepEqual([p.level, p.clock_star, p.star], [6, true, true]);
  p = trun('KQRK', [...last, [6, S], [6, 'time'], [6, 'time'], [5, F], [5, F], [4, F], [4, F], [3, F], [3, F]]);
  assert.deepEqual([p.level, p.clock_star, p.star], [2, true, true], 'both stars stay');
  // a practice solve at the last tier from level 1 earns neither
  p = trun('KQRK', [[6, S], [3, S]]);
  assert.deepEqual([p.level, p.clock_star, p.star], [1, false, false]);
  // the rook endings: 2 tiers
  assert.equal(D.progress('Lucena', []).tiers, 2);
});

test('progress: a row whose clock does not fit its level, and a repeated id, are skipped', () => {
  const climb = [[1, S], [1, S], [1, S], [2, S], [2, S], [2, S], [3, S], [3, S], [3, S]];
  // an older app's stripped copy of a Clock 1 row (no clock) and a clock on an untimed row: neither counts
  let p = trun('KQRK', [...climb, [4, F, { clock: null }], [4, F, { clock: null }]]);
  assert.deepEqual([p.level, p.run], [4, []]);
  p = trun('KQRK', [[1, S, { clock: CLOCK }], [1, S, { clock: CLOCK }], [1, S, { clock: CLOCK }]]);
  assert.equal(p.level, 1);
  // the same id twice (a copy in both sync files): the first is kept
  p = trun('KQRK', [[1, S, { id: 'a' }], [1, S, { id: 'b' }], [1, S, { id: 'b' }]]);
  assert.deepEqual([p.level, p.run], [1, [true, true]]);
});

const KQK10 = { ending: 'KQK', level: 6, fen: KQK, dtm: 10, budget: 11, moves_used: 3, result: 'solved', ms: 10000, worst_loss: 0,
  clock: { tier: 1, base_ms: 44000, inc_ms: 1000 }, move_ms: [1000, 2000, 3000], paused: 0 };

test('parseAttempt: a timed attempt, its clock and its turn times checked', () => {
  const a = D.parseAttempt(KQK10);
  assert.deepEqual([a.level, a.clock, a.move_ms, a.paused], [6, KQK10.clock, [1000, 2000, 3000], 0]);
  // Clock 3: 2 s a move
  assert.equal(D.parseAttempt({ ...KQK10, level: 8, clock: { tier: 3, base_ms: 22000, inc_ms: 1000 } }).clock.tier, 3);
  // out of time on the third turn: one more entry than moves, the last ending at 0 (within 250 ms)
  const time = { ...KQK10, result: 'time', moves_used: 2, move_ms: [20000, 20000, 6000], ms: 47000 };
  assert.equal(D.parseAttempt(time).result, 'time');
  assert.equal(D.parseAttempt({ ...time, move_ms: [20000, 20000, 6200] }).result, 'time');
  assert.equal(D.parseAttempt({ ...time, moves_used: 0, move_ms: [44000] }).moves_used, 0, 'out of time before the first move');
  // given up during a turn: that turn may be there or not
  assert.equal(D.parseAttempt({ ...KQK10, result: 'abandoned', move_ms: [1000, 2000, 3000, 500] }).move_ms.length, 4);
  assert.equal(D.parseAttempt({ ...KQK10, result: 'abandoned' }).move_ms.length, 3);
  // a turn that ends 200 ms over is rounding
  assert.equal(D.parseAttempt({ ...KQK10, moves_used: 1, move_ms: [44200], ms: 45000 }).moves_used, 1);
  // the rook and pawn endings
  const kpk = { ending: 'KPK', level: 7, fen: KPK, moves_used: 1, result: 'promoted', ms: 3000, worst_loss: 0,
    clock: { tier: 3, base_ms: 40000, inc_ms: 1000 }, move_ms: [2000], paused: 2 };
  assert.equal(D.parseAttempt(kpk).paused, 2);
  const luc = ROOK_STARTS.Lucena[3][0], budget = luc.promote + 8;
  assert.equal(D.parseAttempt({ ending: 'Lucena', level: 5, fen: luc.fen, budget, moves_used: 1, result: 'promoted', ms: 5000,
    clock: { tier: 1, base_ms: budget * 6000, inc_ms: 2000 }, move_ms: [4000], paused: 0 }).level, 5);
  assert.equal(D.parseAttempt({ ending: 'Philidor', level: 6, fen: PHI.fen, moves_used: 1, result: 'held', ms: 5000,
    clock: { tier: 2, base_ms: 120000, inc_ms: 2000 }, move_ms: [4000], paused: 0 }).level, 6);

  const no = (o, re) => assert.throws(() => D.parseAttempt(o), e => e instanceof BadRequest && re.test(e.message), JSON.stringify(o));
  no({ ...KQK10, clock: { tier: 1, base_ms: 40000, inc_ms: 1000 } }, /clock: \{"tier":1,"base_ms":44000,"inc_ms":1000\} for this start/);
  no({ ...KQK10, clock: { ...KQK10.clock, extra: 1 } }, /clock/);
  no({ ...KQK10, clock: null }, /clock/);
  no({ ...KQK10, level: 7 }, /clock/);
  no({ ...KQK10, budget: 12, clock: { tier: 1, base_ms: 48000, inc_ms: 1000 } }, /budget: 11/);    // not the top's slack
  no({ ...good, clock: KQK10.clock }, /clock: none at KQK level 2/);
  no({ ...good, move_ms: [1] }, /move_ms: none/);
  no({ ...good, paused: 0 }, /paused: none/);
  no({ ...good, result: 'time' }, /'time' only at a timed level/);
  no({ ...KQK10, move_ms: [1000, 2000] }, /move_ms: 3 turns/);
  no({ ...KQK10, result: 'abandoned', move_ms: [1000] }, /move_ms: 3 or 4 turns/);
  no({ ...time, move_ms: [20000, 20000] }, /move_ms: 3 turns/);
  no({ ...KQK10, moves_used: 1, move_ms: [45000], ms: 46000 }, /run out by the end of turn 1/);
  no({ ...KQK10, move_ms: [1000, 50000, 1000], ms: 60000 }, /run out by the end of turn 2/);
  no({ ...time, move_ms: [20000, 20000, 5000] }, /'time' with 1000 ms still on the clock/);
  no({ ...KQK10, ms: 5000 }, /more think time/);
  no({ ...KQK10, ms: null }, /ms is required/);
  no({ ...KQK10, move_ms: Array(151).fill(0), moves_used: 151 }, /up to 150/);
  no({ ...KQK10, move_ms: [1000, 2000.5, 3000] }, /integers/);
  no({ ...KQK10, move_ms: [1000, -1, 3000] }, /integers/);
  no({ ...KQK10, move_ms: '1000' }, /integers/);
  no({ ...KQK10, paused: -1 }, /paused/);
  no({ ...KQK10, paused: undefined }, /paused is required/);
});

test('nextDrill and record: a timed deal at the top level band with its clock, the row keeps it', async () => {
  await withStore(async store => {
    const db = await store.progress();
    const r = rng(21);
    for (const level of [6, 7, 8]) {
      const { drill } = D.nextDrill(db, tables, 'KQK', { level, rng: r });
      assert.deepEqual([drill.level, drill.counter, drill.budget], [level, false, drill.dtm + 1]);
      assert.ok(drill.dtm >= 9 && drill.dtm <= 10, `dtm ${drill.dtm}`);
      assert.deepEqual(drill.clock, { tier: level - 5, base_ms: drill.budget * [4, 3, 2][level - 6] * 1000, inc_ms: 1000 });
    }
    assert.equal(D.nextDrill(db, tables, 'KQK', { rng: r }).drill.clock, null, 'an untimed level has none');
    const kpk = D.nextDrill(db, tables, 'KPK', { level: 5, rng: r }).drill;
    assert.deepEqual([kpk.level, kpk.clock], [5, { tier: 1, base_ms: 80000, inc_ms: 1000 }]);
    // what is dealt is recorded as it stands, with the times
    const { drill } = D.nextDrill(db, tables, 'KQK', { level: 6, rng: r });
    const out = D.record(db, D.parseAttempt({ ...drill, moves_used: 2, result: 'solved', ms: 9000, worst_loss: 0,
      move_ms: [1500, 2500], paused: 1 }), 50, () => 't1');
    assert.equal(out.counted, true);
    const row = D.attempts(db, 'KQK').at(-1);
    assert.deepEqual([row.clock, row.move_ms, row.paused], [drill.clock, [1500, 2500], 1]);
    assert.equal(db.value("SELECT typeof(clock) FROM drill_attempts WHERE id = 't1'"), 'text');
    const st = D.status(db, 'KQK');
    assert.deepEqual([st.level, st.top, st.tiers, st.tier, st.clock_star, st.played], [1, 5, 3, 0, false, 1]);
  });
});

test('attempts: in ts order, so rows written back by a sync with new seqs interleave as they were made', async () => {
  await withStore(async store => {
    const db = await store.progress();
    db.run("INSERT INTO drill_attempts (id, ts, ending, level, result) VALUES ('b', 20, 'KQK', 1, 'solved')");
    db.run("INSERT INTO drill_attempts (id, ts, ending, level, result) VALUES ('a', 10, 'KQK', 1, 'solved')");
    db.run("INSERT INTO drill_attempts (id, ts, ending, level, result) VALUES ('c', 20, 'KQK', 1, 'budget')");
    assert.deepEqual(D.attempts(db, 'KQK').map(r => r.id), ['a', 'b', 'c']);
  });
});

const COLS5 = DRILL_ATTEMPTS_SCHEMA.map(([n, t]) => (n === 'seq' ? 'seq INTEGER PRIMARY KEY AUTOINCREMENT' : `"${n}" ${t}`));
const DDL5 = `CREATE TABLE IF NOT EXISTS drill_attempts (\n  ${COLS5.join(',\n  ')}\n);
CREATE INDEX IF NOT EXISTS drill_attempts_ending ON drill_attempts (ending);
CREATE INDEX IF NOT EXISTS drill_attempts_id ON drill_attempts (id);`;
const schema5 = raw => {
  raw.exec(PROGRESS_DDL);
  raw.exec('ALTER TABLE puzzle_solved ADD COLUMN "clean" BOOLEAN');
  raw.exec(DDL5);
  raw.exec(`PRAGMA user_version = 5; INSERT INTO drill_attempts (id, ts, ending, level, fen, dtm, budget, moves_used, result, ms, worst_loss)
    VALUES ('old', 5, 'KQK', 2, '${KQK}', 6, 12, 9, 'solved', 41000, 1)`);
};

test('db: a schema 5 database with drill rows gets the clock columns, the same schema as a new one, on both drivers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-drills-'));
  const fresh = mkdtempSync(join(tmpdir(), 'blundr-drills-'));
  try {
    const raw = await nodeSqlite(dir).open('progress.sqlite');
    schema5(raw);
    raw.close();
    const old = new Store(nodeSqlite(dir)), blank = new Store(nodeSqlite(fresh));
    try {
      const db = await old.progress(), ref = await blank.progress();
      assert.equal(db.value('PRAGMA user_version'), 6);
      assert.deepEqual(master(db), master(ref));
      assert.deepEqual(db.all("SELECT name FROM pragma_table_info('drill_attempts')").map(r => r.name), DRILL_ROW.map(c => c[0]));
      const [row] = D.attempts(db);
      assert.deepEqual([row.id, row.level, row.clock, row.move_ms, row.paused], ['old', 2, null, null, null]);
    } finally {
      await old.close();
      await blank.close();
    }
    const wasm = readFileSync(new URL('../vendor/sqlite-wasm/sqlite3.wasm', import.meta.url));
    const driver = await webSqlite({ memory: true, root: 'drills-schema-5', wasmBinary: wasm });
    const wraw = await driver.open('progress.sqlite');
    schema5(wraw);
    const web = new Store(driver), node = new Store(nodeSqlite(fresh));
    try {
      const wdb = await web.progress();
      wraw.close();     // only now: a memdb database goes with its last connection
      assert.equal(wdb.value('PRAGMA user_version'), 6);
      assert.deepEqual(master(wdb), master(await node.progress()));
      assert.deepEqual(D.attempts(wdb).map(r => r.id), ['old']);
      D.record(wdb, D.parseAttempt(KQK10), 9, () => 'w6');
      assert.deepEqual(D.attempts(wdb).at(-1).move_ms, [1000, 2000, 3000]);
    } finally {
      await web.close();
      await node.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

const TIMED = 'drill_timed.jsonl';
const syncDevice = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-drills-clock-'));
  const store = new Store(nodeSqlite(dir)), files = memoryFiles();
  return { store, files, sync: new Sync({ files, store }), done: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); } };
};
const TIMED_LINE = '{"id": "t1", "ts": 6, "ending": "KQK", "level": 6, "fen": "8/8/8/8/8/2k5/8/K6Q w - - 0 1", "dtm": 10, "budget": 11, ' +
  '"moves_used": 3, "result": "solved", "ms": 10000, "worst_loss": 0, "clock": {"tier": 1, "base_ms": 44000, "inc_ms": 1000}, ' +
  '"move_ms": [1000, 2000, 3000], "paused": 0}';

test('sync: untimed rows keep their exact line in drill_attempts.jsonl, timed ones go in drill_timed.jsonl', async () => {
  assert.deepEqual(locate(TIMED), { db: 'progress.sqlite', table: 'drill_attempts', archive: null, dir: null, keys: 'drill_timed',
    where: 'clock IS NOT NULL' });
  const A = await syncDevice();
  try {
    const db = await A.store.progress();
    D.record(db, D.parseAttempt({ ...good, id: 'a1' }), 5);
    D.record(db, D.parseAttempt({ ...KQK10, id: 't1' }), 6);
    const local = await A.sync.local();
    assert.deepEqual(Object.keys(local), [FILE, TIMED]);
    assert.deepEqual(local[FILE], [LINE], 'byte for byte the line of schema 5');
    assert.deepEqual(local[TIMED], [TIMED_LINE]);
    assert.deepEqual(await A.sync.libraryFiles(''), [FILE, TIMED]);
    // writing one file leaves the other's rows
    await A.sync.writeLines('', FILE, [LINE.replace('"a1"', '"a2"')]);
    assert.deepEqual(D.attempts(db).map(r => r.id).sort(), ['a2', 't1']);
    await A.sync.writeLines('', TIMED, []);
    assert.deepEqual(D.attempts(db).map(r => r.id), ['a2']);
    assert.deepEqual(await A.sync.libraryFiles(''), [FILE]);
    await A.sync.writeLines('', TIMED, local[TIMED]);
    assert.deepEqual(await A.sync.readLines('', TIMED), [TIMED_LINE]);
    await A.sync.deleteLines('', FILE);
    assert.deepEqual(D.attempts(db).map(r => r.id), ['t1']);
  } finally {
    await A.done();
  }
});

test('sync: both files go to another device, and the levels agree with the rows interleaved by ts', async () => {
  const A = await syncDevice(), B = await syncDevice();
  try {
    const db = await A.store.progress();
    let ts = 100, n = 0;
    const put = b => D.record(db, D.parseAttempt(b), ts++, () => `r${++n}`);
    // KQK up to the top (5), qualified there, then a timed solve, a 'time', a solve: Clock 1 with S F S
    for (let level = 1; level <= 5; level++) {
      const dtm = LEVELS.KQK[level - 1].lo;
      for (let k = 0; k < 3; k++) put({ ...good, level, dtm, budget: dtm + LEVELS.KQK[level - 1].slack });
    }
    put(KQK10);
    put({ ...KQK10, result: 'time', moves_used: 2, move_ms: [20000, 20000, 6000], ms: 47000 });
    put(KQK10);
    const want = D.status(db, 'KQK');
    assert.deepEqual([want.level, want.tier, want.run], [6, 1, [true, false, true]]);
    const local = await A.sync.local();
    assert.deepEqual([local[FILE].length, local[TIMED].length], [15, 3]);
    // B takes the timed file first: its seqs then run the other way round from the ts order
    await B.sync.writeLines('', TIMED, local[TIMED]);
    await B.sync.writeLines('', FILE, local[FILE]);
    const bdb = await B.store.progress();
    const got = D.status(bdb, 'KQK');
    assert.deepEqual([got.level, got.tier, got.run, got.played], [want.level, want.tier, want.run, want.played]);
    assert.deepEqual(await B.sync.local(), local);
  } finally {
    await A.done();
    await B.done();
  }
});

test('sync: an older app never sees drill_timed.jsonl, and a merge without it removes nothing of it', async () => {
  const t = '{"id": "t", "ts": 2}', u = '{"id": "u", "ts": 1}';
  // the account has both files; an older app's base and its own lines have only drill_attempts.jsonl (the Worker hid
  // the other): what it sends back removes nothing, and the timed lines stay on the account
  const [add, remove] = diff({ [FILE]: [u] }, { [FILE]: [u] });
  assert.deepEqual([add, remove], [{}, {}]);
  assert.deepEqual(merge({ [FILE]: [u] }, { [FILE]: [u] }, { [FILE]: [u], [TIMED]: [t] }), { [FILE]: [u], [TIMED]: [t] });
  // this version, its first sync after the update (a base without the timed file): its timed rows go up, nothing goes
  const A = await syncDevice();
  try {
    const db = await A.store.progress();
    D.record(db, D.parseAttempt({ ...good, id: 'a1' }), 5);
    D.record(db, D.parseAttempt({ ...KQK10, id: 't1' }), 6);
    await A.files.writeText('account_sync.json', JSON.stringify({ user: 'u1', files: { [FILE]: [LINE] } }));
    const delta = await A.sync.delta('u1');
    assert.deepEqual([delta.add, delta.remove], [{ [TIMED]: [TIMED_LINE] }, {}]);
  } finally {
    await A.done();
  }
});

test('sync: the downgrade guard drops a stripped timed row from drill_attempts.jsonl, and the next delta removes it', async () => {
  const A = await syncDevice();
  try {
    const db = await A.store.progress();
    D.record(db, D.parseAttempt({ ...KQK10, id: 't1' }), 6);
    // what an older app sends after a downgrade: the timed rows without their clock, in drill_attempts.jsonl
    const stripped = rowLine('drill_attempts', { ...JSON.parse(TIMED_LINE), clock: null });
    const time = stripped.replace('"solved"', '"time"').replace('"level": 6', '"level": 2').replace('"t1"', '"t2"');
    const unknown = '{"id": "x", "ts": 3, "ending": "KQKR", "level": 9, "result": "solved", "ms": 1}';
    await A.sync.writeLines('', FILE, [LINE, stripped, time, unknown]);
    assert.deepEqual(await A.sync.readLines('', FILE), [LINE, unknown], 'an ending this version does not know is kept');
    await A.files.writeText('account_sync.json', JSON.stringify({ user: 'u1', files: { [FILE]: [LINE, stripped, time, unknown], [TIMED]: [TIMED_LINE] } }));
    const delta = await A.sync.delta('u1');
    assert.deepEqual([delta.add, delta.remove], [{}, { [FILE]: [stripped, time] }]);
    // the timed row itself is still there, and the level is the one it gives
    assert.deepEqual(D.attempts(db).map(r => r.id).sort(), ['a1', 't1', 'x']);
    assert.deepEqual([D.status(db, 'KQK').played, D.status(db, 'KQK').level], [2, 1]);
  } finally {
    await A.done();
  }
});

test('sync: after a downgrade wrote every row back stripped, the timed rows count again and the copies go, here and on the account', async () => {
  const A = await syncDevice();
  try {
    const db = await A.store.progress();
    let ts = 100, n = 0;
    const put = b => D.record(db, D.parseAttempt(b), ts++, () => `r${++n}`);
    for (let level = 1; level <= 5; level++) {
      const dtm = LEVELS.KQK[level - 1].lo;
      for (let k = 0; k < 3; k++) put({ ...good, level, dtm, budget: dtm + LEVELS.KQK[level - 1].slack });
    }
    for (let k = 0; k < 3; k++) put(KQK10);
    const want = D.status(db, 'KQK');
    assert.deepEqual([want.level, want.played], [7, 18]);
    const timed = (await A.sync.local())[TIMED];
    // an older app syncs this folder: it reads every row with its own keys and writes the table back (DELETE, insert),
    // and its base keeps the stripped lines
    const stripped = tidy(FILE, D.attempts(db).map(r => rowLine('drill_attempts', r)));
    db.run('DELETE FROM drill_attempts');
    db.insert('drill_attempts', DRILL_ATTEMPTS_SCHEMA, stripped.map(l => JSON.parse(l)));
    await A.files.writeText('account_sync.json', JSON.stringify({ user: 'u1', files: { [FILE]: stripped } }));
    // back on this version: the account has the timed file as well
    await A.sync.commit('u1', { [FILE]: stripped, [TIMED]: timed });
    const st = D.status(db, 'KQK');
    assert.deepEqual([st.level, st.tier, st.played], [want.level, want.tier, want.played], 'the timed rows count, once each');
    assert.equal(db.value('SELECT count(*) FROM drill_attempts WHERE level > 5 AND clock IS NULL'), 0, 'no stripped row left here');
    // the next delta takes the copies off the account, and once that is answered nothing is pending
    const delta = await A.sync.delta('u1');
    assert.deepEqual([Object.keys(delta.add), delta.remove[FILE]], [[], stripped.filter(l => JSON.parse(l).level > 5)]);
    const after = { [FILE]: stripped.filter(l => JSON.parse(l).level <= 5), [TIMED]: timed };
    const done = await A.sync.commit('u1', after);
    assert.equal(done.pending, false);
    assert.deepEqual(await A.sync.delta('u1'), { add: {}, remove: {} });
  } finally {
    await A.done();
  }
});
