// The endgame drills' record and progression ("Develop your instinct", docs/training-grounds.md), modelled on
// puzzles.js: a record of every attempt, the level of each ending worked out from it (never stored), and the next
// start position dealt at that level (core/drills.js does the dealing; the tables it reads are loaded here).
//
// The record is progress.sqlite's drill_attempts table (db.js DRILL_ROW), one row an attempt, in the order they were
// made (ts, then seq; the merged order after a sync): {id, ts, ending, level, fen, dtm, budget, moves_used, result,
// ms, worst_loss, clock, move_ms, paused}. The ten endings (core/drills.js ENDINGS) each have a level of their own.
//
// Results. A mate drill (KQRK, KRRK, KQK, KRK, KBBK, KBNK) is 'solved', or failed by 'stalemate', 'piece_lost',
// 'repetition', 'fifty' or 'budget'. The KPK attack is 'promoted', or failed by 'threw' (a move gave the win away), 'pawn_lost',
// 'stalemate', 'repetition' or 'fifty'. The KPK defence ('KPK-hold') is held by 'held', 'pawn_taken' or 'stalemate',
// or failed by 'threw' (a move gave the draw away) or 'promoted'. 'abandoned' fails any of them (the drill left
// unfinished). A KPK ending has no mate distance and no budget: dtm and budget are null. worst_loss is the moves the
// costliest move cost, -1 when no move lost ground, null when a move threw the result (so always null for 'threw').
// The rook endings, Lucena and Philidor (core/rook-drills.js, Stockfish plays black), have their results in
// ROOK_RESULTS; dtm and worst_loss are always null, budget is the start's promote + the level's slack for Lucena and
// null for Philidor, and the fen is a ROOK_STARTS entry of the level (or its mirror).
// The clock (core/drill-clock.js): above each ending's top level are its timed levels, Clock 1 to 3 (2 for the rook
// endings), which deal the top level's positions (dealLevel) with a clock. An attempt there also has its clock
// {tier, base_ms, inc_ms}, move_ms (the think time of each of the user's turns) and paused (how often the clock was
// paused); clock, move_ms and paused are NULL on an untimed attempt. Running out of time fails any of them: 'time'.
//
// The level, from the record, per ending, in the order the attempts were made:
//   - everyone starts at level 1;
//   - only attempts made at the level the ending is at count towards moving; an attempt at another level (a chosen
//     practice level) stays on the record and moves nothing;
//   - the "run" is the attempts at the current level since arriving at it, the last 4 of them;
//   - 3 solved in the run: up one level (never above the last clock tier, ladderTop);
//   - except from the top untimed level (untimedTop) to Clock 1: 3 solved in the run there makes the ending "ready",
//     and it moves up when the first row at Clock 1 comes (or at the end of the record). An attempt at the top while
//     ready is counted as before: the run slides and ready is worked out again. So a record made before the clock
//     replays to the level it had, and a player who qualified opens on Clock 1;
//   - otherwise the last 2 of the run both failed: down one level (never below 1);
//   - moving clears the run, so each level is earned afresh and a fall can't bounce straight back.
// The star: an ending has it once an attempt was solved at its top level while the ending was at the top level (a
// practice solve there, from a lower level, doesn't count). It stays: a later fall doesn't take it away, and reaching
// the top by solving the level below doesn't earn it. The clock star is the same for the last clock tier.
// Rows skipped by the replay: a second row with an id already seen (the first by ts and seq is kept), and a row whose
// clock doesn't fit its level (NULL above the top, or one at or below it): not a row this version writes, but an
// older app's stripped copy of a timed row (sync.js, the downgrade guard).
// After a sync merge the table is rewritten in the merged lines' order (by ts), so the devices replay the same record
// and their levels converge.
//
// Tables: `tables` below is a DrillTables, which loads an ending's tables the first time they're asked for and keeps
// them. What it loads from is injected (load(name) → {name, data}): tablesFromFiles() reads the .bin files, a test
// gives it small generated tables or a fake.

import { DEPENDS, blackMoves, fromFen, gunzip, probe, unpack } from '../core/endgame-table.js';
import { boardFromFen, copy, fen as fenOf, isCheckmate, legalMoves, makeSquare, parseUci, push, san, uci as uciOf } from '../core/chess.js';
import { ENDINGS, HOLD_MOVES, LEVELS, RECENT, attackStatus, bestLine, defenceStatus, defenderMove, flipFen, kindOfMove,
  kpkAttackerMove, kpkGrade, levelOf, pickStart, positionKey, review, status as mateStatus } from '../core/drills.js';
