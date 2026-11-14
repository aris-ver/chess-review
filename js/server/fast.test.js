// A fast analysis (FAST_NODES, the evals_fast marks): the cache's rules (a full search replaces a fast one, a fast one
// never replaces anything), the routes (?mode=, the saved default, /api/engine), the review's flag and fingerprint,
// and the schema's step from 3 to 4.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { setBook } from '../core/book.js';
import { boardFromFen, legalMoves, uci } from '../core/chess.js';
import { fenKey } from '../core/fen.js';
import { nodeSqlite } from './db-node.js';
import { EVALS, EVALS_DDL, SCHEMA_VERSION, Store, writeGames } from './db.js';
import { fastGames, isFastGame, pendingKeys, writeResults } from './eval-cache.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';
import { serve } from './router.js';
import { saveSettings } from './settings.js';

const PGN = readFileSync(new URL('../../tests/fixtures/clocks.pgn', import.meta.url), 'utf8').split('\n\n[Event')[0];
const NODES = 1000, FAST = 500;
const dec = new TextDecoder();

/** An engine that answers any position with its first legal move, its score saying the nodes it searched at; every
 * search is logged as [fen key, nodes]. */
function fakePool(searched) {
  return {
    size: 2, name: 'fake', async load() {},
    async search(fen, nodes, multipv = 3) {
      searched.push([fenKey(fen), nodes]);
      const moves = legalMoves(boardFromFen(fen)).slice(0, multipv);
      return moves.map((m, i) => `info depth 10 seldepth 10 multipv ${i + 1} score cp ${nodes === FAST ? 11 - i : 22 - i} nodes ${nodes} pv ${uci(m)}`);
    },
  };
}

