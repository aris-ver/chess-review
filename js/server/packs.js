// Puzzle packs and the puzzle of the day, as chess_review/packs.py (the app's side of it: building packs.json stays
// Python, scripts/build_puzzle_packs.py).
//
// A pack is a theme laid out as stages that go uphill, frozen into puzzle_packs/packs.json: {version, stage_size,
// packs: [{id, family, name, desc, themes, without, stages: [{n, lo, hi, ids}]}], daily: [ids]}. Solving STAGE_PASS
// of a stage opens the next one; stages at or below your puzzle rating are open from the start once that rating has
// something behind it (OPEN_BY_RATING_AFTER puzzles), and so is a stage once you've solved enough of the pack's
// themes at the level of the stage below it, wherever you solved them (credit). The puzzle of day n is
// daily[(n - 1) % len], day 1 being DAILY_EPOCH.
//
// What you've done with a puzzle comes from progress.sqlite (Store.progress(), db.js):
//     puzzle_attempts   (puzzles.js) the first try at each puzzle, archived ones too: solved clean or not
//     puzzle_solved     one row per puzzle solved, on the first try or a later one: {id, ts}, and clean: true once
//                       a go at it was solved without a mistake or a hint
//     puzzle_daily      one row per day played, the first showing only: {date, n, id, solved, clean, ms, marks}
// A puzzle is "clean" when a go at it was solved without a mistake or a hint: the first try, or one after it (a
// puzzle opened again and found at once counts as found first try, and a miss after that doesn't take it away);
// "solved" when it was solved, but never cleanly; "missed" when it was tried and never solved. The rating and its
// counts stay with the first try alone (puzzles.js): a puzzle played again is one you may remember.
//
// Days are ISO dates ('2026-10-23'), the caller's local date (today()).

import { DAILY_SCHEMA, SOLVED_ROW } from './db.js';

export const STAGE_SIZE = 20;
export const STAGE_PASS = 0.8;             // 16 of 20 opens the next stage
export const OPEN_BY_RATING_AFTER = 20;    // puzzles behind your rating before it opens the stages below it

export const DAILY_EPOCH = '2026-10-20';

/** packs.json, read once on first use. read() returns it parsed; when it throws, there are no packs. */
export class Packs {
  constructor(read) {
    this.read = read;
    this._data = null;
  }

  data() {
    if (this._data === null) {
      try {
        this._data = this.read();
      } catch {
        this._data = { packs: [], daily: [] };
      }
    }
    return this._data;
  }

  get(packId) {
    return this.data().packs.find(p => p.id === packId) ?? null;
  }
}

const nowSeconds = () => Date.now() / 1000;

/** id → solved clean on the first try (a Map, in the order tried), from the attempts record and the ones archived
 * by a rating reset: the archives in their files' name order, then the current one. */
export function firstTries(db) {
  const rows = db.all('SELECT archive, id, solved FROM puzzle_attempts ORDER BY seq');
  const file = a => (a === null ? null : `${a}.jsonl`);     // puzzle_attempts.<archive>.jsonl sorts as this does
  const names = [...new Set(rows.map(r => r.archive).filter(a => a !== null))].sort((a, b) => (file(a) < file(b) ? -1 : 1));
  const out = new Map();
  for (const a of [...names, null]) {
    for (const r of rows) if (r.archive === a && !out.has(r.id)) out.set(r.id, !!r.solved);
  }
  return out;
}

/** id → solved cleanly on some go (a Map): every puzzle solved, the first try or a later one. */
export function solvedLater(db) {
  const out = new Map();
  for (const r of db.all('SELECT id, clean FROM puzzle_solved ORDER BY seq')) out.set(r.id, !!r.clean || !!out.get(r.id));
  return out;
}

/** A puzzle solved (shown the solution doesn't count); clean: without a mistake or a hint on this go. Once a
 * puzzle is solved clean it stays so: a solve with misses later leaves the row as it is. */
export function markSolved(db, pid, now = nowSeconds(), clean = false) {
  db.tx(() => {
    const had = db.all('SELECT clean FROM puzzle_solved WHERE id = ?', [pid]);
    if (!had.length) db.insert('puzzle_solved', SOLVED_ROW, [{ id: pid, ts: Math.floor(now), clean: clean ? true : null }]);
    else if (clean && !had.some(r => r.clean)) db.run('UPDATE puzzle_solved SET clean = 1 WHERE id = ?', [pid]);
  });
}

/** later: solvedLater()'s Map (a Set of ids, as before it, has no clean solves in it). */
export function stateOf(pid, first, later) {
  if (first.get(pid) || (later instanceof Map && later.get(pid))) return 'clean';
  if (later.has(pid)) return 'solved';
  return first.has(pid) ? 'missed' : 'new';
}

export const need = stage => Math.ceil(stage.ids.length * STAGE_PASS);

/** The ratings of the puzzles you've solved with this pack's themes, wherever you solved them: in the library,
 * another pack, or an earlier layout of this one. get: the pack's rows by id (puzzles.js Pack.get). */
export function credit(pack, first, later, get) {
  const want = new Set(pack.themes), drop = new Set(pack.without ?? []);
  const out = [];
  for (const [pid, clean] of first) {
    if (clean || later.has(pid)) {
      const r = get(pid);
      if (r && r.themes.some(t => want.has(t)) && !r.themes.some(t => drop.has(t))) out.push(r.rating);
    }
  }
  return out;
}

