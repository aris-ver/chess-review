// Route-level parity for the puzzle routes: the requests of tests/parity/routes-puzzles.json
// (scripts/dump_routes_puzzles_parity.py ran them through serve.Handler, with serve.Runner's build and puzzles jobs)
// replayed on the JS router over an empty data folder, with the same pack, packs.json, clock, deal and recorded
// searches. Every answer must match: status, content type and JSON (timestamps and `elapsed` presence-only).
process.env.TZ = 'UTC';     // a reset's archive is named in local time, and the dump ran in UTC

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { setBook } from '../core/book.js';
import { load, same } from '../parity.js';
import { nodeSqlite } from './db-node.js';
import { Store } from './db.js';
import { Packs } from './packs.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';
import { Pack } from './puzzles.js';
import { serve } from './router.js';
import { PUZZLE_REFRESH_S, work } from './routes-puzzles.js';

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
const SINCE_PORT = new Set(['stages_done', 'stages_perfect', 'tried']);     // the shelf's, added since (puzzles.test.js checks them)

/** Timestamps and timings only say whether they're there; what was added since the port is left out. */
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !SINCE_PORT.has(k)).map(([k, x]) => [k, VOLATILE.has(k) ? x !== null : scrub(x)]));
}

async function withRouter(d, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-routes-puzzles-'));
  setBook([]);
  const store = new Store(nodeSqlite(dir)), files = memoryFiles();
  const env = {
    store, files, profiles: new Profiles(files, store), pack: new Pack(() => structuredClone(d.pack)),
    packs: new Packs(() => d.packs), rng: () => 0,
  };
  try {
    await fn(await serve({ env, pool: replayPool(d), nodes: d.nodes, scan: false }));
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the puzzle routes answer as serve.Handler does', async () => {
  const d = load('routes-puzzles.json');
  await withRouter(d, async router => {
    let clock = d.clock;      // the dump's frozen time, moved on by its "clock" steps
    router.runner.now = () => clock;
    for (const [i, s] of d.steps.entries()) {
      if (s.wait) {
        await router.runner.idle();
        continue;
      }
      if (s.clock) {
        clock = s.clock;
        continue;
      }
      const what = `#${i} ${s.method} ${s.path}`;
      const out = await router.handle(s.method, s.path, s.body === null ? '' : JSON.stringify(s.body),
        s.body === null ? null : 'application/json');
      same(out.status, s.status, `${what} status`);
      same((out.headers['Content-Type'] ?? '').split(';')[0], s.type, `${what} type`);
      const text = typeof out.body === 'string' ? out.body : new TextDecoder().decode(out.body);
      if (s.json !== undefined) same(scrub(JSON.parse(text)), scrub(s.json), what);
    }
  });
});

test('the jobs plug into the Runner', () => {
  same(Object.keys(work).sort(), ['build', 'puzzles'], 'work');
  same(PUZZLE_REFRESH_S, 20, 'refresh');
});