import { EngineFailed, HOLD_ROOK, POST_PROMO, ROOK_RESULTS, ROOK_TABLES, isRookEnding, rookBudget, rookStart, rookStatus,
  rookTurn, tableScore } from '../core/rook-drills.js';
import { HINT_CLAMP, HINT_MOVES, HINT_PV, likelyMove, namedHint, whiteScore } from '../core/rook-hint.js';
import { clockFor, dealLevel, ladderTop, perMove, replayClock, tierOf, tiers as tiersOf, untimedTop } from '../core/drill-clock.js';
import { DRILL_ROW } from './db.js';
import { BadRequest } from './http.js';

export const RUN = 4;           // the attempts at a level that count towards moving up
export const UP = 3;            // solved in the run: up a level
export const DOWN = 2;          // failed in a row: down a level
export const RECENT_SHOWN = 10; // the status lists this many attempts
export const CLOCK_SLACK = 250; // ms: what the clock checks of an attempt allow for rounding
export const MAX_TURNS = 150;   // move_ms entries

// 'time' (the clock ran out) is a fail of every kind, at a timed level only
const timed = r => ({ solved: r.solved, failed: [...r.failed, 'time'] });
export const RESULTS = {
  mate: timed({ solved: ['solved'], failed: ['stalemate', 'piece_lost', 'repetition', 'fifty', 'budget', 'abandoned'] }),
  KPK: timed({ solved: ['promoted'], failed: ['threw', 'pawn_lost', 'stalemate', 'repetition', 'fifty', 'abandoned'] }),
  'KPK-hold': timed({ solved: ['held', 'pawn_taken', 'stalemate'], failed: ['threw', 'promoted', 'abandoned'] }),
  Lucena: timed(ROOK_RESULTS.Lucena),
  Philidor: timed(ROOK_RESULTS.Philidor),
};
const kindOf = ending => (ending === 'KPK' || ending === 'KPK-hold' || isRookEnding(ending) ? ending : 'mate');
const isPawnEnding = ending => ending === 'KPK' || ending === 'KPK-hold';

export const isEnding = e => typeof e === 'string' && Object.hasOwn(LEVELS, e);
/** The highest level an ending's record may hold: its untimed levels and its clock tiers (drill-clock.js ladderTop).
 * The top level without a clock is untimedTop. */
export const topLevel = ending => ladderTop(ending);
export { untimedTop };
export const isSolved = (ending, result) => RESULTS[kindOf(ending)].solved.includes(result);

const COLUMNS = 'id, ts, ending, level, fen, dtm, budget, moves_used, result, ms, worst_loss, clock, move_ms, paused';

// ---------- the record and the level ----------

/** The record (every ending's, or one's) in the order the attempts were made. */
export function attempts(db, ending = null) {
  return ending === null
    ? db.all(`SELECT ${COLUMNS} FROM drill_attempts ORDER BY ts, seq`)
    : db.all(`SELECT ${COLUMNS} FROM drill_attempts WHERE ending = ? ORDER BY ts, seq`, [ending]);
}

/** The rows the replay counts, in order: the first of each id, and only rows whose clock fits their level. */
export function counted(ending, rows) {
  const top = untimedTop(ending), seen = new Set();
  return rows.filter(r => {
    if (r.id != null) {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
    }
    return (r.level > top) === (r.clock != null);
  });
}

/** Where an ending stands after `rows` (its attempts, in order): {level, top, tiers, star, clock_star, run}, top being
 * the top level without a clock, tiers how many clock tiers there are above it, and run the results of the run as
 * booleans (solved or not), oldest first. See the top of this file for the rules. */
export function progress(ending, rows) {
  const top = untimedTop(ending), last = ladderTop(ending);
  let level = 1, run = [], star = false, clockStar = false, ready = false;
  for (const r of counted(ending, rows)) {
    if (ready && r.level === top + 1) {      // qualified at the top: on to Clock 1 with this row
      level = top + 1;
      run = [];
      ready = false;
    }
    if (r.level !== level) continue;
    const ok = isSolved(ending, r.result);
    if (ok && level === top) star = true;
    if (ok && level === last) clockStar = true;
    run.push(ok);
    if (run.length > RUN) run.shift();
    const up = run.filter(Boolean).length >= UP;
    ready = level === top && up;
    if (level < last && level !== top && up) {
      level++;
      run = [];
    } else if (!ready && level > 1 && run.length >= DOWN && run.slice(-DOWN).every(x => !x)) {
      level--;
      run = [];
    }
  }
  if (ready) {
    level = top + 1;
    run = [];
  }
  return { level, top, tiers: tiersOf(ending), star, clock_star: clockStar, run };
}

