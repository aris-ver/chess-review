// The drill routes through the router (as routes-puzzles.test.js builds it), over the 3-piece tables made here and
// fakes for the rest: the deal, recording an attempt, the standing, and every refusal.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setBook } from '../core/book.js';
import { boardFromFen, fen as fenOf, legalMoves, parseUci, push, san, uci as uciOf } from '../core/chess.js';
import { LEVELS } from '../core/drills.js';
import { generate, tableSize } from '../core/endgame-table.js';
import { ROOK_TABLES, mirrorFen, rookStart, rookStatus } from '../core/rook-drills.js';
import { ROOK_STARTS } from '../core/rook-starts.js';
import { EnginePool } from '../desktop/engines.js';
import { bestOf } from './drill-opponent.js';
import { nodeSqlite } from './db-node.js';
import { Store } from './db.js';
import * as D from './drills.js';
import { DrillTables, tablesFromFiles } from './drills.js';
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

/** A router over a data folder of its own; `load` is what the DrillTables reads (undefined: none given at all), `extra`
 * more of the env (the rook drills' engine). */
async function withRouter(load, fn, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-routes-drills-'));
  setBook([]);
  const store = new Store(nodeSqlite(dir)), files = memoryFiles();
  const env = { store, files, profiles: new Profiles(files, store), rng: rng(3) };
  if (load) env.drillTables = new DrillTables(load);
  const { analysisPool = pool, ...more } = extra;     // analysisPool: the router's own (the hint searches on it)
  Object.assign(env, more);
  try {
    const router = await serve({ env, pool: analysisPool, nodes: 1, scan: false });
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
      [['KQRK', 1], ['KRRK', 1], ['KQK', 1], ['KRK', 2], ['KPK', 1], ['KPK-hold', 1], ['KBBK', 1], ['KBNK', 1], ['Lucena', 1], ['Philidor', 1]]);
    assert.deepEqual(all.body.endings.map(e => e.unavailable), [...Array(8).fill(null), 'no_engine', 'no_engine']);
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
    await err('GET', '/api/drills/next?ending=KNNK', undefined, 400, /ending/);
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

// ---------- playing: the move and line routes ----------

const after = (f, uci) => {
  const b = boardFromFen(f);
  push(b, parseUci(b, uci));
  return fenOf(b);
};
const movesFrom = f => legalMoves(boardFromFen(f)).map(m => uciOf(m));

/** Plays a drill through the move route: pick(fen, fens) gives the user's move; returns the answers in order. */
async function playDrill(ask, drill, pick, max = 80) {
  const fens = [drill.fen], answers = [];
  for (let i = 0; i < max; i++) {
    fens.push(after(fens[fens.length - 1], await pick(fens[fens.length - 1], fens)));
    const r = await ask('POST', '/api/drills/move', { ending: drill.ending, level: drill.level, fens });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    answers.push(r.body);
    if (r.body.result) return { answers, fens };
    fens.push(r.body.fen);
  }
  throw new Error(`${drill.ending}: no result in ${max} moves`);
}

test('move: a KQK drill played to mate along the line route, reviewed, then recorded', async () => {
  await withRouter(real, async ask => {
    const { drill } = (await ask('GET', '/api/drills/next?ending=KQK')).body;
    const best = async f => (await ask('POST', '/api/drills/line', { ending: 'KQK', fen: f })).body.line[0];
    const { answers } = await playDrill(ask, drill, best);
    const last = answers[answers.length - 1];
    assert.equal(answers.length, drill.dtm);
    assert.deepEqual(Object.keys(last), ['san', 'fen_move', 'kind', 'loss', 'dtm_after', 'reply', 'reply_san', 'fen', 'dtm',
      'moves_used', 'budget', 'result', 'review', 'worst_loss']);
    assert.equal(last.result, 'solved');
    assert.equal(last.reply, null);
    assert.match(last.san, /#$/);
    assert.equal(last.dtm_after, 0);
    assert.equal(last.budget, drill.budget);
    assert.equal(last.moves_used, drill.dtm);
    assert.equal(last.worst_loss, -1);
    assert.deepEqual(last.review.moves.map(m => m.kind), Array(drill.dtm).fill('best'));
    assert.deepEqual(last.review.moves.map(m => m.dtm), [...Array(drill.dtm).keys()].reverse());
    // on the way: the reply, the mate distance after it, nothing over
    for (const a of answers.slice(0, -1)) {
      assert.equal(a.result, null);
      assert.equal(a.kind, 'best');
      assert.match(a.reply, /^[a-h][1-8][a-h][1-8]$/);
      assert.equal(a.dtm, a.dtm_after);
      assert.equal(a.review, null);
    }
    const r = await ask('POST', '/api/drills/attempt', { ...drill, moves_used: last.moves_used, result: last.result, ms: 9000,
      worst_loss: last.worst_loss, id: 'kqk-1' });
    assert.deepEqual([r.status, r.body.counted, r.body.status.solved], [200, true, 1]);
  });
});

test('move: a hung queen is lost, the review marks the throw; slack moves count', async () => {
  await withRouter(real, async ask => {
    const { drill } = (await ask('GET', '/api/drills/next?ending=KQK&level=2')).body;
    // a queen move the black king can take: the defender always takes it
    const fens = [drill.fen];
    const hang = movesFrom(drill.fen).find(u => {
      const f = after(drill.fen, u);
      return D.playMove(tables, D.parseMove(tables, { ending: 'KQK', level: 2, fens: [drill.fen, f] })).result === 'piece_lost';
    });
    assert.ok(hang, 'a move that hangs the queen');
    fens.push(after(drill.fen, hang));
    const r = await ask('POST', '/api/drills/move', { ending: 'KQK', level: 2, fens });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.kind, r.body.loss, r.body.dtm_after, r.body.result, r.body.worst_loss], ['threw', null, null, 'piece_lost', null]);
    assert.match(r.body.reply, /^[a-h][1-8][a-h][1-8]$/);
    assert.deepEqual(r.body.review, { moves: [{ dtm: null, kind: 'threw', loss: null }], worst: 0 });
    // a king move that isn't best: slack or lost, its loss counted against the best
    const slow = movesFrom(drill.fen).map(u => [u, D.playMove(tables, D.parseMove(tables, { ending: 'KQK', level: 2, fens: [drill.fen, after(drill.fen, u)] }))])
      .find(([, a]) => a.kind === 'slack' || a.kind === 'lost');
    assert.ok(slow);
    assert.equal(slow[1].loss, slow[1].dtm_after - (drill.dtm - 1));
    assert.ok(slow[1].loss >= 1);
  });
});

