// Measures the rook drills (.coordination/p5-spec.md, "Round 2 result" and "Round 3"): white plays the tablebase's
// best move (lichess's first listed one) against the drill's real opponent (Stockfish at OPPONENT_NODES with the
// game's history, server/drill-opponent.js), every ply graded by core/rook-drills.js, on about N starts per level.
// Reports per level how the games end (for Lucena: how many promote within the budget, and the moves used against the
// start's promote) and the opponent's reply times. --replay times the recorded replies again on another engine (the
// WASM build run by Node, say) and counts how often it picks the same move.
//
//   node scripts/check_rook_drills.js [--per-level 20] [--endings Lucena,Philidor] [--engine bin/stockfish]
//                                     [--out data/rook-check.json] [--offline]
//   node scripts/check_rook_drills.js --replay data/rook-check.json --engine <path> [--sample 200]
//
// lichess manners: one request at a time, 1.1 s between starts, User-Agent 'endgame-table-check', 429 waits 60 s, a
// 5xx or a network error retries after 5, 15 and 45 s. Answers are read from data/tablebase-cache.jsonl (round 2's,
// never written here) and data/rook-check-cache.jsonl (this script's, appended), in the same trimmed form. Dev only.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boardFromFen, fen as fenOf, parseUci, push } from '../js/core/chess.js';
import { OPPONENT_NODES, ROOK_TABLES, rookBudget, rookTurn } from '../js/core/rook-drills.js';
import { ROOK_STARTS } from '../js/core/rook-starts.js';
import { EnginePool } from '../js/desktop/engines.js';
import { bestOf, opponent } from '../js/server/drill-opponent.js';
import { DrillTables, tablesFromFiles } from '../js/server/drills.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = 'https://tablebase.lichess.ovh/standard';
const USER_AGENT = 'endgame-table-check';
const GAP_MS = 1100, RETRY_MS = [5_000, 15_000, 45_000], RATE_LIMIT_MS = 60_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CODES = { win: 'w', loss: 'l', draw: 'd', 'cursed-win': 'c', 'blessed-loss': 'b', 'maybe-win': 'x', 'maybe-loss': 'y', unknown: 'u' };

function args(argv) {
  const o = { perLevel: 20, endings: ['Lucena', 'Philidor'], engine: join(ROOT, 'bin', 'stockfish'), out: join(ROOT, 'data', 'rook-check.json'),
    offline: false, replay: null, sample: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--per-level') o.perLevel = +v();
    else if (a === '--endings') o.endings = v().split(',');
    else if (a === '--engine') o.engine = v();
    else if (a === '--out') o.out = v();
    else if (a === '--offline') o.offline = true;
    else if (a === '--replay') o.replay = v();
    else if (a === '--sample') o.sample = +v();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

class Tablebase {
  constructor(offline) {
    this.offline = offline;
    this.own = join(ROOT, 'data', 'rook-check-cache.jsonl');
    this.map = new Map();
    this.requests = 0;
    this.last = 0;
    for (const f of [join(ROOT, 'data', 'tablebase-cache.jsonl'), this.own]) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (row.url && row.body) this.map.set(row.url, row.body);
      }
    }
  }
  // {category, moves: [[uci, category]]} of a position (white to move), lichess's order
  async position(fen) {
    const key = fen.split(' ').slice(0, 4).join(' ') + ' 0 1';
    const url = `${API}?fen=${key.replace(/ /g, '_')}`;
    let body = this.map.get(url);
    if (!body) {
      if (this.offline) throw new Error(`cache miss offline: ${url}`);
      const j = await this.fetch(url);
      body = { c: j.category, z: j.dtz, m: j.moves.map(m => `${m.uci}:${CODES[m.category]}:${m.dtz ?? 0}`).join(' ') };
      this.map.set(url, body);
      appendFileSync(this.own, JSON.stringify({ url, body }) + '\n');
    }
    return { category: body.c, moves: body.m ? body.m.split(' ').map(t => t.split(':').slice(0, 2)) : [] };
  }
  async fetch(url) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.requests++;
      let failure;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (res.status === 429) { console.error('429, waiting 60 s'); await sleep(RATE_LIMIT_MS); attempt--; continue; }
        if (res.ok) return await res.json();
        failure = new Error(`HTTP ${res.status}`);
        if (res.status < 500) throw failure;
      } catch (e) {
        failure = e;
      }
      if (attempt >= RETRY_MS.length) throw failure;
      console.error(`${failure.message}, retry in ${RETRY_MS[attempt] / 1000} s`);
      await sleep(RETRY_MS[attempt]);
    }
  }
}

const after = (fen, uci) => {
  const b = boardFromFen(fen);
  push(b, parseUci(b, uci));
  return fenOf(b);
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null;
};

