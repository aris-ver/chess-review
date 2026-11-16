// Builds js/core/rook-starts.js, the start positions of the Lucena and Philidor drills (.coordination/p5-spec.md,
// "Round 2"), by asking the lichess tablebase about seeded candidates.
//
//   node scripts/build_rook_starts.js [--offline] [--out js/core/rook-starts.js] [--cache data/tablebase-cache.jsonl]
//
// The user is white, to move, nobody in check. Lucena: white K+R+P against K+R (pawn up); Philidor: white K+R against
// K+R+P (pawn down). The pawn is on file b, c or d (the drill mirrors it at random). Each ending has four families,
// one per level; a family takes seeded random placements in its shape, in a fixed order, until 60 are accepted, or
// 600 candidates have been asked about (a family that falls short is reported, never loosened).
//
// A candidate is accepted when lichess says: Lucena 'win' (Philidor 'draw'), and at least one legal white move changes
// that (so no start can be played carelessly). Lucena also asks /standard/mainline and keeps the number of white moves
// to the first promotion on it; a mainline with none drops the candidate, and level 4 also needs 10 or more.
//
// Manners: one request at a time, at least 600 ms between their starts, 429 waits 60 s, a 5xx or a network error
// retries after 5, 15 and 45 s and then skips the candidate (written to the cache too, so --offline sees the same).
// Every answer is cached, trimmed to the fields used, in data/tablebase-cache.jsonl, one line per URL, and read first.
// --offline uses only the cache and fails on a miss; with a full cache the output is byte-identical (the date in the
// header is the cache's first line). Dev only: never from builds, tests or CI.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Chess, fen as fenIO } from '../js/vendor/chessops.js';
import { legalMoves, makeSquare } from '../js/core/chess.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_OUT = join(ROOT, 'js', 'core', 'rook-starts.js');
export const DEFAULT_CACHE = join(ROOT, 'data', 'tablebase-cache.jsonl');
export const SEED = 20261116;
export const PER_FAMILY = 60;
export const MAX_CANDIDATES = 600;
const USER_AGENT = 'chess-review-dev-script';
const API = 'https://tablebase.lichess.ovh/standard';
const GAP_MS = 600;
const RETRY_MS = [5_000, 15_000, 45_000];
const RATE_LIMIT_MS = 60_000;

// --- seeded random and squares: [file, rank], both 0..7 ---

function rng32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const inside = ([f, r]) => f >= 0 && f < 8 && r >= 0 && r < 8;
const name = ([f, r]) => 'abcdefgh'[f] + (r + 1);

/** Placement {wk, wr, wp?, bk, br, bp?} to a FEN, white to move; null when two pieces share a square. */
export function toFen(p) {
  const board = Array.from({ length: 8 }, () => Array(8).fill(''));
  const put = (sq, ch) => { if (!inside(sq) || board[sq[1]][sq[0]]) return false; board[sq[1]][sq[0]] = ch; return true; };
  const ok = put(p.wk, 'K') && put(p.wr, 'R') && (!p.wp || put(p.wp, 'P')) && put(p.bk, 'k') && put(p.br, 'r') &&
    (!p.bp || put(p.bp, 'p'));
  if (!ok) return null;
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let s = '', empty = 0;
    for (const c of board[r]) { if (c) { s += (empty || '') + c; empty = 0; } else empty++; }
    rows.push(s + (empty || ''));
  }
  return `${rows.join('/')} w - - 0 1`;
}

/** The position when it is legal, white to move, nobody in check, and white can't take the black rook (or, for
 *  Philidor, the pawn) on the spot; else null. */
function legalStart(fen, ending, p) {
  const setup = fenIO.parseFen(fen);
  if (setup.isErr) return null;
  const made = Chess.fromSetup(setup.unwrap());
  if (made.isErr) return null;
  const pos = made.unwrap();
  if (pos.isCheck()) return null;
  const free = [name(p.br)];
  if (ending === 'Philidor') free.push(name(p.bp));
  const moves = legalMoves(pos);
  if (!moves.length || moves.some(m => free.includes(makeSquare(m.to)))) return null;
  return { legal: moves.length };
}

// --- families ---

const sign = x => (x > 0) - (x < 0);
const pick = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const anySquare = rand => [pick(rand, 0, 7), pick(rand, 0, 7)];