async function withRouter(fn, { fastNodes = FAST } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-fast-'));
  setBook([]);
  const store = new Store(nodeSqlite(dir)), files = memoryFiles(), searched = [];
  try {
    const router = await serve({ env: { store, files, profiles: new Profiles(files, store) }, pool: fakePool(searched),
      nodes: NODES, fastNodes, scan: false });
    const call = async (method, path, body = '') => {
      const out = await router.handle(method, path, typeof body === 'string' ? body : JSON.stringify(body));
      return { status: out.status, json: JSON.parse(typeof out.body === 'string' ? out.body : dec.decode(out.body)) };
    };
    await fn({ router, call, searched, store, files });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const P = 'pgn-pasted-games';

async function paste(call, pgn = PGN) {
  const r = await call('POST', '/api/pgn', { pgn });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.games[0];
}

async function reviewOf(call, slug) {
  return (await call('GET', `/p/${P}/games/${slug}.json`)).json;
}

test('fast: ?mode=fast searches at the fast nodes, marks them, and says so; ?mode=full then searches them all again', async () => {
  await withRouter(async ({ router, call, searched, store }) => {
    const engine = (await call('GET', '/api/engine')).json;
    assert.equal(engine.fast_nodes, FAST);
    assert.equal(engine.nodes, NODES);
    const slug = await paste(call);
    const start = await call('POST', `/api/p/${P}/analyse/${slug}?mode=fast`);
    assert.equal(start.json.job.fast, true);
    await router.runner.idle();
    assert.ok(searched.length > 10);
    assert.deepEqual(new Set(searched.map(([, n]) => n)), new Set([FAST]));
    const db = await store.profile(P);
    const gid = db.value('SELECT game_id FROM games');
    assert.ok(isFastGame(db, gid));
    assert.deepEqual([...fastGames(db)], [gid]);
    assert.equal(db.value('SELECT count(*) FROM evals_fast'), new Set(searched.map(([k]) => k)).size);
    const fast = await reviewOf(call, slug);
    assert.equal(fast.fast, true);
    assert.equal(fast.analysed, 1);
    assert.equal((await call('GET', '/api/status')).json.recent.at(-1).fast, true);
    // fast pending: nothing; full pending: every marked position
    assert.deepEqual(pendingKeys(db, gid, { full: false })[0], []);
    assert.equal(pendingKeys(db, gid)[0].length, db.value('SELECT count(*) FROM evals_fast'));

    const fastKeys = new Set(searched.map(([k]) => k));
    searched.length = 0;
    const full = await call('POST', `/api/p/${P}/analyse/${slug}?mode=full`);
    assert.equal(full.json.job.fast, undefined);
    await router.runner.idle();
    assert.deepEqual(new Set(searched.map(([k]) => k)), fastKeys, 'every marked position searched again');
    assert.deepEqual(new Set(searched.map(([, n]) => n)), new Set([NODES]));
    assert.equal(db.value('SELECT count(*) FROM evals_fast'), 0);
    assert.equal(db.value('SELECT count(*) FROM evals WHERE nodes = ?', [FAST]), 0);
    assert.ok(!isFastGame(db, gid));
    const after = await reviewOf(call, slug);
    assert.equal(after.fast, undefined);
    assert.notEqual(after.fp, fast.fp);
    assert.notDeepEqual(after.moves.map(m => m.eval), fast.moves.map(m => m.eval), 'the review rebuilt from the full evals');
    // the moves table (labels, accuracy) follows
    const evals = db.column('SELECT DISTINCT e.nodes FROM positions p JOIN evals e USING (fen_key)');
    assert.deepEqual(evals.filter(n => n !== 0), [NODES]);
  });
});

test('fast: without a mode, the saved default; analyse_all leaves fast games be and follows the default', async () => {
  await withRouter(async ({ router, call, searched, store, files }) => {
    const slug = await paste(call);
    let start = await call('POST', `/api/p/${P}/analyse/${slug}`);
    assert.equal(start.json.job.fast, undefined, 'decided when it runs');
    await router.runner.idle();
    assert.deepEqual(new Set(searched.map(([, n]) => n)), new Set([NODES]), 'no default saved: full');

    // the default says fast: a new game pasted is analysed fast without a mode
    await saveSettings(files, { analysis: 'fast' });
    // another game, its first moves the first one's
    const second = await paste(call, PGN.replace('live/1', 'live/2').replace(/\n\n1\. [^]*$/, '\n\n1. e4 e5 2. Nf3 d6 3. Bc4 h6 4. O-O a6 1-0'));
    assert.notEqual(second, slug);
    searched.length = 0;
    start = await call('POST', `/api/p/${P}/analyse/${second}`);
    await router.runner.idle();
    assert.equal((await call('GET', '/api/status')).json.recent.at(-1).fast, true);
    assert.ok(searched.length > 0);
    assert.ok(searched.every(([, n]) => n === FAST), 'positions the first game shares come from the cache');
    assert.equal((await reviewOf(call, second)).fast, true);
    assert.equal((await reviewOf(call, slug)).fast, undefined, 'the full game shares positions, keeps its rows');

    // analyse_all: both games are analysed (one fast): nothing to do
    searched.length = 0;
    await call('POST', `/api/p/${P}/analyse_all`);
    await router.runner.idle();
    assert.deepEqual(searched, []);
    const db = await store.profile(P);
    assert.equal(fastGames(db).size, 1);

    // the profile's site rebuilt (a third game pasted): the fast review keeps its flag and fingerprint, the full one
    // is as it was
    const [one, two] = [await reviewOf(call, slug), await reviewOf(call, second)];
    await paste(call, PGN.replace('live/1', 'live/3').replace(/\n\n1\. [^]*$/, '\n\n1. d4 d5 2. c4 e6 1-0'));
    const [one2, two2] = [await reviewOf(call, slug), await reviewOf(call, second)];
    assert.deepEqual(one2, one);
    assert.deepEqual(two2, two);
    assert.equal(two2.fast, true);
    assert.ok(!('fast' in one2));
  });
});

test('fast: without fast nodes (the phones) a fast request is a full one and /api/engine offers none', async () => {
  await withRouter(async ({ router, call, searched, files }) => {
    assert.equal((await call('GET', '/api/engine')).json.fast_nodes, undefined);
    await saveSettings(files, { analysis: 'fast' });
    const slug = await paste(call);
    const start = await call('POST', `/api/p/${P}/analyse/${slug}?mode=fast`);
    assert.equal(start.json.job.fast, undefined);
    await router.runner.idle();
    assert.deepEqual(new Set(searched.map(([, n]) => n)), new Set([NODES]));
    assert.equal((await reviewOf(call, slug)).fast, undefined);
  }, { fastNodes: null });
});

const row = (k, cp, nodes) => [k, { nodes, eval_cp: cp, mate_in: null, best_move: 'e2e4', pv: ['e2e4'] },
  [{ rank: 1, move: 'e2e4', eval_cp: cp, mate_in: null, pv: ['e2e4'] }]];

test('fast: the cache: a full search replaces a fast one and its mark, a fast one never replaces a full one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-fast-'));
  const store = new Store(nodeSqlite(dir));
  try {
    const db = await store.profile('x');
    const FENS = ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'];
    const [a, b, c] = FENS.map(fenKey);
    writeGames(db, [{ game_id: 'g1' }, { game_id: 'g2' }],
      [...FENS.map((fen, ply) => ({ game_id: 'g1', ply, fen })), { game_id: 'g2', ply: 0, fen: FENS[0] }]);
    writeResults(db, [row(a, 30, NODES)]);
    // a fast search of a, which the cache has in full (written meanwhile), and of b
    writeResults(db, [row(a, 10, FAST), row(b, 10, FAST)], { fast: true });
    assert.equal(db.value('SELECT eval_cp FROM evals WHERE fen_key = ?', [a]), 30, 'the full row kept');
    assert.deepEqual(db.column('SELECT fen_key FROM evals_fast'), [b], 'and left unmarked');
    assert.deepEqual(pendingKeys(db, 'g1', { full: false })[0], [c]);
    assert.deepEqual(pendingKeys(db, 'g1')[0], [b, c]);
    assert.deepEqual(pendingKeys(db, 'g2')[0], []);
    assert.deepEqual([...fastGames(db)], ['g1']);
    assert.ok(isFastGame(db, 'g1') && !isFastGame(db, 'g2'));
    // a full search of b that the engine failed every try (no eval) keeps the fast rows and mark
    writeResults(db, [[b, { nodes: 0, eval_cp: null, mate_in: null, best_move: null, pv: [] }, []]]);
    assert.equal(db.value('SELECT eval_cp FROM evals WHERE fen_key = ?', [b]), 10);
    assert.deepEqual(db.column('SELECT rank FROM evals_multipv WHERE fen_key = ?', [b]), [1]);
    assert.deepEqual(db.column('SELECT fen_key FROM evals_fast'), [b]);
    // a full search of b replaces its rows and mark
    writeResults(db, [row(b, 40, NODES), row(c, 50, NODES)]);
    assert.equal(db.value('SELECT eval_cp FROM evals WHERE fen_key = ?', [b]), 40);
    assert.equal(db.value('SELECT eval_cp FROM evals_multipv WHERE fen_key = ? AND rank = 1', [b]), 40);
    assert.equal(db.value('SELECT count(*) FROM evals_fast'), 0);
    assert.deepEqual(pendingKeys(db, 'g1')[0], []);
    assert.equal(fastGames(db).size, 0);
    // a fast search never replaces: b stays full
    writeResults(db, [row(b, 10, FAST)], { fast: true });
    assert.equal(db.value('SELECT eval_cp FROM evals WHERE fen_key = ?', [b]), 40);
    assert.equal(db.value('SELECT count(*) FROM evals_fast'), 0);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fast: an evals.sqlite at schema 3 opens at 4 with evals_fast, the other tables as they were', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-fast-'));
  const fresh = mkdtempSync(join(tmpdir(), 'blundr-fast-'));
  try {
    const raw = await nodeSqlite(dir).open(EVALS);
    // schema 3's evals.sqlite: today's DDL without evals_fast
    raw.exec(EVALS_DDL.split(/\n(?=CREATE TABLE)/).filter(s => !s.includes('evals_fast')).join('\n'));
    raw.exec("INSERT INTO evals (fen_key, nodes, eval_cp) VALUES ('k', 1, 5); PRAGMA user_version = 3");
    raw.close();
    const master = db => db.all("SELECT type, name, sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
    const store = new Store(nodeSqlite(dir)), blank = new Store(nodeSqlite(fresh));
    try {
      const db = await store.evals();
      assert.equal(SCHEMA_VERSION, 4);
      assert.equal(db.value('PRAGMA user_version'), 4);
      assert.deepEqual(master(db), master(await blank.evals()));
      assert.deepEqual(master(db).map(r => r.name), ['evals', 'evals_fast', 'evals_multipv']);
      assert.equal(db.value('SELECT eval_cp FROM evals'), 5);
      // a profile database has no evals of its own: no evals_fast either
      const p = await store.profile('x');
      assert.equal(p.value("SELECT count(*) FROM main.sqlite_master WHERE name = 'evals_fast'"), 0);
      assert.equal(p.value('SELECT count(*) FROM evals_fast'), 0, 'answers unqualified through the attached cache');
    } finally {
      await store.close();
      await blank.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});