async function play(o) {
  const tb = new Tablebase(o.offline);
  const tables = new DrillTables(tablesFromFiles(async p => {
    const f = join(ROOT, 'data', p);
    return existsSync(f) ? readFileSync(f) : null;
  }, 'endgames'));
  const t = {};
  for (const n of ROOK_TABLES) t[n] = await tables.table(n);
  const pool = new EnginePool({ size: 1, path: o.engine, hash: 16 });
  const engine = opponent(pool);
  const report = { nodes: OPPONENT_NODES, engine: o.engine, levels: [], queries: [] };
  try {
    const t0 = performance.now();
    await pool.load();      // the first reply after a start also pays this (the engine and its net loading)
    report.load_ms = Math.round(performance.now() - t0);
    console.log(`engine load: ${report.load_ms} ms`);
    for (const ending of o.endings) {
      for (let l = 0; l < 4; l++) {
        const list = ROOK_STARTS[ending][l], n = Math.min(o.perLevel, list.length);
        const games = [];
        for (let g = 0; g < n; g++) {
          const index = Math.floor((g * list.length) / n), e = list[index];
          const budget = rookBudget(ending, l + 1, e);
          const fens = [e.fen], ucis = [], ms = [];
          let out = null;
          while (!out?.result) {
            const p = await tb.position(fens[fens.length - 1]);
            if (!p.moves.length) throw new Error(`no moves at ${fens[fens.length - 1]}`);
            const mv = p.moves[0][0];
            ucis.push(mv);
            fens.push(after(fens[fens.length - 1], mv));
            out = await rookTurn(t, ending, { fens, ucis, budget }, async q => {
              const r = await engine(q);
              report.queries.push({ ending, fen: q.fen, moves: [...q.moves], move: r.move, ms: r.ms });
              return r;
            });
            if (out.engine_ms != null) ms.push(out.engine_ms);
            if (!out.result) {
              ucis.push(out.reply);
              fens.push(out.fen);
            }
          }
          const used = Math.floor(fens.length / 2);
          games.push({ index, fen: e.fen, promote: e.promote, budget, result: out.result, used, ms });
          console.error(`${ending} L${l + 1} #${index}: ${out.result} in ${used} (promote ${e.promote}, budget ${budget}), ` +
            `lichess requests so far ${tb.requests}`);
        }
        const all = games.flatMap(x => x.ms);
        const byResult = {};
        for (const x of games) byResult[x.result] = (byResult[x.result] ?? 0) + 1;
        const row = { ending, level: l + 1, games: games.length, results: byResult,
          reply_ms: { n: all.length, p50: pct(all, 50), p90: pct(all, 90), max: Math.max(...all) } };
        if (ending === 'Lucena') {
          const solved = games.filter(x => x.result === 'promoted' || x.result === 'won');
          row.within_budget = solved.length;
          row.over_promote = solved.map(x => x.used - x.promote).sort((a, b) => a - b);
          row.slack_left = solved.map(x => x.budget - x.used).sort((a, b) => a - b);
        }
        report.levels.push({ ...row, detail: games.map(({ ms, ...x }) => x) });
        console.log(JSON.stringify(row));
      }
    }
  } finally {
    await pool.close();
  }
  report.requests = tb.requests;
  writeFileSync(o.out, JSON.stringify(report, null, 1));
  console.log(`lichess requests: ${tb.requests}; written ${o.out}`);
}

async function replay(o) {
  const rec = JSON.parse(readFileSync(o.replay, 'utf8'));
  const pool = new EnginePool({ size: 1, path: o.engine, hash: 16 });
  const step = Math.max(1, Math.floor(rec.queries.length / o.sample));
  const out = {};
  try {
    await pool.load();
    for (let i = 0; i < rec.queries.length; i += step) {
      const q = rec.queries[i], t0 = performance.now();
      const best = bestOf(await pool.search(q.fen, rec.nodes, 1, q.moves));
      const ms = performance.now() - t0;
      const r = out[q.ending] ??= { ms: [], same: 0, n: 0, native: [] };
      r.ms.push(ms);
      r.native.push(q.ms);
      r.n++;
      if (best.move === q.move) r.same++;
    }
  } finally {
    await pool.close();
  }
  for (const [ending, r] of Object.entries(out)) {
    console.log(JSON.stringify({ ending, engine: o.engine, n: r.n, p50: Math.round(pct(r.ms, 50)), p90: Math.round(pct(r.ms, 90)),
      max: Math.round(Math.max(...r.ms)), same_move: r.same, native_p90_same_sample: pct(r.native, 90) }));
  }
}

const o = args(process.argv.slice(2));
await (o.replay ? replay(o) : play(o));