test('move: the budget runs out', async () => {
  await withRouter(real, async ask => {
    const { drill } = (await ask('GET', '/api/drills/next?ending=KQK&level=5')).body;
    // the slowest move that keeps everything (no stalemate, no lost queen, a position not seen yet), each time: the
    // budget runs out first
    const slowest = async (f, fens) => {
      const seen = new Set(fens.map(x => x.split(' ').slice(0, 2).join(' ')));
      const cand = movesFrom(f).map(u => {
        const next = [...fens, after(f, u)];
        return [u, D.playMove(tables, D.parseMove(tables, { ending: 'KQK', level: 5, fens: next })), seen.has(next[next.length - 1].split(' ').slice(0, 2).join(' '))];
      }).filter(([, a]) => a.kind !== 'threw' && !['stalemate', 'solved', 'repetition'].includes(a.result));
      cand.sort((a, b) => a[2] - b[2] || b[1].dtm_after - a[1].dtm_after);
      return cand[0][0];
    };
    const { answers } = await playDrill(ask, drill, slowest);
    const last = answers[answers.length - 1];
    assert.equal(last.result, 'budget');
    assert.equal(last.moves_used, drill.budget);
    assert.ok(last.worst_loss >= 1);
    assert.equal(last.review.moves.length, drill.budget);
    assert.ok(last.review.worst >= 0);
    assert.equal(last.review.moves[last.review.worst].loss, last.worst_loss);
  });
});

test('move: KPK attack and KPK defence, each to its end', async () => {
  await withRouter(real, async ask => {
    // the attack, along the table's line: promoted
    const { drill } = (await ask('GET', '/api/drills/next?ending=KPK')).body;
    const best = ending => async f => (await ask('POST', '/api/drills/line', { ending, fen: f })).body.line[0];
    let { answers } = await playDrill(ask, drill, best('KPK'));
    let last = answers[answers.length - 1];
    assert.equal(last.result, 'promoted');
    assert.deepEqual([last.budget, last.dtm_after, last.worst_loss], [null, null, -1]);
    // a move that gives the win away ends it at once, no reply
    const threw = movesFrom(drill.fen).map(u => D.playMove(tables, D.parseMove(tables, { ending: 'KPK', level: drill.level,
      fens: [drill.fen, after(drill.fen, u)] }))).find(a => a.result === 'threw');
    if (threw) {
      assert.deepEqual([threw.result, threw.reply, threw.worst_loss], ['threw', null, null]);
      assert.equal(threw.review.moves[0].kind, 'threw');
    }
    // the defence, along the holding line: held, or the pawn taken, or a stalemate
    const hold = (await ask('GET', '/api/drills/next?ending=KPK-hold')).body.drill;
    ({ answers } = await playDrill(ask, hold, best('KPK-hold'), 25));
    last = answers[answers.length - 1];
    assert.ok(['held', 'pawn_taken', 'stalemate'].includes(last.result), last.result);
    assert.ok(last.review.moves.every(m => m.kind === 'best' && m.dtm === null));
    assert.equal(last.worst_loss, -1);
    for (const a of answers.slice(0, -1)) assert.match(a.reply, /^[a-h][1-8][a-h][1-8][qr]?$/);
    // a king move that lets the pawn through, somewhere along the holding line: threw, the attempt over
    const line = [hold.fen, ...(await ask('POST', '/api/drills/line', { ending: 'KPK-hold', fen: hold.fen })).body.moves.map(m => m.fen)];
    let lose = null, at = -1;
    for (let k = 0; k < line.length && !lose; k += 2) {
      lose = movesFrom(line[k]).map(u => D.playMove(tables, D.parseMove(tables, { ending: 'KPK-hold', level: hold.level,
        fens: [...line.slice(0, k + 1), after(line[k], u)] }))).find(a => a.kind === 'threw') ?? null;
      at = k / 2;
    }
    assert.ok(lose, 'a losing move along a level 1 defence');
    assert.deepEqual([lose.result, lose.reply, lose.worst_loss, lose.review.worst], ['threw', null, null, at]);
    assert.ok(lose.review.moves.slice(0, at).every(m => m.kind === 'best'));
  });
});