/** The pawn file and the black king's, cut off by two files or more, and a file strictly between them. */
function cutOff(rand) {
  const p = pick(rand, 1, 3), side = rand() < 0.5 ? -1 : 1;
  const maxD = side > 0 ? 7 - p : p;
  if (maxD < 2) return null;
  const d = pick(rand, 2, maxD), cut = pick(rand, 1, d - 1);
  return { p, side, bf: p + side * d, rf: p + side * cut };
}

const LUCENA = [
  // L1 bridge: pawn on the 7th, king on the queening square, rook on the cutting file on ranks 1-3, black king cut
  // off, black rook two or more files from the pawn (on the other side from the black king when there is room)
  rand => {
    const c = cutOff(rand);
    if (!c) return null;
    const { p, side, bf, rf } = c;
    const files = [];
    for (let f = 0; f < 8; f++) {
      if (Math.abs(f - p) >= 2 && f !== rf && (sign(f - p) === -side || p - side * 2 < 0 || p - side * 2 > 7)) files.push(f);
    }
    const brf = files.length ? files[pick(rand, 0, files.length - 1)] : null;
    if (brf === null) return null;
    return { wp: [p, 6], wk: [p, 7], wr: [rf, pick(rand, 0, 2)], bk: [bf, pick(rand, 5, 7)], br: [brf, pick(rand, 0, 7)] };
  },
  // L2 cut first: pawn on the 7th, king on the queening square, black king two or more files away, rook anywhere
  // not on a file between them
  rand => {
    const p = pick(rand, 1, 3), side = rand() < 0.5 ? -1 : 1;
    const maxD = side > 0 ? 7 - p : p;
    if (maxD < 2) return null;
    const d = pick(rand, 2, maxD), bf = p + side * d;
    const wr = anySquare(rand);
    if (sign(wr[0] - p) === side && Math.abs(wr[0] - p) < d) return null;
    return { wp: [p, 6], wk: [p, 7], wr, bk: [bf, pick(rand, 4, 7)], br: anySquare(rand) };
  },
  // L3 sixth: pawn on the 6th, king on the 7th or 8th within one file of it, black king cut off
  rand => {
    const c = cutOff(rand);
    if (!c) return null;
    const { p, bf, rf } = c;
    return { wp: [p, 5], wk: [p + pick(rand, -1, 1), pick(rand, 6, 7)], wr: [rf, pick(rand, 0, 7)],
      bk: [bf, pick(rand, 4, 7)], br: anySquare(rand) };
  },
  // L4 fifth: pawn on the 5th, king within one square of it, black king cut off; promotion 10 or more moves away
  rand => {
    const c = cutOff(rand);
    if (!c) return null;
    const { p, bf, rf } = c;
    const wk = [p + pick(rand, -1, 1), 4 + pick(rand, -1, 1)];
    return { wp: [p, 4], wk, wr: [rf, pick(rand, 0, 7)], bk: [bf, pick(rand, 3, 7)], br: anySquare(rand) };
  },
];

const PHILIDOR = [
  // L1 third rank: pawn on the 4th, black king on rank 4-5 within a file of it, white king on its file (or next
  // to it) on rank 1-2, white rook on the 3rd
  rand => {
    const p = pick(rand, 1, 3);
    return { bp: [p, 3], bk: [p + pick(rand, -1, 1), pick(rand, 3, 4)], wk: [p + pick(rand, -1, 1), pick(rand, 0, 1)],
      wr: [pick(rand, 0, 7), 2], br: anySquare(rand) };
  },
  // L2 go behind: pawn on the 3rd, black king beside it, white king in its path, white rook on ranks 1-3
  rand => {
    const p = pick(rand, 1, 3);
    return { bp: [p, 2], bk: [p + (rand() < 0.5 ? -1 : 1), 2], wk: [p, pick(rand, 0, 1)],
      wr: [pick(rand, 0, 7), pick(rand, 0, 2)], br: anySquare(rand) };
  },
  // L3 in time: pawn on the 4th or 5th, white rook not on the 3rd, so it has to get there first
  rand => {
    const p = pick(rand, 1, 3), r = pick(rand, 3, 4);
    const wr = [pick(rand, 0, 7), pick(rand, 0, 7)];
    if (wr[1] === 2) return null;
    return { bp: [p, r], bk: [p + pick(rand, -1, 1), r + pick(rand, 0, 1)], wk: [p + pick(rand, -2, 2), pick(rand, 0, 1)],
      wr, br: anySquare(rand) };
  },
  // L4 off the path: pawn on the 4th or 5th, white king one or two files off the pawn's file, rook anywhere
  // (at most 3 drawing moves)
  rand => {
    const p = pick(rand, 1, 3), r = pick(rand, 3, 4), off = (rand() < 0.5 ? -1 : 1) * pick(rand, 1, 2);
    return { bp: [p, r], bk: [p + pick(rand, -1, 1), r + pick(rand, 0, 1)], wk: [p + off, pick(rand, 0, 2)],
      wr: anySquare(rand), br: anySquare(rand) };
  },
];