const lookup = (m, k) => (m instanceof Map ? m.get(k) : m?.[k]) ?? null;

/** A pack with every puzzle's state, and which stages are open. packRows: id → rating (a Map or an object);
 * solved: credit(), what opens a stage when need() of the stage below's were solved at its level or above. */
export function ladder(pack, first, later, stats, packRows = null, solved = []) {
  const rated = (stats.played ?? 0) >= OPEN_BY_RATING_AFTER;
  const stages = [];
  let prevOk = true, prev = null;
  for (const st of pack.stages) {
    const cells = st.ids.map(i => ({ id: i, state: stateOf(i, first, later), rating: lookup(packRows, i) }));
    const nSolved = cells.filter(c => c.state === 'clean' || c.state === 'solved').length;
    const clean = cells.filter(c => c.state === 'clean').length;
    const earned = prev !== null && solved.filter(r => r >= prev.lo).length >= need(prev);
    const isOpen = prevOk || earned || (rated && st.lo <= (stats.rating ?? 0));
    stages.push({ n: st.n, lo: st.lo, hi: st.hi, open: isOpen, solved: nSolved, clean, need: need(st), size: cells.length, puzzles: cells });
    prevOk = nSolved >= need(st);
    prev = st;
  }
  const total = stages.reduce((s, x) => s + x.size, 0);
  const nSolved = stages.reduce((s, x) => s + x.solved, 0);
  const clean = stages.reduce((s, x) => s + x.clean, 0);
  const current = stages.find(s => s.open && s.solved < s.size)?.n ?? null;
  return {
    id: pack.id, family: pack.family, name: pack.name, desc: pack.desc, stages,
    total, solved: nSolved, clean, current, done: nSolved === total, perfect: clean === total,
  };
}

/** Every pack's progress, without the puzzles. packs: a Packs; db: Store.progress(); get: Pack.get. */
export function shelf(packs, stats, db, get) {
  const first = firstTries(db), later = solvedLater(db);
  const out = [];
  for (const p of packs.data().packs) {
    const { stages, ...lad } = ladder(p, first, later, stats, null, credit(p, first, later, get));
    lad.current_lo = stages.find(s => s.n === lad.current)?.lo ?? stages[stages.length - 1].lo;   // how hard it is where you are
    lad.n_stages = p.stages.length;
    lad.lo = p.stages[0].lo;
    lad.hi = p.stages[p.stages.length - 1].hi;
    out.push(lad);
  }
  return out;
}

/** The pack a puzzle is in, as a list: [{pack, name, stage, n}] (n counts from 1). */
export function where(packs, pid) {
  const out = [];
  for (const p of packs.data().packs) {
    for (const st of p.stages) {
      const i = st.ids.indexOf(pid);
      if (i >= 0) out.push({ pack: p.id, name: p.name, stage: st.n, n: i + 1 });
    }
  }
  return out;
}

// ---------- the puzzle of the day ----------

const pad = n => String(n).padStart(2, '0');

/** datetime.date.today(): the local date, ISO. */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** An ISO date as a day count (date.toordinal() up to a constant). */
function ordinal(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export const dayNumber = day => ordinal(day) - ordinal(DAILY_EPOCH) + 1;

export function dailyId(packs, day) {
  const ids = packs.data().daily;
  if (!ids.length) return null;
  const n = ids.length;
  return ids[(((dayNumber(day) - 1) % n) + n) % n];
}

export function dailyRecord(db) {
  return db.all('SELECT date, n, id, solved, clean, ms, marks FROM puzzle_daily ORDER BY seq');
}

/** [current, best]: days in a row with the daily solved. Today unsolved yet doesn't break it. */
export function streaks(rec, day) {
  const days = [...new Set(rec.filter(r => r.solved).map(r => ordinal(r.date)))].sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    run = prev !== null && d - prev === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  const current = prev !== null && ordinal(day) - prev <= 1 ? run : 0;
  return [current, best];
}

export function daily(packs, db, day) {
  const rec = dailyRecord(db);
  const mine = rec.find(r => r.date === day) ?? null;
  const [cur, best] = streaks(rec, day);
  return { date: day, n: dayNumber(day), id: dailyId(packs, day), result: mine, streak: cur, best_streak: best };
}

/** str(m), for the marks the page sends (strings, as a rule). */
function pyStr(m) {
  if (m === null || m === undefined) return 'None';
  if (typeof m === 'boolean') return m ? 'True' : 'False';
  return typeof m === 'object' ? JSON.stringify(m) : String(m);
}

/** The day's first showing, once: a second report for the same date is ignored. */
export function recordDaily(packs, db, day, pid, solved, clean, ms, marks) {
  db.tx(() => {
    const seen = db.value('SELECT count(*) FROM puzzle_daily WHERE date = ?', [day]);
    if (!seen && pid === dailyId(packs, day)) {
      db.insert('puzzle_daily', DAILY_SCHEMA, [{
        date: day, n: dayNumber(day), id: pid, solved: !!solved, clean: !!(solved && clean), ms,
        marks: marks.map(pyStr).slice(0, 20),
      }]);
    }
  });
  return daily(packs, db, day);
}