test('move and line: refusals', async () => {
  await withRouter(real, async ask => {
    const { drill } = (await ask('GET', '/api/drills/next?ending=KQK')).body;
    const m1 = movesFrom(drill.fen)[0], f1 = after(drill.fen, m1);
    const err = async (path, body, re) => {
      const r = await ask('POST', path, body);
      assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.match(r.body.error, re);
    };
    const mv = '/api/drills/move';
    await err(mv, '{nope', /JSON/);
    await err(mv, '[]', /object/);
    await err(mv, { ending: 'KNNK' }, /ending/);
    await err(mv, { ending: 'KQK', level: 0, fens: [drill.fen, f1] }, /level/);
    await err(mv, { ending: 'KQK', level: 1, fens: [drill.fen] }, /fens/);
    await err(mv, { ending: 'KQK', level: 1, fens: 'x' }, /fens/);
    await err(mv, { ending: 'KQK', level: 1, fens: Array(302).fill(drill.fen) }, /fens/);
    await err(mv, { ending: 'KQK', level: 1, fens: [drill.fen, f1, drill.fen] }, /follow a move of yours/);
    await err(mv, { ending: 'KRK', level: 1, fens: [drill.fen, f1] }, /not a KRK start/);
    await err(mv, { ending: 'KQK', level: 1, fens: [f1, drill.fen] }, /not a KQK start/);
    await err(mv, { ending: 'KQK', level: 5, fens: [drill.fen, f1] }, /level 5 start/);     // its dtm is out of that band
    await err(mv, { ending: 'KQK', level: 1, fens: [drill.fen, drill.fen] }, /fens\[1\]: not one legal move/);
    await err(mv, { ending: 'KQK', level: 1, fens: [drill.fen, 7] }, /fens\[1\]/);
    await err('/api/drills/line', { ending: 'KQK', fen: 'x' }, /fen/);
    await err('/api/drills/line', { ending: 'KRK', fen: drill.fen }, /not a KRK position/);
    await err('/api/drills/line', { ending: 'KPK-hold', fen: '8/8/8/8/8/4P3/8/k3K3 w - - 0 1' }, /not a KPK-hold position/);
    await err('/api/drills/line', { ending: 'KPK', fen: '8/8/8/8/8/4p3/8/k3K3 w - - 0 1' }, /not a KPK position/);
    assert.equal((await ask('POST', '/api/drills/other', {})).status, 404);
  });
  // no tables: 503 for both
  await withRouter(undefined, async ask => {
    const r = await ask('POST', '/api/drills/move', { ending: 'KQK', level: 1, fens: ['k7/8/8/8/8/8/8/K6Q w - - 0 1', 'k7/8/8/8/8/8/8/K5Q1 b - - 1 1'] });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /not installed/);
    assert.equal((await ask('POST', '/api/drills/line', { ending: 'KQK', fen: 'k7/8/8/8/8/8/8/K6Q w - - 0 1' })).status, 503);
  });
});

test('move: a request that carries on past an earlier end is refused', async () => {
  await withRouter(real, async ask => {
    const { drill } = (await ask('GET', '/api/drills/next?ending=KRK&level=5')).body;
    // the rook left hanging: the drill ends there (piece_lost); anything after it is refused
    const fens = [drill.fen];
    const hang = movesFrom(drill.fen).find(u => D.playMove(tables, D.parseMove(tables, { ending: 'KRK', level: 5,
      fens: [drill.fen, after(drill.fen, u)] })).result === 'piece_lost');
    assert.ok(hang);
    fens.push(after(drill.fen, hang));
    const a = D.playMove(tables, D.parseMove(tables, { ending: 'KRK', level: 5, fens }));
    fens.push(after(fens[1], a.reply));
    fens.push(after(fens[2], movesFrom(fens[2])[0]));
    const r = await ask('POST', '/api/drills/move', { ending: 'KRK', level: 5, fens });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /fens\[2\]: the drill was over there/);
  });
});