export const ENDINGS = {
  Lucena: { families: LUCENA, want: 'win', moveWant: 'loss' },
  Philidor: { families: PHILIDOR, want: 'draw', moveWant: 'draw' },
};

// --- the cache and the lichess calls ---

class Tablebase {
  constructor({ cache, offline, log }) {
    this.path = cache;
    this.offline = offline;
    this.log = log;
    this.map = new Map();
    this.date = null;
    this.requests = 0;
    this.lastStart = 0;
    if (existsSync(cache)) {
      for (const line of readFileSync(cache, 'utf8').split('\n')) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (row.meta) this.date = row.meta.date;
        else this.map.set(row.url, row);
      }
    }
    if (!this.date) {
      if (offline) throw new Error(`no cache at ${cache}`);
      this.date = new Date().toISOString().slice(0, 10);
      mkdirSync(dirname(cache), { recursive: true });
      appendFileSync(cache, JSON.stringify({ meta: { date: this.date } }) + '\n');
    }
  }

  /** The trimmed answer for a url, or null when the candidate is skipped (the cache remembers a skip). */
  async get(url, trim) {
    const hit = this.map.get(url);
    if (hit) return hit.skip ? null : hit.body;
    if (this.offline) throw new Error(`cache miss offline: ${url}`);
    let row;
    try {
      row = { url, body: trim(await this.fetchJson(url)) };
    } catch (e) {
      this.log(`SKIP ${url}: ${e.message}`);
      row = { url, skip: e.message };
    }
    this.map.set(url, row);
    appendFileSync(this.path, JSON.stringify(row) + '\n');
    return row.skip ? null : row.body;
  }

  async fetchJson(url) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastStart + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
      this.requests++;
      let failure;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (res.status === 429) { this.log('429, waiting 60 s'); await sleep(RATE_LIMIT_MS); attempt--; continue; }
        if (res.ok) return await res.json();
        if (res.status < 500) throw Object.assign(new Error(`${res.status}`), { final: true });
        failure = new Error(`${res.status}`);
      } catch (e) {
        if (e.final) throw e;
        failure = e;
      }
      if (attempt >= RETRY_MS.length) throw failure;
      this.log(`${failure.message}, retry in ${RETRY_MS[attempt] / 1000} s`);
      await sleep(RETRY_MS[attempt]);
    }
  }
}

const fenParam = fen => fen.replace(/ /g, '_');
const trimPosition = j => ({ category: j.category, dtz: j.dtz, moves: j.moves.map(m => [m.uci, m.category]) });
const trimMainline = j => ({ mainline: j.mainline.map(m => m.uci) });

/** White moves played up to and including the first promotion on a mainline, or null when there is none. */
export function movesToPromotion(ucis) {
  for (let i = 0; i < ucis.length; i += 2) if (ucis[i].length === 5) return i / 2 + 1;
  return null;
}

// --- one ending ---

const REASONS = ['skipped', 'not_wanted', 'no_changing_move', 'moves_mismatch', 'no_promotion', 'too_close', 'too_many_good'];

