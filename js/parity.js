// Test helpers for replaying the parity dumps (tests/parity/*.json): the Python app wrote them; frozen since it went.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { gameAccuracy } from './core/accuracy.js';
import { setBook } from './core/book.js';
import { boardFromFen } from './core/chess.js';
import { classifyGame } from './core/classify.js';
import { select } from './core/critical.js';
import { comment, explain, headline, moveLabel } from './core/explain.js';
import { extract } from './core/facts.js';

export const PARITY = fileURLToPath(new URL('../tests/parity/', import.meta.url));
export const GOLDEN = fileURLToPath(new URL('../tests/golden/', import.meta.url));

export const load = (name, dir = PARITY) => loadPath(dir + name);

// --- PARITY_UPDATE=1: a labelling change rewrites the dumps --------------------------------------------------------
//
// The dumps are frozen, but a deliberate change of the rules changes what they should hold. With PARITY_UPDATE=1 set,
// `same` copies what JS computed into the loaded dump instead of failing, and on exit every dump that changed is
// written back in its own format (Python's json.dumps, ensure_ascii=False: compact or indent 1), each untouched number
// as it was written (52.0 stays 52.0). Run the suite twice: the second run must pass without it.

const UPDATE = Boolean(process.env.PARITY_UPDATE);
const loaded = [];   // [{file, text, value, numbers}] when UPDATE
let updating = UPDATE;

/** Is PARITY_UPDATE on? */
export const updatingDumps = () => UPDATE;

/** Run `fn` with same() failing as usual even under PARITY_UPDATE: for comparisons that only hold up to an order
 * or a tie, where the caller replaces the whole value itself when they fail. */
export function strict(fn) {
  const was = updating;
  updating = false;
  try {
    return fn();
  } finally {
    updating = was;
  }
}

/** A dump by path (the local ones are read by the tests themselves). */
export function loadPath(file) {
  const text = readFileSync(file, 'utf8');
  if (!UPDATE) return JSON.parse(text);
  const numbers = new Map();
  const value = parseKeepingNumbers(text, numbers);
  loaded.push({ file, text, value, numbers });
  return value;
}

/** JSON.parse that also records each number's source text by its path (`numbers`: path -> text). */
function parseKeepingNumbers(text, numbers) {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i])) i++; };
  const value = path => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const out = {};
      ws();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws();
        const key = string();
        ws();
        i++;                          // :
        out[key] = value(`${path}.${key}`);
        ws();
        if (text[i++] === '}') return out;
      }
    }
    if (ch === '[') {
      i++;
      const out = [];
      ws();
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value(`${path}[${out.length}]`));
        ws();
        if (text[i++] === ']') return out;
      }
    }
    if (ch === '"') return string();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 40));
    i += m[0].length;
    if (m[0] === 'true' || m[0] === 'false' || m[0] === 'null') return JSON.parse(m[0]);
    numbers.set(path, m[0]);
    return Number(m[0]);
  };
  const string = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    return JSON.parse(text.slice(start, ++i));
  };
  return value('');
}

