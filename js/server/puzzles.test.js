// Puzzles, packs and own puzzles against Python (tests/parity/puzzles.json, scripts/dump_puzzles_parity.py): the
// recorded runs of attempts, resets and daily showings are replayed into SQLite and every answer compared.
process.env.TZ = 'UTC';     // the archive's name is local time, and the dump ran in UTC

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { load, PARITY, same } from '../parity.js';
import { writeResults } from './eval-cache.js';
import { nodeSqlite } from './db-node.js';
import { EVALS_MULTIPV_SCHEMA, EVALS_SCHEMA, MOVES_SCHEMA, Store, writeGames } from './db.js';
import * as O from './own-puzzles.js';
import * as K from './packs.js';
import * as P from './puzzles.js';

const dump = load('puzzles.json');
const FIRST = () => 0, LAST = () => 0.9999999999;
const PACKS_JSON = new URL('../../chess_review/puzzle_packs/packs.json', import.meta.url);

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-puzzles-'));
  const store = new Store(nodeSqlite(dir));
  try {
    return await fn(store);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const sorted = xs => [...xs].sort();

test('puzzles: lines, themes and the rating as Python', async () => {
  const lib = dump.library;
  const pack = new P.Pack(() => lib.rows);
  same(pack.rows().map(P.line), lib.lines, 'lines');
  same(pack.themes(), lib.themes, 'themes');
  same(Object.fromEntries(Object.keys(lib.theme_names).map(t => [t, P.themeName(t)])), lib.theme_names, 'theme_names');
  for (const [r, rd, opp, s, out] of lib.glicko) same(P.glicko(r, rd, opp, s), out, `glicko(${r}, ${rd}, ${opp}, ${s})`);

  await withStore(async store => {
    const db = await store.progress();
    for (const [i, s] of lib.steps.entries()) {
      if (s.op === 'record') same(P.record(db, s.id, s.rating, s.solved, s.ms, s.hinted, s.now), s.out, `steps[${i}] record`);
      else same([P.reset(db, s.now), P.stats(P.attempts(db))], [s.out, s.stats], `steps[${i}] reset`);
    }
    same(P.attempts(db), lib.attempts, 'attempts');
    same(P.stats(P.attempts(db)), lib.stats, 'stats');
    same(sorted(P.tried(db)), lib.tried, 'tried');
    for (const [i, c] of lib.picks.entries()) {
      const p = P.pick(pack.rows(), c.rating, c.themes && new Set(c.themes), new Set(c.exclude), c.last ? LAST : FIRST);
      same(p?.id ?? null, c.id, `picks[${i}]`);
    }
    for (const [i, c] of lib.next.entries()) {
      same(P.nextPuzzle(db, pack, c.themes && new Set(c.themes), c.skip, FIRST), c.out, `next[${i}]`);
    }
  });
});

test('packs: progress, ladders and the shelf as Python', async () => {
  const pk = dump.packs;
  const packs = new K.Packs(() => JSON.parse(readFileSync(PACKS_JSON, 'utf8')));
  const get = id => pk.rows[id] ?? null;
  await withStore(async store => {
    const db = await store.progress();
    const archived = [];
    for (const op of pk.ops) {
      if (op[0] === 'record') P.record(db, op[1], op[2], op[3], null, op[4], op[5]);
      else if (op[0] === 'reset') archived.push(P.reset(db, op[1]));
      else K.markSolved(db, op[1], op[2]);
    }
    same(sorted(archived.map(n => n.replace('puzzle_attempts.', 'pk_attempts.'))), pk.archives, 'archives');
    const first = K.firstTries(db), later = K.solvedLater(db);
    same([...first], pk.first, 'first_tries');
    same(sorted(later), pk.later, 'solved_later');
    for (const [i, st] of pk.stats.entries()) same(K.shelf(packs, st, db, get), pk.shelf[i], `shelf[${i}]`);
    for (const [i, c] of pk.ladders.entries()) {
      const p = packs.get(c.pack);
      const ratings = Object.fromEntries(p.stages.flatMap(s => s.ids).map(id => [id, pk.rows[id]?.rating ?? null]));
      same(K.credit(p, first, later, get), c.credit, `ladders[${i}].credit`);
      same(K.ladder(p, first, later, pk.stats[i % 2], ratings, c.credit), c.out, `ladders[${i}] ${c.pack}`);
    }
  });
  for (const [id, out] of Object.entries(pk.where)) same(K.where(packs, id), out, `where(${id})`);
});

test('packs: the puzzle of the day and the streak as Python', async () => {
  const pk = dump.packs;
  const packs = new K.Packs(() => JSON.parse(readFileSync(PACKS_JSON, 'utf8')));
  for (const [day, n, id] of pk.daily_ids) same([K.dayNumber(day), K.dailyId(packs, day)], [n, id], `daily ${day}`);
  await withStore(async store => {
    const db = await store.progress();
    for (const [i, s] of pk.daily_run.entries()) {
      same(K.recordDaily(packs, db, s.day, s.id, s.solved, s.clean, s.ms, s.marks), s.out, `daily_run[${i}] ${s.day}`);
    }
    for (const [day, out] of pk.streaks) same(K.streaks(K.dailyRecord(db), day), out, `streaks(${day})`);
  });
  same(new K.Packs(() => { throw new Error('missing'); }).data(), { packs: [], daily: [] }, 'no packs.json');
});

/** A profile's games, positions, moves and cache rows into a fresh database, then everything the dump has on its own
 * puzzles: the candidates, the pool, the lines extended by the dump's made-up engine, the pool again, the schedule. */
async function ownCase(store, c, inputs) {
  const profile = { id: c.name };
  const db = await store.profile(profile);
  writeGames(db, inputs.games, inputs.positions);
  db.insert('moves', MOVES_SCHEMA, inputs.moves);
  db.insert('evals', EVALS_SCHEMA, inputs.evals);
  db.insert('evals_multipv', EVALS_MULTIPV_SCHEMA, inputs.multipv);
  if (inputs.results?.length) writeResults(db, inputs.results);

  same(db.all(O.CANDIDATES_SQL), c.candidates, `${c.name}.candidates`);
  const pool = new O.Pool(store);
  same(await pool.puzzles(profile), c.before, `${c.name}.before`);
  same(await pool.waiting(profile), c.waiting_before, `${c.name}.waiting_before`);

  const rounds = [], progress = [];
  const search = async keys => {
    rounds.push(keys);
    writeResults(db, keys.map(k => [k, ...c.engine[k]]));
    pool.invalidate(profile.id);
  };
  same(await O.extend(db, search, () => false, (d, t) => progress.push([d, t])), c.extend, `${c.name}.extend`);
  same(rounds, c.rounds, `${c.name}.rounds`);
  same(progress, c.progress, `${c.name}.progress`);
  pool.invalidate(profile.id);
  same(await pool.puzzles(profile), c.after, `${c.name}.after`);
  same(await pool.waiting(profile), c.waiting_after, `${c.name}.waiting_after`);
  same(await pool.find(c.after[0]?.id ?? 'mnope', [{ id: 'nobody' }, profile]), c.after[0] ?? null, `${c.name} find`);

  const rv = c.review;
  for (const [i, s] of rv.steps.entries()) {
    if (s.op === 'record') same(await O.record(pool, profile, s.id, s.solved, s.ms, s.hinted, s.now), s.out, `${c.name}.review[${i}]`);
    else same(await O.reset(pool, profile, s.now), s.out, `${c.name}.review[${i}] reset`);
  }
  same(O.attempts(db), rv.attempts, `${c.name}.review.attempts`);
  const sched = O.schedule(O.attempts(db));
  same(Object.fromEntries(sched), rv.schedule, `${c.name}.review.schedule`);
  for (const [i, k] of rv.checks.entries()) {
    same(O.pick(c.after, sched, k.skip, k.now, k.last ? LAST : FIRST)?.id ?? null, k.id, `${c.name}.checks[${i}].id`);
    same(O.stats(c.after, sched, k.now), k.stats, `${c.name}.checks[${i}].stats`);
  }
  same((await O.nextPuzzle(pool, profile, null, rv.checks[0].now, FIRST))[1], rv.checks[0].stats, `${c.name} next_puzzle`);
  same(await O.summary(pool, profile, rv.checks[0].now), rv.checks[0].stats, `${c.name} summary`);
}

test('own puzzles: the fixtures as Python', async () => {
  const storage = Object.fromEntries(load('storage.json').map(s => [s.name, s]));
  for (const c of dump.own) {
    const s = storage[c.name];
    await withStore(store => ownCase(store, c, { ...s, evals: s.cache.evals, multipv: s.cache.multipv }));
  }
});

test('own puzzles: ids, slugs and the follow line', () => {
  const pid = O.puzzleId('https://www.chess.com/game/live/1', 42);
  same([O.isOwnId(pid), O.isOwnId('00sHx'), pid.length], [true, false, 11]);
  same(O.slug('https://www.chess.com/game/live/123456/'), '123456');
  same(O.follow('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', ['e2e4', 'e7e5', 'zz', 'g1f3']).map(m => m.san), ['e5']);
});

const localDir = PARITY + 'local/';
const locals = existsSync(localDir) ? readdirSync(localDir).filter(f => /^puzzles-.*\.json$/.test(f) && f !== 'puzzles-records.json').sort() : [];

test('own puzzles: your profiles, as in Python', { skip: !locals.length && 'no tests/parity/local puzzles dump' }, async () => {
  for (const f of locals) {
    const c = JSON.parse(readFileSync(localDir + f, 'utf8'));
    await withStore(store => ownCase(store, c, c));
    const r = c.real_review;
    const sched = O.schedule(r.attempts);
    same(Object.fromEntries(sched), r.schedule, `${c.name}.real_review.schedule`);
    same(O.stats(c.before, sched, r.now), r.stats, `${c.name}.real_review.stats`);
  }
});

test('puzzles: your records, as in Python', { skip: !existsSync(localDir + 'puzzles-records.json') && 'no tests/parity/local puzzles dump' }, () => {
  const c = JSON.parse(readFileSync(localDir + 'puzzles-records.json', 'utf8'));
  same(P.stats(c.attempts), c.stats, 'stats');
  for (const [day, out] of c.streaks) same(K.streaks(c.daily, day), out, `streaks(${day})`);
});
