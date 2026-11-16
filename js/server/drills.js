// The endgame drills' record and progression ("Develop your instinct", docs/training-grounds.md), modelled on
// puzzles.js: a record of every attempt, the level of each ending worked out from it (never stored), and the next
// start position dealt at that level (core/drills.js does the dealing; the tables it reads are loaded here).
//
// The record is progress.sqlite's drill_attempts table (db.js DRILL_ATTEMPTS_SCHEMA), one row an attempt, in the
// order they were made (seq): {id, ts, ending, level, fen, dtm, budget, moves_used, result, ms, worst_loss}. The
// six endings (core/drills.js ENDINGS) each have a level of their own.
//
// Results. A mate drill (KQRK, KRRK, KQK, KRK) is 'solved', or failed by 'stalemate', 'piece_lost', 'repetition',
// 'fifty' or 'budget'. The KPK attack is 'promoted', or failed by 'threw' (a move gave the win away), 'pawn_lost',
// 'stalemate', 'repetition' or 'fifty'. The KPK defence ('KPK-hold') is held by 'held', 'pawn_taken' or 'stalemate',
// or failed by 'threw' (a move gave the draw away) or 'promoted'. 'abandoned' fails any of them (the drill left
// unfinished). A KPK ending has no mate distance and no budget: dtm and budget are null. worst_loss is the moves the
// costliest move cost, -1 when no move lost ground, null when a move threw the result (so always null for 'threw').
//
// The level, from the record, per ending, in the order the attempts were made:
//   - everyone starts at level 1;
//   - only attempts made at the level the ending is at count towards moving; an attempt at another level (a chosen
//     practice level) stays on the record and moves nothing;
//   - the "run" is the attempts at the current level since arriving at it, the last 4 of them;
//   - 3 solved in the run: up one level (never above the ending's top level, LEVELS[ending].length);
//   - otherwise the last 2 of the run both failed: down one level (never below 1);
//   - moving clears the run, so each level is earned afresh and a fall can't bounce straight back.
// The star: an ending has it once an attempt at its top level was solved. It stays: a later fall doesn't take it
// away, and reaching the top by solving the level below doesn't earn it.
//
// Tables: `tables` below is a DrillTables, which loads an ending's tables the first time they're asked for and keeps
// them. What it loads from is injected (load(name) → {name, data}): tablesFromFiles() reads the .bin files, a test
// gives it small generated tables or a fake.

import { DEPENDS, gunzip, unpack } from '../core/endgame-table.js';
import { boardFromFen } from '../core/chess.js';
import { ENDINGS, HOLD_MOVES, LEVELS, RECENT, levelOf, pickStart, positionKey } from '../core/drills.js';
import { DRILL_ATTEMPTS_SCHEMA } from './db.js';
import { BadRequest } from './http.js';

export const RUN = 4;           // the attempts at a level that count towards moving up
export const UP = 3;            // solved in the run: up a level
export const DOWN = 2;          // failed in a row: down a level
export const RECENT_SHOWN = 10; // the status lists this many attempts

export const RESULTS = {
  mate: { solved: ['solved'], failed: ['stalemate', 'piece_lost', 'repetition', 'fifty', 'budget', 'abandoned'] },
  KPK: { solved: ['promoted'], failed: ['threw', 'pawn_lost', 'stalemate', 'repetition', 'fifty', 'abandoned'] },
  'KPK-hold': { solved: ['held', 'pawn_taken', 'stalemate'], failed: ['threw', 'promoted', 'abandoned'] },
};
const kindOf = ending => (ending === 'KPK' || ending === 'KPK-hold' ? ending : 'mate');
const isPawnEnding = ending => ending === 'KPK' || ending === 'KPK-hold';

export const isEnding = e => typeof e === 'string' && Object.hasOwn(LEVELS, e);
export const topLevel = ending => LEVELS[ending].length;
export const isSolved = (ending, result) => RESULTS[kindOf(ending)].solved.includes(result);

const COLUMNS = 'id, ts, ending, level, fen, dtm, budget, moves_used, result, ms, worst_loss';

// ---------- the record and the level ----------

/** The record (every ending's, or one's) in the order the attempts were made. */
export function attempts(db, ending = null) {
  return ending === null
    ? db.all(`SELECT ${COLUMNS} FROM drill_attempts ORDER BY seq`)
    : db.all(`SELECT ${COLUMNS} FROM drill_attempts WHERE ending = ? ORDER BY seq`, [ending]);
}