/** One ending's standing and its last attempts. */
export function status(db, ending, rows = attempts(db, ending)) {
  const p = progress(ending, rows), mine = counted(ending, rows);
  const recent = mine.slice(-RECENT_SHOWN).map(r => ({ id: r.id, ts: r.ts, level: r.level, result: r.result,
    solved: isSolved(ending, r.result), moves_used: r.moves_used, ms: r.ms, worst_loss: r.worst_loss }));
  const tier = tierOf(ending, p.level);
  return { ending, level: p.level, top: p.top, tiers: p.tiers, tier, per_move: perMove(ending, tier), star: p.star,
    clock_star: p.clock_star, played: mine.length, solved: mine.filter(r => isSolved(ending, r.result)).length, run: p.run,
    recent };
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
 * result, ms, worst_loss, clock, move_ms, paused}; a BadRequest says what's wrong. At a timed level the clock must be
 * the one drill-clock.js gives for the start, and the turn times must add up (checkClock). */
export function parseAttempt(b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('an attempt object expected');
  if (!isEnding(b.ending)) throw new BadRequest(`ending: one of ${ENDINGS.join(', ')}`);
  const ending = b.ending, pawn = isPawnEnding(ending);
  const level = int(b.level, 'level', { min: 1, max: topLevel(ending) });
  const deal = dealLevel(ending, level), isTimed = level > deal;
  levelOf(ending, deal);
  if (typeof b.fen !== 'string' || b.fen.length > 100) throw new BadRequest('fen: a position expected');
  try {
    boardFromFen(b.fen);
  } catch {
    throw new BadRequest(`fen: not a position: ${b.fen}`);
  }
  const rook = isRookEnding(ending);
  const key = positionKey(b.fen);
  const want = rook ? `${ending}:${deal}:` : `${pawn ? 'KPK' : ending}:${ending === 'KPK-hold' ? 'b' : 'w'}:`;
  if (!key?.startsWith(want)) throw new BadRequest(`fen: not a ${ending} start position: ${b.fen}`);
  if (ending === 'KBBK') {
    const colour = sq => ((sq & 7) + (sq >> 3)) & 1, [b1, b2] = fromFen(b.fen).pieces;
    if (colour(b1) === colour(b2)) throw new BadRequest(`fen: bishops on one colour can't mate: ${b.fen}`);
  }
  const ok = RESULTS[kindOf(ending)];
  if (typeof b.result !== 'string' || ![...ok.solved, ...ok.failed].includes(b.result)) {
    throw new BadRequest(`result: one of ${[...ok.solved, ...ok.failed].join(', ')} for ${ending}`);
  }
  if (b.result === 'time' && !isTimed) throw new BadRequest(`result: 'time' only at a timed level, not ${ending} level ${level}`);
  let dtm = null, budget = null;
  if (rook) {
    if (b.dtm != null) throw new BadRequest(`${ending} has no dtm`);
    budget = rookBudget(ending, deal, rookStart(b.fen).entry);
    if (budget === null ? b.budget != null : b.budget !== budget) {
      throw new BadRequest(`budget: ${budget === null ? 'null' : budget} for this ${ending} start`);
    }
    if (b.worst_loss != null) throw new BadRequest(`worst_loss is null for ${ending}`);
  } else if (pawn) {
    if (b.dtm != null || b.budget != null) throw new BadRequest(`${ending} has no dtm or budget`);
  } else {
    dtm = int(b.dtm, 'dtm', { max: 100 });
    budget = int(b.budget, 'budget', { max: 1000 });
    const topBudget = dtm + levelOf(ending, deal).slack;     // the clock is sized from it
    if (isTimed && budget !== topBudget) throw new BadRequest(`budget: ${topBudget} for mate in ${dtm} at ${ending}'s top level`);
  }
  const worst = int(b.worst_loss, 'worst_loss', { min: -1, max: 1000, nullable: true });
  if (b.result === 'threw' && worst !== null) throw new BadRequest('worst_loss is null when a move threw the result');
  let id = null;
  if (b.id !== undefined && b.id !== null) {
    if (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.id)) throw new BadRequest('id: up to 64 letters, digits, - and _');
    id = b.id;
  }
  const movesUsed = int(b.moves_used, 'moves_used', { max: 1000 });
  const ms = int(b.ms, 'ms', { max: 1e10, nullable: !isTimed });
  let clock = null, moveMs = null, paused = null;
  if (!isTimed) {
    for (const k of ['clock', 'move_ms', 'paused']) if (b[k] != null) throw new BadRequest(`${k}: none at ${ending} level ${level}, which has no clock`);
  } else {
    ({ clock, moveMs, paused } = checkClock(b, { ending, level, budget, movesUsed, ms }));
  }
  return { id, ending, level, fen: b.fen, dtm, budget, moves_used: movesUsed, result: b.result, ms, worst_loss: worst,
    clock, move_ms: moveMs, paused };
}

