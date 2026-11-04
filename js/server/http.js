// What every route module shares: answers in serve.Handler's shape and Python's ways with request values (repr, int,
// truthiness, the errors that become a 400). router.js and the routes-*.js modules import these.

import { IllegalMoveError } from './explore.js';
import { InvalidMoveError, IllegalMoveError as IllegalUciError } from '../core/chess.js';

export const ID = '[A-Za-z0-9_.-]+';

export const json = (obj, status = 200) => ({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
export const notFound = () => ({ status: 404, headers: { 'Content-Type': 'text/html;charset=utf-8' }, body: 'File not found' });

/** Python's repr() of a str, for the messages that quote one. */
export const pyRepr = s => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);

/** A request the handler refuses with 400 (Python's ValueError or KeyError). */
export class BadRequest extends Error {}

/** Python's int() of a JSON value: ints, floats (truncated) and numeric strings; anything else is a ValueError. */
export function pyInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^\s*[-+]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new BadRequest(`invalid literal for int() with base 10: ${pyRepr(String(v))}`);
}

/** Python's truthiness, for bool(b.get(...)). */
export const truthy = v => !(v === undefined || v === null || v === false || v === 0 || v === '' ||
  (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length));

export const badInput = e => e instanceof BadRequest || e instanceof IllegalMoveError || e instanceof InvalidMoveError ||
  e instanceof IllegalUciError || e?.name === 'FenError' || e instanceof TypeError;

const decoder = new TextDecoder();
/** The request body as text ('' when there is none). */
export const text = body => (body == null ? '' : typeof body === 'string' ? body : decoder.decode(body));

/** The JSON body, {} when there is none (serve.Handler._body). */
export function jsonBody(raw) {
  const t = text(raw);
  return t ? JSON.parse(t) : {};
}