/** Python's json.dumps of `value` in the format `text` was written in, numbers as `numbers` had them. */
function dumpLike(value, text, numbers) {
  const indented = /^[[{]\r?\n/.test(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const floatKeys = new Set();          // paths (indices dropped) whose numbers Python wrote as floats
  for (const [p, src] of numbers) if (/[.eE]/.test(src)) floatKeys.add(p.replace(/\[\d+\]/g, '[]'));
  const ascii = !/[^\x00-\x7f]/.test(text);   // some dumps were written with ensure_ascii=False (UTF-8 as it is), some not
  const str = s => ascii ? JSON.stringify(s).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    : JSON.stringify(s);
  const num = (v, path) => {
    const src = numbers.get(path);
    if (src !== undefined && Number(src) === v) return src;
    const s = JSON.stringify(v);
    return Number.isInteger(v) && (src !== undefined ? /[.eE]/.test(src) : floatKeys.has(path.replace(/\[\d+\]/g, '[]')))
      ? `${s}.0` : s;
  };
  const out = (v, path, depth) => {
    if (v === null || typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return num(v, path);
    if (typeof v === 'string') return str(v);
    const arr = Array.isArray(v);
    const items = arr ? v.map((x, k) => out(x, `${path}[${k}]`, depth + 1))
      : Object.keys(v).filter(k => v[k] !== undefined).map(k => `${str(k)}${indented ? ': ' : ':'}${out(v[k], `${path}.${k}`, depth + 1)}`);
    const [open, close] = arr ? ['[', ']'] : ['{', '}'];
    if (!items.length) return open + close;
    if (!indented) return open + items.join(',') + close;
    const pad = ' '.repeat(depth + 1);
    return `${open}\n${pad}${items.join(`,\n${pad}`)}\n${' '.repeat(depth)}${close}`;
  };
  const body = out(value, '', 0).replace(/\n/g, eol);
  return text.endsWith('\n') ? body + eol : body;
}

/** Copy `actual` into `expected` in place, leaving equal parts (and their numbers' text) alone. */
function sync(actual, expected) {
  for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!diff(actual[k], expected[k], '.')) continue;
    const a = actual[k], e = expected[k];
    if (a && e && typeof a === 'object' && typeof e === 'object' && Array.isArray(a) === Array.isArray(e)) sync(a, e);
    else if (a === undefined) delete expected[k];
    else expected[k] = structuredClone(a);
  }
  if (Array.isArray(expected) && expected.length > actual.length) expected.length = actual.length;
}

if (UPDATE) {
  process.on('exit', () => {
    for (const d of loaded) {
      const text = dumpLike(d.value, d.text, d.numbers);
      if (text !== d.text) writeFileSync(d.file, text);
    }
  });
}

/** The local dumps (your own games, gitignored), if an old checkout wrote any (the Python dump_parity.py --local). */
export function localDumps() {
  const dir = PARITY + 'local/';
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^games-.*\.json$/.test(f)).sort().map(f => dir + f);
}

/** Float results may differ from Python's in the last bits (Math.exp is not libm's exp); everything else is exact. */
function close(a, b) {
  return Number.isInteger(a) && Number.isInteger(b) ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

function diff(actual, expected, path) {
  if (typeof expected === 'number' && typeof actual === 'number') return close(actual, expected) ? null : path;
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected) || actual === expected ? null : path;
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) return path;
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  if (Array.isArray(expected) && actual.length !== expected.length) return `${path}.length`;
  for (const k of keys) {
    const d = diff(actual[k], expected[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** deepStrictEqual, with floats compared to 1e-9 relative; the message names the first differing path. */
export function same(actual, expected, what = 'value') {
  const at = diff(actual, expected, what);
  if (at && updating && expected !== null && typeof expected === 'object' && actual !== null && typeof actual === 'object') {
    sync(actual, expected);
    return;
  }
  if (at) assert.fail(`${at} differs\n  js:     ${JSON.stringify(pick(actual, at, what))}\n  python: ${JSON.stringify(pick(expected, at, what))}`);
}

/** same() for a value held at holder[key]: with PARITY_UPDATE a string or number can be replaced too. */
export function sameAt(actual, holder, key, what = 'value') {
  if (updating && diff(actual, holder[key], what)) {
    holder[key] = structuredClone(actual);
    return;
  }
  same(actual, holder[key], what);
}

/** same(scrub(actual), scrub(expected)); with PARITY_UPDATE the raw `expected` takes what differs after scrubbing,
 * leaving the parts scrub hides (times, ids) as they were. */
export function sameScrubbed(actual, expected, scrub, what = 'value') {
  const a = scrub(actual), e = scrub(expected);
  if (updating && diff(a, e, what) && actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    syncScrubbed(actual, expected, a, e);
    return;
  }
  same(a, e, what);
}

function syncScrubbed(actual, expected, a, e) {
  for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!diff(a[k], e[k], '.')) continue;
    const x = actual[k], y = expected[k];
    if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
      syncScrubbed(x, y, a[k], e[k]);
    } else if (x === undefined) delete expected[k];
    else expected[k] = structuredClone(x);
  }
  if (Array.isArray(expected) && expected.length > actual.length) expected.length = actual.length;
}

function pick(obj, path, root) {
  for (const k of path.slice(root.length).split('.').filter(Boolean)) obj = obj?.[k === 'length' ? k : k];
  return obj;
}

/** Everything the review builds on a classified game, recomputed in JS and compared with the Python dump. */
export function checkGame(c) {
  const name = c.name;
  const moves = classifyGame(c.game, c.rows, c.multipv);
  same(moves, c.moves, `${name}.moves`);
  same(select(moves), c.critical, `${name}.critical`);
  const at = ply => c.rows[ply - c.rows[0].ply];
  for (const m of c.moves) {
    if (!m.label) continue;
    const before = at(m.ply), after = at(m.ply + 1);
    const f = extract(m, boardFromFen(before.fen), before, after, c.multipv[before.fen_key] ?? null, at(m.ply - 1) ?? null);
    sameAt(f, c.facts, m.ply, `${name}.facts[${m.ply}]`);
    sameAt(comment(f, m.in_book ? c.game.opening_name : null), c.comments, m.ply, `${name}.comments[${m.ply}]`);
  }
  const byPly = Object.fromEntries(c.moves.map(m => [m.ply, m]));
  for (const cr of c.critical) {
    const before = at(cr.ply), after = at(cr.ply + 1);
    const f = extract(byPly[cr.ply], boardFromFen(before.fen), before, after);
    const e = UPDATE ? (c.explain[cr.ply] ??= {}) : c.explain[cr.ply];   // a ply that has just become critical
    sameAt(f, e, 'facts', `${name}.explain[${cr.ply}].facts`);
    sameAt(headline(f), e, 'headline', `${name}.explain[${cr.ply}].headline`);
    sameAt(explain(f), e, 'text', `${name}.explain[${cr.ply}].text`);
    sameAt(moveLabel(cr.ply, byPly[cr.ply].san), e, 'move', `${name}.explain[${cr.ply}].move`);
  }
  for (const side of ['white', 'black']) sameAt(gameAccuracy(c.moves, side), c.accuracy, side, `${name}.accuracy.${side}`);
  return moves;
}

/** checkGame with the dump's own book membership as the book. */
export function checkDumpedGame(c) {
  setBook(c.book);
  return checkGame(c);
}