// a timed attempt's clock checked: the clock the table gives for the start, a think time for each turn (moves_used of
// them; 'time' one more, the turn the clock ran out on; 'abandoned' may have one more, a turn under way when left),
// no turn ending below zero, 'time' ending at zero, all of it within the attempt's wall time
function checkClock(b, { ending, level, budget, movesUsed, ms }) {
  const want = clockFor(ending, level, { budget });
  const c = b.clock;
  if (c === null || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== 3
      || c.tier !== want.tier || c.base_ms !== want.base_ms || c.inc_ms !== want.inc_ms) {
    throw new BadRequest(`clock: ${JSON.stringify(want)} for this start`);
  }
  const m = b.move_ms;
  if (!Array.isArray(m) || m.length > MAX_TURNS || !m.every(x => Number.isInteger(x) && x >= 0 && x <= 3_600_000)) {
    throw new BadRequest(`move_ms: up to ${MAX_TURNS} integers from 0 to 3600000 expected`);
  }
  const out = b.result === 'time';
  const turns = out ? [movesUsed + 1] : b.result === 'abandoned' ? [movesUsed, movesUsed + 1] : [movesUsed];
  if (!turns.includes(m.length)) throw new BadRequest(`move_ms: ${turns.join(' or ')} turns for ${movesUsed} moves and '${b.result}', not ${m.length}`);
  const ends = replayClock(want, m);
  for (let i = 0; i < ends.length - (out ? 1 : 0); i++) {
    if (ends[i] < -CLOCK_SLACK) throw new BadRequest(`move_ms: the clock had run out by the end of turn ${i + 1}`);
  }
  if (out && Math.abs(ends.at(-1)) > CLOCK_SLACK) throw new BadRequest(`move_ms: 'time' with ${ends.at(-1)} ms still on the clock`);
  if (m.reduce((s, x) => s + x, 0) > ms + CLOCK_SLACK) throw new BadRequest('move_ms: more think time than the attempt took (ms)');
  const paused = int(b.paused, 'paused', { max: 1000 });
  return { clock: want, moveMs: m, paused };
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
      moves_used: a.moves_used, result: a.result, ms: a.ms, worst_loss: a.worst_loss, clock: a.clock ?? null,
      move_ms: a.move_ms ?? null, paused: a.paused ?? null };
    db.insert('drill_attempts', DRILL_ROW, [row]);
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
  if (isRookEnding(ending)) ROOK_TABLES.forEach(add);
  else add(ending === 'KPK-hold' ? 'KPK' : ending);
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
 * the drill {ending, level, mode, fen, dtm, budget, counter, hold_moves, post_promo, clock} or null when no start position turns up
 * (pickStart gives up; the caller says so). `tables` is what DrillTables.get(ending) gave. The positions of the last
 * RECENT attempts at the ending aren't dealt again, and the attempts so far turn the zones. A timed level deals the
 * top level's positions (dealLevel) and adds the clock for the start (drill-clock.js clockFor; null when untimed). */
export function nextDrill(db, tables, ending, { level = null, rng = Math.random } = {}) {
  const rows = attempts(db, ending), st = status(db, ending, rows), at = level ?? st.level;
  const deal = dealLevel(ending, at), row = levelOf(ending, deal);
  // a rook drill keeps its own count of what was dealt at each level (rook-drills.js), so it gets every row's key
  const dealt = isRookEnding(ending) ? rows : rows.slice(-RECENT);
  const recent = dealt.map(r => (typeof r.fen === 'string' ? positionKey(r.fen) : null)).filter(Boolean);
  const start = pickStart(tables, ending, deal, { rng, recent, turn: rows.length });
  if (!start) return { drill: null, level: at, status: st };
  const mode = modeOf(ending);
  const drill = { ending, level: at, mode, fen: start.fen, dtm: start.dtm, budget: start.budget,
    counter: at > deal ? false : row.counter, hold_moves: mode === 'hold' ? HOLD_MOVES : mode === 'philidor' ? HOLD_ROOK : null,
    post_promo: mode === 'lucena' ? POST_PROMO : null, clock: clockFor(ending, at, { budget: start.budget }) };
  return { drill, level: at, status: st };
}