/** Where an ending stands after `rows` (its attempts, in order): {level, top, star, run}, run being the results of
 * the run as booleans (solved or not), oldest first. See the top of this file for the rules. */
export function progress(ending, rows) {
  const top = topLevel(ending);
  let level = 1, run = [], star = false;
  for (const r of rows) {
    const ok = isSolved(ending, r.result);
    if (ok && r.level === top) star = true;
    if (r.level !== level) continue;
    run.push(ok);
    if (run.length > RUN) run.shift();
    if (level < top && run.filter(Boolean).length >= UP) {
      level++;
      run = [];
    } else if (level > 1 && run.length >= DOWN && run.slice(-DOWN).every(x => !x)) {
      level--;
      run = [];
    }
  }
  return { level, top, star, run };
}

/** One ending's standing and its last attempts. */
export function status(db, ending, rows = attempts(db, ending)) {
  const p = progress(ending, rows);
  const recent = rows.slice(-RECENT_SHOWN).map(r => ({ id: r.id, ts: r.ts, level: r.level, result: r.result,
    solved: isSolved(ending, r.result), moves_used: r.moves_used, ms: r.ms, worst_loss: r.worst_loss }));
  return { ending, level: p.level, top: p.top, star: p.star, played: rows.length,
    solved: rows.filter(r => isSolved(ending, r.result)).length, run: p.run, recent };
}

/** The status of every ending, in ENDINGS' order. */
export function statuses(db) {
  const all = attempts(db), by = new Map(ENDINGS.map(e => [e, []]));
  for (const r of all) by.get(r.ending)?.push(r);     // a row of an ending this version doesn't know is ignored
  return ENDINGS.map(e => status(db, e, by.get(e)));
}

// ---------- recording an attempt ----------

const int = (v, what, { min = 0, max = 1e9, nullable = false } = {}) => {
  if (v === null || v === undefined) {
    if (nullable) return null;
    throw new BadRequest(`${what} is required`);
  }
  if (!Number.isInteger(v) || v < min || v > max) throw new BadRequest(`${what}: an integer from ${min} to ${max} expected`);
  return v;
};

/** The attempt in a request body, checked and cleaned: {id|null, ending, level, fen, dtm, budget, moves_used,
 * result, ms, worst_loss}; a BadRequest says what's wrong. */
export function parseAttempt(b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('an attempt object expected');
  if (!isEnding(b.ending)) throw new BadRequest(`ending: one of ${ENDINGS.join(', ')}`);
  const ending = b.ending, pawn = isPawnEnding(ending);
  const level = int(b.level, 'level', { min: 1, max: topLevel(ending) });
  levelOf(ending, level);
  if (typeof b.fen !== 'string' || b.fen.length > 100) throw new BadRequest('fen: a position expected');
  try {
    boardFromFen(b.fen);
  } catch {
    throw new BadRequest(`fen: not a position: ${b.fen}`);
  }
  const key = positionKey(b.fen), want = `${pawn ? 'KPK' : ending}:${ending === 'KPK-hold' ? 'b' : 'w'}:`;
  if (!key?.startsWith(want)) throw new BadRequest(`fen: not a ${ending} start position: ${b.fen}`);
  const ok = RESULTS[kindOf(ending)];
  if (typeof b.result !== 'string' || ![...ok.solved, ...ok.failed].includes(b.result)) {
    throw new BadRequest(`result: one of ${[...ok.solved, ...ok.failed].join(', ')} for ${ending}`);
  }
  let dtm = null, budget = null;
  if (pawn) {
    if (b.dtm != null || b.budget != null) throw new BadRequest(`${ending} has no dtm or budget`);
  } else {
    dtm = int(b.dtm, 'dtm', { max: 100 });
    budget = int(b.budget, 'budget', { max: 1000 });
  }
  const worst = int(b.worst_loss, 'worst_loss', { min: -1, max: 1000, nullable: true });
  if (b.result === 'threw' && worst !== null) throw new BadRequest('worst_loss is null when a move threw the result');
  let id = null;
  if (b.id !== undefined && b.id !== null) {
    if (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.id)) throw new BadRequest('id: up to 64 letters, digits, - and _');
    id = b.id;
  }
  return { id, ending, level, fen: b.fen, dtm, budget, moves_used: int(b.moves_used, 'moves_used', { max: 1000 }),
    result: b.result, ms: int(b.ms, 'ms', { max: 1e10, nullable: true }), worst_loss: worst };
}