test('line: the table line as moves with SAN and FEN, the KPK defence holding', async () => {
  await withRouter(real, async ask => {
    const { drill } = (await ask('GET', '/api/drills/next?ending=KRK')).body;
    const r = await ask('POST', '/api/drills/line', { ending: 'KRK', fen: drill.fen });
    assert.equal(r.status, 200);
    assert.equal(r.body.line.length, 2 * drill.dtm - 1);
    assert.deepEqual(r.body.moves.map(m => m.uci), r.body.line);
    assert.match(r.body.moves[r.body.moves.length - 1].san, /#$/);
    assert.equal(r.body.moves[0].fen, after(drill.fen, r.body.line[0]));
    // from black's side of the line too
    const b = await ask('POST', '/api/drills/line', { ending: 'KRK', fen: r.body.moves[0].fen });
    assert.equal(b.body.line.length, 2 * drill.dtm - 2);
    const hold = (await ask('GET', '/api/drills/next?ending=KPK-hold')).body.drill;
    const h = await ask('POST', '/api/drills/line', { ending: 'KPK-hold', fen: hold.fen });
    assert.equal(h.status, 200);
    assert.ok(h.body.line.length >= 1);
    // every user move on it keeps the draw
    const fens = [hold.fen, ...h.body.moves.map(m => m.fen)];
    const end = fens.length % 2 ? fens.length - 1 : fens.length;
    if (end >= 2) {
      const a = D.playMove(tables, D.parseMove(tables, { ending: 'KPK-hold', level: hold.level, fens: fens.slice(0, end) }));
      assert.notEqual(a.kind, 'threw');
    }
  });
});

const REAL = join(fileURLToPath(new URL('../..', import.meta.url)), 'data', 'endgames');
const haveReal = ['kqk', 'krk', 'kqrk', 'krrk'].every(n => existsSync(join(REAL, `${n}.bin`)));

test('the real 4-piece tables: KQRK and KRRK dealt and played to mate', { skip: !haveReal && 'no data/endgames' }, async () => {
  const load = tablesFromFiles(async p => readFileSync(join(REAL, '..', p)), 'endgames');
  await withRouter(load, async ask => {
    for (const ending of ['KQRK', 'KRRK']) {
      for (const level of [1, 3]) {
        const n = await ask('GET', `/api/drills/next?ending=${ending}&level=${level}`);
        assert.equal(n.status, 200, JSON.stringify(n.body));
        const { drill } = n.body;
        assert.equal(drill.level, level);
        const best = async f => (await ask('POST', '/api/drills/line', { ending, fen: f })).body.line[0];
        const { answers } = await playDrill(ask, drill, best);
        const last = answers[answers.length - 1];
        assert.equal(last.result, 'solved');
        assert.equal(last.moves_used, drill.dtm);
        assert.equal(last.worst_loss, -1);
      }
    }
  });
});

const haveMinor = ['kbbk', 'kbnk'].every(n => existsSync(join(REAL, `${n}.bin`)));

test('the real KBBK and KBNK tables: dealt, played to mate, recorded; a level 5 KBNK deal', { skip: !haveMinor && 'no data/endgames/kbbk.bin, kbnk.bin' }, async () => {
  const load = tablesFromFiles(async p => readFileSync(join(REAL, '..', p)), 'endgames');
  await withRouter(load, async ask => {
    for (const ending of ['KBBK', 'KBNK']) {
      const { drill } = (await ask('GET', `/api/drills/next?ending=${ending}`)).body;
      assert.deepEqual([drill.level, drill.mode, drill.counter], [1, 'mate', true]);
      const best = async f => (await ask('POST', '/api/drills/line', { ending, fen: f })).body.line[0];
      const { answers } = await playDrill(ask, drill, best);
      const last = answers[answers.length - 1];
      assert.deepEqual([last.result, last.moves_used, last.worst_loss], ['solved', drill.dtm, -1]);
      const r = await ask('POST', '/api/drills/attempt', { ...drill, moves_used: last.moves_used, result: last.result, ms: 9000,
        worst_loss: last.worst_loss });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.status.ending, r.body.status.played, r.body.status.solved], [ending, 1, 1]);
    }
    const n = await ask('GET', '/api/drills/next?ending=KBNK&level=5');
    assert.equal(n.status, 200, JSON.stringify(n.body));
    const { drill } = n.body;
    assert.ok(drill.dtm >= 28 && drill.dtm <= 33 && drill.budget === drill.dtm + 4 && drill.counter === false, JSON.stringify(drill));
  });
});

// ---------- the rook drills: Stockfish's reply ----------