// ---------- playing a drill ----------
//
// The page holds no tables: each of the user's moves goes to the move route with every position so far, and the
// answer is the defender's reply and where the drill stands (playMove). Nothing is kept between moves; the positions
// are replayed and checked here each time, and the replay's own FENs (counters counted) are what gets judged.

export const MAX_FENS = 300;     // positions in one move request: 150 of the user's moves, more than any budget
const isWon = r => r.result === 'win' || r.result === 'loss' || r.result === 'mate';
const placementOf = f => f.trim().split(/\s+/).slice(0, 2).join(' ');
export const modeOf = ending => (ending === 'KPK' ? 'attack' : ending === 'KPK-hold' ? 'hold'
  : isRookEnding(ending) ? ending.toLowerCase() : 'mate');
const tableName = ending => (ending === 'KPK-hold' ? 'KPK' : ending);
const blackHasMen = f => /[pqrbn]/.test(f.split(' ')[0]);

function fenField(v, what) {
  if (typeof v !== 'string' || !v.length || v.length > 100) throw new BadRequest(`${what}: a position expected`);
  try {
    return boardFromFen(v);
  } catch {
    throw new BadRequest(`${what}: not a position: ${v}`);
  }
}

// a KPK defence position (black has the pawn) probed in table terms: the colours swapped, so white has it
const flipped = (tables, f) => probe(tables, fromFen(flipFen(f)));

// where a drill stands after `fens` (the start first), movesUsed being the user's moves so far
function standing(tables, mode, fens, movesUsed, budget) {
  if (mode === 'lucena' || mode === 'philidor') return rookStatus(tables, mode === 'lucena' ? 'Lucena' : 'Philidor', { fens, budget });
  if (mode === 'mate') return mateStatus({ fens, movesUsed, budget });
  if (mode === 'attack') return attackStatus(tables, { fens });
  const last = fens[fens.length - 1];
  if (blackHasMen(last) && fens.length > 1 && kpkGrade(flipped(tables, fens[fens.length - 2]), flipped(tables, last)) === 'threw') {
    return last.split(' ')[1] === 'b' ? 'threw' : 'promoted';
  }
  return defenceStatus({ fens });
}

/** A move request checked and replayed: {ending, level, mode, dtm, budget, fens, sans, ucis}. `b` is {ending, level, fens}:
 * fens every position from the dealt one (white to move, a start position of the ending, in the level's band for a
 * mate drill) up to and including the user's last move, one legal move apart, with no earlier position where the
 * drill was already over. The budget is worked out from the start position and the level, as the deal did. The fens
 * returned are the replay's (the counters counted), sans and ucis the moves'. A rook drill's fens[0] is a ROOK_STARTS
 * entry of the level (or its mirror), and its Lucena budget the entry's promote + the level's slack; the returned
 * fens[0] has the stored start's counters (halfmove clock, move number), whatever the client sent. anyEnd: the fens
 * may also end after a reply (the hint's whole attempt). A BadRequest says what's wrong. */
