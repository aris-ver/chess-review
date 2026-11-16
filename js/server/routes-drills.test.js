// The drill routes through the router (as routes-puzzles.test.js builds it), over the 3-piece tables made here and
// fakes for the rest: the deal, recording an attempt, the standing, and every refusal.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setBook } from '../core/book.js';
import { boardFromFen, fen as fenOf, legalMoves, parseUci, push, uci as uciOf } from '../core/chess.js';
import { generate, tableSize } from '../core/endgame-table.js';
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
    await err(mv, { ending: 'KBNK' }, /ending/);
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