async function buildEnding(ending, tb, log) {
  const { families, want, moveWant } = ENDINGS[ending];
  const out = [], stats = [], seen = new Set();
  for (let k = 0; k < families.length; k++) {
    const family = `L${k + 1}`, rand = rng32(SEED + (ending === 'Lucena' ? 100 : 200) + k);
    const entries = [], rejected = Object.fromEntries(REASONS.map(r => [r, 0]));
    let tried = 0, draws = 0;
    while (entries.length < PER_FAMILY && tried < MAX_CANDIDATES && draws < 200_000) {
      draws++;
      const p = families[k](rand);
      if (!p) continue;
      const fen = toFen(p);
      if (!fen || seen.has(fen)) continue;
      const start = legalStart(fen, ending, p);
      if (!start) continue;
      seen.add(fen);
      tried++;
      const pos = await tb.get(`${API}?fen=${fenParam(fen)}`, trimPosition);
      if (!pos) { rejected.skipped++; continue; }
      if (pos.category !== want) { rejected.not_wanted++; continue; }
      const good = pos.moves.filter(([, c]) => c === moveWant).length;
      if (pos.moves.length !== start.legal) { rejected.moves_mismatch++; continue; }
      if (good === pos.moves.length) { rejected.no_changing_move++; continue; }
      if (ending === 'Philidor' && family === 'L4' && good > 3) { rejected.too_many_good++; continue; }
      let promote = null;
      if (ending === 'Lucena') {
        const line = await tb.get(`${API}/mainline?fen=${fenParam(fen)}`, trimMainline);
        if (!line) { rejected.skipped++; continue; }
        promote = movesToPromotion(line.mainline);
        if (promote === null) { rejected.no_promotion++; continue; }
        if (family === 'L4' && promote < 10) { rejected.too_close++; continue; }
      }
      entries.push({ fen, family, good, legal: start.legal, dtz: pos.dtz, promote });
    }
    stats.push({ ending, family, accepted: entries.length, tried, rejected });
    log(`${ending} ${family}: ${entries.length} accepted of ${tried} tried (${JSON.stringify(rejected)}), ` +
      `${tb.requests} requests so far`);
    out.push(entries);
  }
  return { levels: out, stats };
}

function render(built, tb) {
  const lines = [
    '// Start positions of the Lucena and Philidor drills. GENERATED by scripts/build_rook_starts.js, do not edit.',
    `// Seed ${SEED}, lichess tablebase answers of ${tb.date}. Per family: accepted (candidates tried; rejected by reason).`,
  ];
  for (const s of built.flatMap(b => b.stats)) {
    const why = Object.entries(s.rejected).filter(([, n]) => n).map(([r, n]) => `${r} ${n}`).join(', ');
    lines.push(`//   ${s.ending} ${s.family}: ${s.accepted} (${s.tried}${why ? '; ' + why : ''})`);
  }
  lines.push('// Entry: fen (white to move), family, good (moves that keep the result), legal (all moves), dtz, promote (Lucena:',
    '// white moves to the first promotion on the lichess mainline; null for Philidor). The pawn is on file b-d.',
    'export const ROOK_STARTS = {');
  built.forEach((b, i) => {
    lines.push(`  ${i ? 'Philidor' : 'Lucena'}: [`);
    for (const level of b.levels) {
      lines.push('    [');
      for (const e of level) lines.push(`      ${JSON.stringify(e)},`);
      lines.push('    ],');
    }
    lines.push('  ],');
  });
  lines.push('};', '');
  return lines.join('\n');
}

export async function build({ cache = DEFAULT_CACHE, offline = false, log = console.log } = {}) {
  const tb = new Tablebase({ cache, offline, log });
  const built = [await buildEnding('Lucena', tb, log), await buildEnding('Philidor', tb, log)];
  return { text: render(built, tb), stats: built.flatMap(b => b.stats), requests: tb.requests };
}

export function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, cache: DEFAULT_CACHE, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a.startsWith('--out=')) opts.out = resolve(a.slice(6));
    else if (a === '--cache') opts.cache = resolve(argv[++i]);
    else if (a.startsWith('--cache=')) opts.cache = resolve(a.slice(8));
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const r = await build({ cache: opts.cache, offline: opts.offline });
  writeFileSync(opts.out, r.text);
  const short = r.stats.filter(s => s.accepted < PER_FAMILY);
  console.log(`wrote ${opts.out}: ${r.requests} requests, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const s of short) console.log(`SHORT ${s.ending} ${s.family}: ${s.accepted} of ${PER_FAMILY}`);
  if (short.length) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