export function parseMove(tables, b, { anyEnd = false } = {}) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('a move request object expected');
  if (!isEnding(b.ending)) throw new BadRequest(`ending: one of ${ENDINGS.join(', ')}`);
  const ending = b.ending, mode = modeOf(ending);
  const level = int(b.level, 'level', { min: 1, max: topLevel(ending) });
  const deal = dealLevel(ending, level), row = levelOf(ending, deal);     // a timed level plays the top's starts
  if (!Array.isArray(b.fens) || b.fens.length < 2 || b.fens.length > MAX_FENS) {
    throw new BadRequest(`fens: 2 to ${MAX_FENS} positions expected`);
  }
  if (b.fens.length % 2 && !anyEnd) throw new BadRequest('fens: the last position must follow a move of yours');
  let board = fenField(b.fens[0], 'fens[0]');
  const rook = isRookEnding(ending);
  const want = rook ? `${ending}:${deal}:` : `${tableName(ending)}:${ending === 'KPK-hold' ? 'b' : 'w'}:`;
  if (board.turn !== 'white' || !positionKey(b.fens[0])?.startsWith(want)) {
    throw new BadRequest(`fens[0]: not a ${ending} start position: ${b.fens[0]}`);
  }
  if (rook) {     // the stored start's fields after the placement, not the client's (a halfmove clock of 99 would end it)
    const [, ...rest] = rookStart(b.fens[0]).entry.fen.trim().split(/\s+/);
    board = boardFromFen([b.fens[0].trim().split(/\s+/)[0], ...rest].join(' '));
  }
  let dtm = null, budget = null;
  if (mode === 'mate') {
    const r = probe(tables, fromFen(b.fens[0]));
    if (r.result !== 'win' || r.dtm < row.lo || r.dtm > row.hi) throw new BadRequest(`fens[0]: not a ${ending} level ${level} start`);
    dtm = r.dtm;
    budget = dtm + row.slack;
  } else if (rook) {
    budget = rookBudget(ending, deal, rookStart(b.fens[0]).entry);
  }
  const fens = [fenOf(board)], sans = [], ucis = [];
  for (let k = 1; k < b.fens.length; k++) {
    const what = `fens[${k}]`;
    if (typeof b.fens[k] !== 'string' || b.fens[k].length > 100) throw new BadRequest(`${what}: a position expected`);
    const target = placementOf(b.fens[k]);
    const m = legalMoves(board).find(mv => {
      const next = copy(board);
      push(next, mv);
      return placementOf(fenOf(next)) === target;
    });
    if (!m) throw new BadRequest(`${what}: not one legal move on from ${fens[k - 1]}`);
    sans.push(san(board, m));
    ucis.push(uciOf(m));
    push(board, m);
    fens.push(fenOf(board));
    if (k < b.fens.length - 1 && standing(tables, mode, fens, Math.floor(fens.length / 2), budget)) {
      throw new BadRequest(`${what}: the drill was over there`);
    }
  }
  return { ending, level, mode, dtm, budget, fens, sans, ucis };
}

// the review of a KPK defence: each of the user's moves kept the draw ('best') or gave it away ('threw')
function holdReview(tables, fens) {
  const moves = [];
  let worst = -1;
  for (let k = 0; k + 1 < fens.length; k += 2) {
    const threw = blackHasMen(fens[k + 1]) && kpkGrade(flipped(tables, fens[k]), flipped(tables, fens[k + 1])) === 'threw';
    if (threw && worst < 0) worst = moves.length;
    moves.push({ dtm: null, kind: threw ? 'threw' : 'best', loss: threw ? null : 0 });
  }
  return { moves, worst };
}

/** The review of a finished drill ({moves: [{dtm, kind, loss}], worst}, as core/drills.js review() gives it) and the
 * record's worst_loss from it. */
export function reviewOf(tables, mode, fens, result) {
  const rv = mode === 'hold' ? holdReview(tables, fens) : review(tables, fens);
  const worstLoss = result === 'threw' ? null : rv.worst < 0 ? -1 : rv.moves[rv.worst].loss;
  return { review: rv, worst_loss: worstLoss };
}

/** The user's last move judged and answered (req from parseMove): {san, fen_move (after the move), kind, loss,
 * dtm_after (mate distance after it; null in a KPK drill), reply (UCI; null when the drill ended on the move),
 * reply_san, fen (after the reply), dtm (mate distance after the reply), moves_used, budget, result (null while it
 * goes on), review and worst_loss (once there's a result)}. */
