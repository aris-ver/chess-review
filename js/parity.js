// Test helpers for replaying the parity dumps (tests/parity/*.json): the Python app wrote them; frozen since it went.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

export const load = (name, dir = PARITY) => JSON.parse(readFileSync(dir + name, 'utf8'));

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
  if (at) assert.fail(`${at} differs\n  js:     ${JSON.stringify(pick(actual, at, what))}\n  python: ${JSON.stringify(pick(expected, at, what))}`);
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
    const f = extract(m, boardFromFen(before.fen), before, after, c.multipv[before.fen_key] ?? null);
    same(f, c.facts[m.ply], `${name}.facts[${m.ply}]`);
    same(comment(f, m.in_book ? c.game.opening_name : null), c.comments[m.ply], `${name}.comments[${m.ply}]`);
  }
  const byPly = Object.fromEntries(c.moves.map(m => [m.ply, m]));
  for (const cr of c.critical) {
    const before = at(cr.ply), after = at(cr.ply + 1);
    const f = extract(byPly[cr.ply], boardFromFen(before.fen), before, after);
    const e = c.explain[cr.ply];
    same(f, e.facts, `${name}.explain[${cr.ply}].facts`);
    same(headline(f), e.headline, `${name}.explain[${cr.ply}].headline`);
    same(explain(f), e.text, `${name}.explain[${cr.ply}].text`);
    same(moveLabel(cr.ply, byPly[cr.ply].san), e.move, `${name}.explain[${cr.ply}].move`);
  }
  for (const side of ['white', 'black']) same(gameAccuracy(c.moves, side), c.accuracy[side], `${name}.accuracy.${side}`);
  return moves;
}

/** checkGame with the dump's own book membership as the book. */
export function checkDumpedGame(c) {
  setBook(c.book);
  return checkGame(c);
}
