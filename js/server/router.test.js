// Route-level parity: the requests of tests/parity/router.json (scripts/dump_router_parity.py ran them through
// serve.Handler) replayed on the JS router over an empty data folder, with the searches Stockfish made there and
// the same fake chess.com. Every answer must match: status, content type and JSON (floats at 1e-9; timestamps,
// `elapsed` and the review's `fp` left out). Errors worded by the chess library are compared by status only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { setBook } from '../core/book.js';
import { load, same } from '../parity.js';
import { nodeSqlite } from './db-node.js';
import { Store } from './db.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';
import { fillPieces, serve } from './router.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** dump_router_parity.py's chess.com: the pipeline's months for its user, 404 for anyone else. */
function chesscom({ username, raw }) {
  const base = `https://api.chess.com/pub/player/${username}/games/`;
  return async url => {
    if (!url.includes(`/player/${username}/`)) return json({ code: 0, message: 'User not found' }, 404);
    if (url.endsWith('/stats')) return json({ chess_blitz: { record: { win: 40, loss: 30, draw: 3 } } });
    if (url.endsWith('/archives')) return json({ archives: Object.keys(raw).sort().map(f => base + f.slice(0, 7).replace('-', '/')) });
    const month = url.split('?')[0].split('/').slice(-2).join('-');
    return new Response(raw[`${month}.json`]);
  };
}

/** The recorded searches as an EnginePool. */
function replayPool(d) {
  return {
    size: 2, name: d.engine,
    async load() {},
    async search(fen, nodes, multipv = 3) {
      const lines = d.lines[`${fen}|${nodes}|${multipv}`];
      if (!lines) throw new Error(`no recorded search for ${fen} at ${nodes} nodes, MultiPV ${multipv}`);
      return lines;
    },
  };
}

const VOLATILE = new Set(['created', 'pinned', 'elapsed', 'ended', 'fp']);

/** Timestamps and timings only say whether they're there. */
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, VOLATILE.has(k) ? x !== null : scrub(x)]));
}

test('the JS router answers the requests as serve.Handler does', async () => {
  const d = load('router.json');
  const dir = mkdtempSync(join(tmpdir(), 'blundr-router-'));
  setBook([]);
  const store = new Store(nodeSqlite(dir)), files = memoryFiles();
  const env = { store, files, profiles: new Profiles(files, store), fetch: chesscom(d.chesscom), sleep: async () => {} };
  try {
    const router = await serve({ env, pool: replayPool(d), nodes: d.nodes, scan: false });
    for (const [i, s] of d.steps.entries()) {
      if (s.wait) {
        await router.runner.idle();
        continue;
      }
      const what = `#${i} ${s.method} ${s.path}`;
      const out = await router.handle(s.method, s.path, s.body === null ? '' : JSON.stringify(s.body),
        s.body === null ? null : 'application/json');
      same(out.status, s.status, `${what} status`);
      same((out.headers['Content-Type'] ?? '').split(';')[0], s.type, `${what} type`);
      const text = typeof out.body === 'string' ? out.body : new TextDecoder().decode(out.body);
      if (s.lenient) assert.ok('error' in JSON.parse(text), `${what}: an error`);
      else if (s.json !== undefined) same(scrub(JSON.parse(text)), scrub(s.json), what);
    }
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round 3b routes answer 501', async () => {
  const files = memoryFiles(), dir = mkdtempSync(join(tmpdir(), 'blundr-router-'));
  const store = new Store(nodeSqlite(dir));
  try {
    const router = await serve({ env: { store, files, profiles: new Profiles(files, store) }, pool: replayPool({ lines: {} }), nodes: 1, scan: false });
    for (const [m, p] of [['GET', '/api/settings'], ['POST', '/api/settings'], ['GET', '/api/puzzles/next'], ['POST', '/api/puzzles/attempt'],
      ['POST', '/api/sync/state'], ['GET', '/account/me'], ['GET', '/api/update'], ['POST', '/api/update/apply'], ['GET', '/api/fetch_image?url=x']]) {
      same((await router.handle(m, p, '')).status, 501, `${m} ${p}`);
    }
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eval_stream: snapshots from the pool stream, closed when the client goes', async () => {
  const files = memoryFiles(), dir = mkdtempSync(join(tmpdir(), 'blundr-router-'));
  const store = new Store(nodeSqlite(dir));
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let stopped = false, asked = null;
  const pool = {
    size: 1, name: 'fake', async load() {},
    async search() { return ['info depth 1 seldepth 1 multipv 1 score cp 20 nodes 10 pv e2e4']; },
    async *stream(fen, multipv) {
      asked = [fen, multipv];
      try {
        for (let n = 100; ; n += 100) {
          yield `info depth ${n / 100} seldepth 1 multipv 1 score cp 30 nodes ${n} pv d2d4 d7d5`;
          await new Promise(r => setTimeout(r, 5));
        }
      } finally {
        stopped = true;
      }
    },
  };
  try {
    const router = await serve({ env: { store, files, profiles: new Profiles(files, store) }, pool, nodes: 10, scan: false });
    same((await router.handle('GET', '/api/eval_stream?fen=bad', '')).status, 400, 'bad fen');
    const out = await router.handle('GET', `/api/eval_stream?fen=${encodeURIComponent(start)}&multipv=9`, '');
    same([out.status, out.headers['Content-Type']], [200, 'application/x-ndjson'], 'head');
    const it = out.body[Symbol.asyncIterator]();
    const first = JSON.parse((await it.next()).value);
    same([first.engine, first.lines[0].san], ['fake', 'd4'], 'first snapshot');
    same(asked, [start, 5], 'searched with MultiPV clamped to 5');
    await it.return();
    assert.ok(stopped, 'the search was stopped');
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fillPieces', () => {
  same(fillPieces('a /*__PIECES__*/ b', { K: '<svg/>' }), 'a {"K":"<svg/>"} b');
});