export function playMove(tables, req, rng = Math.random) {
  const { mode, fens, budget } = req, movesUsed = fens.length / 2;
  const before = fens[fens.length - 2], after = fens[fens.length - 1];
  let kind, loss, dtmAfter = null;
  if (mode === 'hold') {
    const keeps = !blackHasMen(after) || kpkGrade(flipped(tables, before), flipped(tables, after)) === 'ok';
    kind = keeps ? 'best' : 'threw';
    loss = keeps ? 0 : null;
  } else {
    const b = probe(tables, fromFen(before)), a = probe(tables, fromFen(after));
    kind = b.result === 'win' ? kindOfMove(b.dtm, a) : 'threw';
    loss = kind === 'threw' ? null : a.dtm - (b.dtm - 1);
    if (mode === 'mate') dtmAfter = isWon(a) ? a.dtm : null;
  }
  const out = { san: req.sans[req.sans.length - 1], fen_move: after, kind, loss, dtm_after: dtmAfter, reply: null,
    reply_san: null, fen: null, dtm: null, moves_used: movesUsed, budget, result: null, review: null, worst_loss: null };
  let all = fens;
  out.result = standing(tables, mode, all, movesUsed, budget);
  if (!out.result) {
    const reply = mode === 'hold' ? kpkAttackerMove(tables, after, rng) : defenderMove(tables, after, rng);
    if (reply) {
      const board = boardFromFen(after), m = parseUci(board, reply);
      out.reply_san = san(board, m);
      push(board, m);
      out.reply = uciOf(m);
      out.fen = fenOf(board);
      all = [...fens, out.fen];
      if (mode === 'mate') {
        const pos = fromFen(out.fen), r = pos && pos.name === req.ending ? probe(tables, pos) : null;
        out.dtm = r && r.result === 'win' ? r.dtm : null;
      }
      out.result = standing(tables, mode, all, movesUsed, budget);
    }
  }
  if (out.result) Object.assign(out, reviewOf(tables, mode, all, out.result));
  return out;
}

/** A rook drill's move (req from parseMove) answered with the opponent's reply: playMove's shape, with kind, loss,
 * dtm_after and dtm null (no table grades a rook ending move by move), and two more: promoted (Lucena: the user has
 * promoted; Philidor: black has) and engine_ms (the reply's search, null when the drill ended on the user's move).
 * Once there's a result, review is {moves: [{dtm, kind, loss}: all null, one per user move], worst: -1} and worst_loss
 * null: the hint (round 4) is the rook drills' review. engine({fen, moves}) is rook-drills.js rookTurn's; it throws
 * when the engine fails, and so does this. */
export async function playRookMove(tables, req, engine) {
  const { ending, fens, ucis, budget } = req, movesUsed = fens.length / 2;
  const t = await rookTurn(tables, ending, { fens, ucis, budget }, engine);
  const out = { san: req.sans[req.sans.length - 1], fen_move: fens[fens.length - 1], kind: null, loss: null, dtm_after: null,
    reply: t.reply, reply_san: null, fen: t.fen, dtm: null, moves_used: movesUsed, budget, result: t.result, review: null,
    worst_loss: null, promoted: t.promoted, engine_ms: t.engine_ms };
  if (t.reply) {
    const board = boardFromFen(fens[fens.length - 1]);
    out.reply_san = san(board, parseUci(board, t.reply));
  }
  if (out.result) {
    out.review = { moves: Array.from({ length: movesUsed }, () => ({ dtm: null, kind: null, loss: null })), worst: -1 };
  }
  return out;
}

/** The rook drills' review hint (core/rook-hint.js) for an attempt (req from parseMove with anyEnd: the fens may end
 * after a reply): every position where the user was to move in the last HINT_MOVES moves scored by `search` (async
 * ({fen, moves}) → {cp, mate, pv} from the side to move's view, or null when it failed: drill-opponent.js scorer),
 * all at once (the pool runs as many as it has engines), the position after a last move with no reply too; a
 * finished position (mate, stalemate, a table's 4 pieces) is scored without a search. Returns {moves: [{ply,
 * score_before, score_after, pv, line}], likely, pv, line, hint, approximate: true}: ply is the move's index in the
 * attempt's moves (2k for the user's k-th, from 0), scores white's view clamped to +-1000 (null: not scored), pv the
 * engine's line (UCI, up to 8 plies) from the position before the move and line the same as [{uci, san, fen}] (for
 * the page, as the line route gives it), likely the user move (k) the score fell most after (null: none fell 100 or
 * more), pv and line at the top level likely's, hint the named hint for it (core/rook-hint.js namedHint, or null).
 * Throws EngineFailed when no search answered. */