// the tables the rook drills load: the 3-piece ones made here, the 4-piece ones from data/endgames or, without them,
// all draws (the 5-piece play below never reaches them)
const haveRook = ROOK_TABLES.every(n => existsSync(join(REAL, `${n.toLowerCase()}.bin`)));
const rookLoad = haveRook ? tablesFromFiles(async p => readFileSync(join(REAL, '..', p)), 'endgames')
  : async name => tables[name] ?? { name, data: new Uint8Array(tableSize(name)) };
const STOCKFISH = join(fileURLToPath(new URL('../..', import.meta.url)), 'bin', 'stockfish');

/** A fake engine pool: each search answers the next of `script` ({move, cp | mate}, an Error to throw, or a function
 * of (fen, moves) giving one); the calls are kept as [fen, nodes, multipv, moves]. */
function fakePool(script) {
  const calls = [];
  return {
    calls, size: 1, name: 'fake', async load() {},
    async search(fen, nodes, multipv, moves) {
      calls.push([fen, nodes, multipv, moves]);
      let r = script.shift();
      if (typeof r === 'function') r = r(fen, moves);
      if (!r || r instanceof Error) throw r ?? new Error('no reply scripted');
      const score = r.mate != null ? `mate ${r.mate}` : `cp ${r.cp}`;
      return ['info depth 3 seldepth 3 multipv 1 score cp 1 nodes 100 pv a1a2',
        `info depth 12 seldepth 20 multipv 1 score ${score} upperbound nodes ${nodes} pv h1h2`,
        `info depth 12 seldepth 20 multipv 1 score ${score} nodes ${nodes} nps 1 pv ${r.move} a2a3`];
    },
  };
}

// the first legal move after `moves` from fen, as an engine reply
const firstLegal = (fen, moves) => {
  const b = boardFromFen(fen);
  for (const u of moves) push(b, parseUci(b, u));
  return { move: uciOf(legalMoves(b)[0]), cp: 0 };
};

test('rook drills: unavailable without an engine, or on a phone; the status says which', async () => {
  for (const [extra, reason] of [[{}, 'no_engine'], [{ drillEngine: fakePool([]), drillEngineUnavailable: 'needs_computer' }, 'needs_computer']]) {
    await withRouter(rookLoad, async ask => {
      for (const ending of ['Lucena', 'Philidor']) {
        const n = await ask('GET', `/api/drills/next?ending=${ending}`);
        assert.deepEqual([n.status, n.body.reason], [503, reason]);
        assert.match(n.body.error, reason === 'no_engine' ? /not installed/ : /need a computer/);
        const e = ROOK_STARTS[ending][0][0];
        const m = await ask('POST', '/api/drills/move', { ending, level: 1, fens: [e.fen, after(e.fen, movesFrom(e.fen)[0])] });
        assert.deepEqual([m.status, m.body.reason], [503, reason]);
        const s = await ask('GET', `/api/drills/status?ending=${ending}`);
        assert.deepEqual([s.status, s.body.unavailable, s.body.top], [200, reason, 4]);
      }
      assert.equal((await ask('GET', '/api/drills/status?ending=KQK')).body.unavailable, null);
      assert.equal((await ask('GET', '/api/drills/next?ending=KQK')).status, 200);    // the other drills don't need it
    }, extra);
  }
});

