// Builds the endgame tables the "Develop your instinct" drills read (js/core/endgame-table.js) into data/endgames/.
//
//   node scripts/build_endgame_tables.js [names...] [--out data/endgames] [--check[=200]] [--force]
//
// Each table is generated (its DEPENDS first), checked against the known longest mate and the position counts below,
// and written as <name>.bin, lowercase: gzip, level 9, of pack()'s header and bytes. A stamp (a hash of
// endgame-table.js and the format version) is written next to them, and a later run with the same stamp and every
// file there does nothing, so build scripts can call ensureTables() each time. --force builds anyway.
//
// --check also asks the lichess tablebase about random positions (seeded, both sides to move, one request at a time,
// a pause between them and a minute's wait when it says 429) and compares the result, and the distance to mate where
// lichess gives one. It's for a person to run once after changing the generator, never from tests, builds or CI.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { DEPENDS, decode, generate, pack, probe, tableSize, toFen, transform } from '../js/core/endgame-table.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'js', 'core', 'endgame-table.js');
const FORMAT_VERSION = 1;
const STAMP = 'endgames.stamp';

export const NAMES = ['KQK', 'KRK', 'KPK', 'KQRK', 'KRRK', 'KBBK', 'KBNK', 'KQKR', 'KRKR'];
export const DEFAULT_OUT = join(ROOT, 'data', 'endgames');

// what a correct table has (white to move; mates and stalemates over both sides' positions); see the test
const EXPECT = {
  KQK: { maxMoves: 10, wins: 22589, mates: 55, stalemates: 132 },
  KRK: { maxMoves: 16, wins: 27352, mates: 32, stalemates: 9 },
  KPK: { maxMoves: 28, wins: 62480, lossesB: 48802, stalemates: 11 },
  KQRK: { maxMoves: 6, wins: 1080257, mates: 35617 },
  KRRK: { maxMoves: 7, wins: 1299964, mates: 22644 },
  KBBK: { maxMoves: 19, wins: 783438, mates: 442, stalemates: 2848 },
  KBNK: { maxMoves: 33, wins: 1691479, mates: 65, stalemates: 1767 },
  // lichess: the longest, 8/8/8/8/2r5/8/2k5/K6Q w and 8/8/8/8/8/1R6/6r1/K1k5 w, are dtm 69 and 37 plies
  KQKR: { maxMoves: 35, wins: 1385461, mates: 1698, matedW: 402, stalemates: 0 },
  KRKR: { maxMoves: 19, wins: 490657, mates: 743, matedW: 826, stalemates: 0 },
};

export const fileName = name => `${name.toLowerCase()}.bin`;

export function stamp() {
  return createHash('sha256').update(readFileSync(SOURCE)).update(`format ${FORMAT_VERSION}`).digest('hex');
}

/** The names with everything they depend on, dependencies first. */
function withDepends(names) {
  const out = [];
  const add = n => {
    if (!DEPENDS[n]) throw new Error(`unknown ending ${n}`);
    if (out.includes(n)) return;
    DEPENDS[n].forEach(add);
    out.push(n);
  };
  names.forEach(add);
  return out;
}

function verify(table) {
  const want = EXPECT[table.name] ?? {};
  for (const [k, v] of Object.entries(want)) {
    if (table.stats[k] !== v) throw new Error(`${table.name}: ${k} is ${table.stats[k]}, expected ${v}`);
  }
}

/** Builds the tables into `dir` unless they're there already with a matching stamp. Returns {built, ms, tables}. */
export function ensureTables(dir = DEFAULT_OUT, { names = NAMES, force = false, log = () => {} } = {}) {
  const all = withDepends(names);
  const stampFile = join(dir, STAMP), want = stamp();
  const fresh = existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === want
    && all.every(n => existsSync(join(dir, fileName(n))));
  if (fresh && !force) return { built: false, ms: 0, tables: {} };
  mkdirSync(dir, { recursive: true });
  const start = Date.now(), tables = {};
  for (const name of all) {
    const t0 = Date.now();
    tables[name] = generate(name, tables);
    verify(tables[name]);
    const gz = gzipSync(pack(tables[name]), { level: 9 });
    writeFileSync(join(dir, fileName(name)), gz);
    const s = tables[name].stats;
    log(`${name}: mate in at most ${s.maxMoves} (${toFen(decode(name, s.maxIndex))}), ${Date.now() - t0} ms, `
      + `${gz.length} bytes`);
  }
  writeFileSync(stampFile, want + '\n');
  return { built: true, ms: Date.now() - start, tables };
}

// --- the lichess check ---

function rng32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function lichess(fen) {
  const url = `https://tablebase.lichess.ovh/standard?fen=${fen.replace(/ /g, '_')}`;
  for (;;) {
    const res = await fetch(url, { headers: { 'User-Agent': 'endgame-table-check' } });
    if (res.status === 429) { await sleep(60_000); continue; }
    if (!res.ok) throw new Error(`${res.status} for ${fen}`);
    return res.json();
  }
}

async function check(tables, names, count, log) {
  const rand = rng32(20261116);
  let bad = 0;
  for (let k = 0; k < count; k++) {
    const name = names[k % names.length];
    let pos, ours;
    do {
      const p = decode(name, Math.floor(rand() * tableSize(name)));
      const t = name.includes('P') ? Math.floor(rand() * 2) : Math.floor(rand() * 8);
      pos = { ...p, wk: transform(t, p.wk), bk: transform(t, p.bk), pieces: p.pieces.map(s => transform(t, s)),
        turn: rand() < 0.5 ? 'w' : 'b' };
      ours = probe(tables, pos);
    } while (ours.result === 'illegal');
    const fen = toFen(pos), theirs = await lichess(fen);
    // our 0 is "white doesn't win", which with a black rook may be black winning; a cursed win (or blessed loss) is a
    // win past the fifty-move rule, which our tables ignore, so it's a mismatch to look at
    const categories = pos.turn === 'w'
      ? (ours.result === 'win' ? ['win'] : ['draw', 'loss', 'blessed-loss', 'maybe-loss'])
      : (ours.result === 'loss' || ours.result === 'mate' ? ['loss'] : ['draw', 'win', 'cursed-win', 'maybe-win']);
    let ok = categories.includes(theirs.category);
    if (ok && theirs.dtm != null && ours.dtm != null) {
      const plies = pos.turn === 'w' ? 2 * ours.dtm - 1 : 2 * ours.dtm;
      ok = Math.abs(theirs.dtm) === plies;
    }
    if (!ok) { bad++; log(`MISMATCH ${fen}: ours ${JSON.stringify(ours)}, lichess ${theirs.category} dtm ${theirs.dtm}`); }
    await sleep(150);
  }
  log(`checked ${count} positions, ${bad} mismatches`);
  return bad;
}

export function parseArgs(argv) {
  const opts = { names: [], out: DEFAULT_OUT, check: 0, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--check') opts.check = 200;
    else if (a.startsWith('--check=')) opts.check = Number(a.slice(8));
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a.startsWith('--out=')) opts.out = resolve(a.slice(6));
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.names.push(a.toUpperCase());
  }
  if (!Number.isInteger(opts.check) || opts.check < 0) throw new Error('--check takes a count');
  if (!opts.names.length) opts.names = NAMES;
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = s => console.log(s);
  const r = ensureTables(opts.out, { names: opts.names, force: opts.force || opts.check > 0, log });
  console.log(r.built ? `built in ${(r.ms / 1000).toFixed(1)} s into ${opts.out}` : `up to date in ${opts.out}`);
  if (opts.check && await check(r.tables, opts.names, opts.check, log)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