export async function rookHint(tables, req, search) {
  const { ending, fens, ucis } = req;
  const users = Math.ceil((fens.length - 1) / 2), first = Math.max(0, users - HINT_MOVES);
  const after = k => (2 * k + 2 < fens.length ? 2 * k + 2 : 2 * k + 1);
  const wanted = new Set();
  for (let k = first; k < users; k++) wanted.add(2 * k).add(after(k));
  let asked = 0, answered = 0;
  const scoreAt = async i => {
    const fen = fens[i], board = boardFromFen(fen), turn = fen.split(' ')[1];
    if (isCheckmate(board)) return { score: turn === 'w' ? -HINT_CLAMP : HINT_CLAMP, line: [] };
    if (!legalMoves(board).length) return { score: 0, line: [] };
    const t = tableScore(tables, fen);
    if (t !== undefined) return { score: t, line: [] };
    asked++;
    const s = await search({ fen: fens[0], moves: ucis.slice(0, i) });
    if (!s) return { score: null, line: [] };
    answered++;
    return { score: whiteScore(turn, s), line: legalLine(fen, s.pv ?? [s.move], HINT_PV) };
  };
  const scored = new Map(await Promise.all([...wanted].map(async i => [i, await scoreAt(i)])));
  if (asked && !answered) throw new EngineFailed('the engine failed on every position of the attempt');
  const moves = Array.from({ length: users }, (_, k) => {
    const line = scored.get(2 * k)?.line ?? [];
    return { ply: 2 * k, score_before: scored.get(2 * k)?.score ?? null,
      score_after: k >= first ? scored.get(after(k))?.score ?? null : null, pv: line.map(m => m.uci), line };
  });
  const likely = likelyMove(moves);
  const hint = likely === null ? null
    : namedHint(ending, { before: fens[2 * likely], uci: ucis[2 * likely], after: fens[2 * likely + 1], reply: ucis[2 * likely + 1] ?? null });
  return { moves, likely, pv: likely === null ? [] : moves[likely].pv, line: likely === null ? [] : moves[likely].line, hint,
    approximate: true };
}

// the start of `line` (UCI) that is legal from fen, up to max plies: [{uci, san, fen}] as lineFrom gives them
function legalLine(fen, line, max) {
  const board = boardFromFen(fen), out = [];
  for (const u of line.slice(0, max)) {
    let m;
    try {
      m = parseUci(board, u);
    } catch {
      break;
    }
    if (!legalMoves(board).some(x => uciOf(x) === uciOf(m))) break;
    const s = san(board, m);
    push(board, m);
    out.push({ uci: uciOf(m), san: s, fen: fenOf(board) });
  }
  return out;
}

// the drawing line of a KPK defence from fen (as shown, either side to move): the user's king keeps the draw (takes
// the pawn when it can, else the first holding move) and the attacker squeezes, until the drill would end
function holdLine(tables, fen, max = 2 * HOLD_MOVES) {
  const line = [];
  let cur = fen;
  while (line.length < max && /p/.test(cur.split(' ')[0]) && !defenceStatus({ fens: [cur] })) {
    let uci;
    if (cur.split(' ')[1] === 'w') {
      const pos = fromFen(flipFen(cur));
      const holds = blackMoves(tables, pos).filter(m => m.result === 'draw');
      if (!holds.length) break;
      const m = holds.find(x => x.capture) ?? holds[0];
      uci = makeSquare(pos.bk ^ 56) + makeSquare(m.to ^ 56);
    } else {
      uci = kpkAttackerMove(tables, cur, () => 0);
      if (!uci) break;
    }
    const board = boardFromFen(cur);
    push(board, parseUci(board, uci));
    cur = fenOf(board);
    line.push(uci);
  }
  return line;
}

/** A line request checked: {ending, fen}, fen a position of the ending's own table (either side to move; for the
 * KPK defence, black has the pawn). */
export function parseLine(b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('a line request object expected');
  if (!isEnding(b.ending)) throw new BadRequest(`ending: one of ${ENDINGS.join(', ')}`);
  fenField(b.fen, 'fen');
  if (isRookEnding(b.ending)) throw new BadRequest(`${b.ending} has no table line (no 5-piece tables)`);
  const hold = b.ending === 'KPK-hold';
  const ok = positionKey(b.fen)?.startsWith(`${tableName(b.ending)}:`) && (!b.ending.startsWith('KPK') || !fromFen(b.fen) === hold);
  if (!ok) throw new BadRequest(`fen: not a ${b.ending} position: ${b.fen}`);
  return { ending: b.ending, fen: b.fen };
}

/** The table's line from a position: {line: [uci], moves: [{uci, san, fen}]}. A mate drill or the KPK attack: core
 * bestLine (white's fastest mate against the longest defence, empty for a draw); the KPK defence: holdLine. */
export function lineFrom(tables, { ending, fen }) {
  const line = modeOf(ending) === 'hold' ? holdLine(tables, fen) : bestLine(tables, fen);
  const board = boardFromFen(fen), moves = [];
  for (const u of line) {
    const m = parseUci(board, u);
    const s = san(board, m);
    push(board, m);
    moves.push({ uci: u, san: s, fen: fenOf(board) });
  }
  return { line, moves };
}