// the first start (as dealt, any level) with a quiet user move, a quiet black reply and then a promotion
function promotingLine() {
  const quiet = (f, u) => after(f, u).split(' ')[0].replace(/\d|\//g, '').length === f.split(' ')[0].replace(/\d|\//g, '').length;
  for (const [l, list] of ROOK_STARTS.Lucena.entries()) {
    for (const e of list) {
      for (const w of movesFrom(e.fen).filter(u => quiet(e.fen, u))) {
        const f1 = after(e.fen, w);
        for (const b of movesFrom(f1).filter(u => quiet(f1, u))) {
          const q = movesFrom(after(f1, b)).find(u => u.endsWith('q'));
          if (q) return { e, level: l + 1, line: [w, b, q] };
        }
      }
    }
  }
  throw new Error('no Lucena start promotes on the second move');
}

test('rook drills: a Lucena played to the promotion against scripted replies, then recorded', async () => {
  const { e, level, line: [w, b, q] } = promotingLine();
  const slack = LEVELS.Lucena[level - 1].slack;
  const pool = fakePool([{ move: b, cp: -850 }, { move: 'a1a1', mate: -4 }]);
  await withRouter(rookLoad, async ask => {
    const n = await ask('GET', `/api/drills/next?ending=Lucena&level=${level}`);
    assert.equal(n.status, 200);
    assert.deepEqual([n.body.drill.mode, n.body.drill.dtm, n.body.drill.post_promo, n.body.status.unavailable], ['lucena', null, 10, undefined]);
    assert.equal(rookStart(n.body.drill.fen).level, level);
    // the user's first move: the reply comes from the engine, which gets the history
    const fens = [e.fen, after(e.fen, w)];
    const one = await ask('POST', '/api/drills/move', { ending: 'Lucena', level, fens });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(Object.keys(one.body), ['san', 'fen_move', 'kind', 'loss', 'dtm_after', 'reply', 'reply_san', 'fen', 'dtm',
      'moves_used', 'budget', 'result', 'review', 'worst_loss', 'promoted', 'engine_ms']);
    const sanOf = (f, u) => { const bd = boardFromFen(f); return san(bd, parseUci(bd, u)); };
    assert.deepEqual([one.body.san, one.body.kind, one.body.loss, one.body.dtm_after, one.body.dtm], [sanOf(e.fen, w), null, null, null, null]);
    assert.deepEqual([one.body.reply, one.body.reply_san, one.body.result, one.body.promoted], [b, sanOf(fens[1], b), null, false]);
    assert.deepEqual([one.body.moves_used, one.body.budget], [1, e.promote + slack]);
    assert.ok(Number.isInteger(one.body.engine_ms));
    assert.deepEqual(pool.calls[0], [e.fen, 200_000, 1, [w]]);
    // the promotion: the engine sees itself mated, so the drill ends there and the reply (here not even legal) isn't played
    fens.push(one.body.fen, after(one.body.fen, q));
    const two = await ask('POST', '/api/drills/move', { ending: 'Lucena', level, fens });
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.deepEqual([two.body.result, two.body.reply, two.body.fen, two.body.promoted], ['promoted', null, null, true]);
    assert.match(two.body.san, /=Q/);
    assert.deepEqual(pool.calls[1][3], [w, b, q]);
    assert.deepEqual(two.body.review, { moves: [{ dtm: null, kind: null, loss: null }, { dtm: null, kind: null, loss: null }], worst: -1 });
    assert.equal(two.body.worst_loss, null);
    // recorded as the page would
    const r = await ask('POST', '/api/drills/attempt', { ending: 'Lucena', level, fen: e.fen, dtm: null, budget: e.promote + slack,
      moves_used: 2, result: 'promoted', ms: 9000, worst_loss: null });
    assert.deepEqual([r.status, r.body.counted, r.body.status.played, r.body.status.solved], [200, true, 1, 1]);
    // no table line for a rook ending
    assert.equal((await ask('POST', '/api/drills/line', { ending: 'Lucena', fen: e.fen })).status, 400);
  }, { drillEngine: pool });
});

test('rook drills: the engine retried at fewer nodes after a crash, a 503 when it never answers; refusals', async () => {
  const e = ROOK_STARTS.Philidor[0][0], first = movesFrom(e.fen)[0];
  const pool = fakePool([new Error('engine crashed: SIGSEGV'), new Error('engine crashed: SIGSEGV'), firstLegal,
    new Error('x'), new Error('x'), new Error('x')]);
  await withRouter(rookLoad, async ask => {
    const fens = [e.fen, after(e.fen, first)];
    const ok = await ask('POST', '/api/drills/move', { ending: 'Philidor', level: 1, fens });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(pool.calls.map(c => c[1]), [200_000, 100_000, 20_000]);
    assert.deepEqual([ok.body.budget, ok.body.result, ok.body.promoted], [null, null, false]);
    const down = await ask('POST', '/api/drills/move', { ending: 'Philidor', level: 1, fens });
    assert.deepEqual([down.status, down.body.reason], [503, 'engine_failed']);
    assert.match(down.body.error, /the engine failed/);
    // a start of another level, or of the other ending, or no start at all, is refused
    const bad = async (body, re) => {
      const r = await ask('POST', '/api/drills/move', body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, re);
    };
    await bad({ ending: 'Philidor', level: 2, fens }, /fens\[0\]: not a Philidor start position/);
    await bad({ ending: 'Lucena', level: 1, fens }, /fens\[0\]: not a Lucena start position/);
    const near = after(after(e.fen, first), movesFrom(after(e.fen, first))[0]);     // two plies on: not a start
    await bad({ ending: 'Philidor', level: 1, fens: [near, after(near, movesFrom(near)[0])] }, /not a Philidor start position/);
    await bad({ ending: 'Philidor', level: 5, fens }, /level/);
    // the mirror of a start is one
    const m = mirrorFen(e.fen);
    pool.search = async (fen, nodes, multipv, moves) => [`info depth 9 multipv 1 score cp 12 nodes ${nodes} pv ${firstLegal(fen, moves).move}`];
    const mir = await ask('POST', '/api/drills/move', { ending: 'Philidor', level: 1, fens: [m, after(m, movesFrom(m)[0])] });
    assert.equal(mir.status, 200, JSON.stringify(mir.body));
  }, { drillEngine: pool });
});

test('rook drills: Stockfish at 1M nodes as the user wins three Lucena level 1 starts against the drill opponent',
  { skip: (!haveRook && 'no data/endgames') || (!existsSync(STOCKFISH) && 'no bin/stockfish') }, async () => {
    const user = new EnginePool({ size: 1, path: STOCKFISH, hash: 16 }), drill = new EnginePool({ size: 1, path: STOCKFISH, hash: 16 });
    try {
      await withRouter(rookLoad, async ask => {
        for (const e of ROOK_STARTS.Lucena[0].slice(0, 3)) {
          const fens = [e.fen], ucis = [];
          let last = null;
          for (let k = 0; k < 40 && !last?.result; k++) {
            const best = bestOf(await user.search(e.fen, 1_000_000, 1, ucis));
            ucis.push(best.move);
            fens.push(after(fens[fens.length - 1], best.move));
            const r = await ask('POST', '/api/drills/move', { ending: 'Lucena', level: 1, fens });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            last = r.body;
            if (!last.result) {
              ucis.push(last.reply);
              fens.push(last.fen);
            }
          }
          assert.ok(['promoted', 'won'].includes(last.result), `${e.fen}: ${last.result} after ${last.moves_used} moves`);
        }
      }, { drillEngine: drill });
    } finally {
      await user.close();
      await drill.close();
    }
  });

// ---------- round 4: the start's counters, the review hint ----------

test('rook drills: the move route takes the stored start\'s halfmove clock and move number, not the client\'s', async () => {
  const e = ROOK_STARTS.Philidor[0][0], first = movesFrom(e.fen)[0];
  const crafted = e.fen.replace(/ \d+ \d+$/, ' 99 60');
  assert.notEqual(crafted, e.fen);
  const ts = await new DrillTables(rookLoad).get('Philidor');
  for (const start of [crafted, mirrorFen(crafted)]) {
    const req = D.parseMove(ts, { ending: 'Philidor', level: 1, fens: [start, after(start, movesFrom(start)[0])] });
    assert.equal(req.fens[0], start === crafted ? e.fen : mirrorFen(e.fen));
    assert.doesNotMatch(req.fens[1], / 99 /);
  }
  const pool = fakePool([firstLegal]);
  await withRouter(rookLoad, async ask => {
    const r = await ask('POST', '/api/drills/move', { ending: 'Philidor', level: 1, fens: [crafted, after(crafted, first)] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result, null);      // a clock of 99 would have made it 'held' (the fifty-move rule) at once
    assert.ok(r.body.reply);
  }, { drillEngine: pool });
});

test('rook drills: an illegal engine move is a 503, not a 500', async () => {
  const e = ROOK_STARTS.Lucena[0][0];
  await withRouter(rookLoad, async ask => {
    const r = await ask('POST', '/api/drills/move', { ending: 'Lucena', level: 1, fens: [e.fen, after(e.fen, movesFrom(e.fen)[0])] });
    assert.deepEqual([r.status, r.body.reason], [503, 'engine_failed']);
    assert.match(r.body.error, /not legal/);
  }, { drillEngine: fakePool([{ move: 'a1a1', cp: 0 }]) });
});

// a Philidor attempt from a start, every ply the first legal move that doesn't end the drill: `n` user moves, with the
// reply after each unless `lastReply` is false
async function philidorAttempt(n, lastReply = true) {
  const ts = await new DrillTables(rookLoad).get('Philidor');
  const e = ROOK_STARTS.Philidor[0][0], fens = [e.fen], ucis = [];
  const step = () => {
    const f = fens[fens.length - 1];
    const u = movesFrom(f).find(x => !rookStatus(ts, 'Philidor', { fens: [...fens, after(f, x)] }));
    assert.ok(u, `no move that goes on from ${f}`);
    ucis.push(u);
    fens.push(after(f, u));
  };
  for (let k = 0; k < n; k++) {
    step();
    if (k < n - 1 || lastReply) step();
  }
  return { e, fens, ucis };
}

// the first-legal-move line of `plies` from fen after moves (an engine's pv)
function firstLine(fen, moves, plies) {
  const b = boardFromFen(fen);
  for (const u of moves) push(b, parseUci(b, u));
  const out = [];
  for (let i = 0; i < plies; i++) {
    const m = legalMoves(b)[0];
    if (!m) break;
    out.push(uciOf(m));
    push(b, m);
  }
  return out;
}

/** An analysis pool that scores by the number of moves played (`scores`, side to move's view; an Error is thrown)
 * and answers a legal 10-ply pv; the calls kept, and the most searches it had running at once. */
function hintPool(scores) {
  const p = { calls: [], running: 0, most: 0, size: 4, name: 'fake', async load() {} };
  p.search = async (fen, nodes, multipv, moves) => {
    p.calls.push([fen, nodes, multipv, moves]);
    p.running++;
    p.most = Math.max(p.most, p.running);
    await new Promise(res => setTimeout(res, 5));
    p.running--;
    const s = scores[moves.length];
    if (s instanceof Error) throw s;
    return [`info depth 20 seldepth 30 multipv 1 score cp ${s} nodes ${nodes} nps 1 pv ${firstLine(fen, moves, 10).join(' ')}`];
  };
  return p;
}

test('rook hint: every position of the attempt searched at once on the analysis pool, the biggest fall marked', async () => {
  const { e, fens, ucis } = await philidorAttempt(3);
  const pool = hintPool({ 0: 10, 2: 0, 4: -600, 6: -650 });
  await withRouter(rookLoad, async ask => {
    const r = await ask('POST', '/api/drills/hint', { ending: 'Philidor', level: 1, fens });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body), ['moves', 'likely', 'pv', 'line', 'hint', 'approximate', 'ms']);
    assert.deepEqual(r.body.moves.map(m => [m.ply, m.score_before, m.score_after]), [[0, 10, 0], [2, 0, -600], [4, -600, -650]]);
    assert.equal(r.body.likely, 1);
    assert.equal(r.body.approximate, true);
    assert.deepEqual(r.body.pv, firstLine(e.fen, ucis.slice(0, 2), 8));
    assert.deepEqual(r.body.moves[1].pv, r.body.pv);
    assert.deepEqual(r.body.line.map(m => m.uci), r.body.pv);
    assert.ok(r.body.line.every(m => m.san && m.fen));
    assert.ok(r.body.hint === null || ['king_path', 'rook_third', 'rook_behind'].includes(r.body.hint), r.body.hint);
    assert.ok(Number.isInteger(r.body.ms));
    // the start and each position after a reply, with the history, at 400,000 nodes, MultiPV 1, all at once
    assert.deepEqual(pool.calls.map(c => c[3].length).sort(), [0, 2, 4, 6]);
    assert.ok(pool.calls.every(c => c[0] === e.fen && c[1] === 400_000 && c[2] === 1));
    assert.deepEqual(pool.calls.find(c => c[3].length === 4)[3], ucis.slice(0, 4));
    assert.equal(pool.most, 4);
  }, { drillEngine: fakePool([]), analysisPool: pool });
});