const nowSeconds = () => Date.now() / 1000;
const newId = () => globalThis.crypto.randomUUID();

/** Append an attempt (from parseAttempt). A second report with an id already on the record is ignored, so a retry
 * does no harm. Returns {counted, id, before, status}: `before` the level it was made at, as the record had it. */
export function record(db, a, now = nowSeconds(), makeId = newId) {
  return db.tx(() => {
    const rows = attempts(db, a.ending);
    const id = a.id ?? makeId();
    if (db.value('SELECT count(*) FROM drill_attempts WHERE id = ?', [id])) {
      return { counted: false, id, before: progress(a.ending, rows).level, status: status(db, a.ending, rows) };
    }
    const row = { id, ts: Math.floor(now), ending: a.ending, level: a.level, fen: a.fen, dtm: a.dtm, budget: a.budget,
      moves_used: a.moves_used, result: a.result, ms: a.ms, worst_loss: a.worst_loss };
    db.insert('drill_attempts', DRILL_ATTEMPTS_SCHEMA, [row]);
    return { counted: true, id, before: progress(a.ending, rows).level, status: status(db, a.ending, [...rows, row]) };
  });
}

// ---------- the tables ----------

/** The names of the tables an ending reads, the ones it depends on first. */
export function tablesFor(ending) {
  if (!isEnding(ending)) throw new RangeError(`unknown ending ${ending}`);
  const out = [], add = n => {
    if (out.includes(n)) return;
    DEPENDS[n].forEach(add);
    out.push(n);
  };
  add(ending === 'KPK-hold' ? 'KPK' : ending);
  return out;
}

/** The tables of the endings, loaded when first asked for and kept. load(name) → {name, data} (async; may throw
 * while the files aren't there, and is asked again next time). */
export class DrillTables {
  constructor(load) {
    this.load = load;
    this.cache = new Map();     // name → Promise<table>
  }

  table(name) {
    if (!this.cache.has(name)) {
      const p = Promise.resolve().then(() => this.load(name));
      this.cache.set(name, p);
      p.catch(() => this.cache.delete(name));
    }
    return this.cache.get(name);
  }

  /** {name: table} for the ending and what it depends on, the form core/drills.js takes. */
  async get(ending) {
    const out = {};
    for (const n of tablesFor(ending)) out[n] = await this.table(n);
    return out;
  }
}

/** A DrillTables load function over a reader: read(path) → bytes, or null when there is no such file (profiles-files
 * `readBytes`, a fetch). The files are the build script's: <dir>/kqk.bin, gzipped or not. */
export function tablesFromFiles(read, dir = 'endgames') {
  return async name => {
    let bytes = await read(`${dir}/${name.toLowerCase()}.bin`);
    if (bytes == null) throw new Error(`no ${name} table file`);
    bytes = new Uint8Array(bytes);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    const t = unpack(bytes);
    if (t.name !== name) throw new Error(`${dir}/${name.toLowerCase()}.bin holds the ${t.name} table`);
    return t;
  };
}

// ---------- the next drill ----------

/** The drill dealt at the level the record puts an ending at (or `level`, a practice level): {drill, level, status},
 * the drill {ending, level, mode, fen, dtm, budget, counter, hold_moves} or null when no start position turns up
 * (pickStart gives up; the caller says so). `tables` is what DrillTables.get(ending) gave. The positions of the last
 * RECENT attempts at the ending aren't dealt again, and the attempts so far turn the zones. */
export function nextDrill(db, tables, ending, { level = null, rng = Math.random } = {}) {
  const rows = attempts(db, ending), st = status(db, ending, rows), at = level ?? st.level;
  const row = levelOf(ending, at);
  const recent = rows.slice(-RECENT).map(r => positionKey(r.fen)).filter(Boolean);
  const start = pickStart(tables, ending, at, { rng, recent, turn: rows.length });
  if (!start) return { drill: null, level: at, status: st };
  const mode = ending === 'KPK' ? 'attack' : ending === 'KPK-hold' ? 'hold' : 'mate';
  const drill = { ending, level: at, mode, fen: start.fen, dtm: start.dtm, budget: start.budget, counter: row.counter,
    hold_moves: mode === 'hold' ? HOLD_MOVES : null };
  return { drill, level: at, status: st };
}