test('rook hint: an attempt that ended on the user\'s move scores the position after it; nothing fell, no likely move', async () => {
  const { fens } = await philidorAttempt(2, false);     // [start, w, b, w]: black to move at the end
  assert.equal(fens.length, 4);
  const pool = hintPool({ 0: 20, 2: 0, 3: 30 });     // 3: black to move, so -30 for white
  await withRouter(rookLoad, async ask => {
    const r = await ask('POST', '/api/drills/hint', { ending: 'Philidor', level: 1, fens });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.moves.map(m => [m.ply, m.score_before, m.score_after]), [[0, 20, 0], [2, 0, -30]]);
    assert.deepEqual([r.body.likely, r.body.pv, r.body.hint], [null, [], null]);
  }, { drillEngine: fakePool([]), analysisPool: pool });
});

test('rook hint: a crash retried at fewer nodes; refusals and 503s', async () => {
  const { fens } = await philidorAttempt(1);
  const crash = new Error('engine crashed');
  // the first search of the start crashes once: retried at 100k
  let crashed = false;
  const pool = hintPool({ 0: 10, 2: 5 });
  const inner = pool.search;
  pool.search = async (fen, nodes, multipv, moves) => {
    if (!moves.length && !crashed) {
      crashed = true;
      throw crash;
    }
    return inner(fen, nodes, multipv, moves);
  };
  await withRouter(rookLoad, async ask => {
    const r = await ask('POST', '/api/drills/hint', { ending: 'Philidor', level: 1, fens });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.moves.map(m => [m.score_before, m.score_after]), [[10, 5]]);
    assert.deepEqual(pool.calls.filter(c => !c[3].length).map(c => c[1]), [100_000]);
    // not a rook ending, not a start of the level, too few positions
    for (const [body, re] of [[{ ending: 'KQK', level: 1, fens }, /no hint/], [{ ending: 'Philidor', level: 2, fens }, /not a Philidor start/],
      [{ ending: 'Philidor', level: 1, fens: [fens[0]] }, /fens: 2 to/]]) {
      const b = await ask('POST', '/api/drills/hint', body);
      assert.equal(b.status, 400, JSON.stringify(b.body));
      assert.match(b.body.error, re);
    }
  }, { drillEngine: fakePool([]), analysisPool: pool });
  // every search failing: 503
  await withRouter(rookLoad, async ask => {
    const r = await ask('POST', '/api/drills/hint', { ending: 'Philidor', level: 1, fens });
    assert.deepEqual([r.status, r.body.reason], [503, 'engine_failed']);
  }, { drillEngine: fakePool([]), analysisPool: hintPool({ 0: crash, 2: crash }) });
  // phones: the rook drills need a computer, the hint too
  await withRouter(rookLoad, async ask => {
    const r = await ask('POST', '/api/drills/hint', { ending: 'Philidor', level: 1, fens });
    assert.deepEqual([r.status, r.body.reason], [503, 'needs_computer']);
  }, { drillEngine: fakePool([]), drillEngineUnavailable: 'needs_computer' });
});
