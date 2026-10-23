// The puzzle trainer, as chess_review/puzzles.py: the Lichess pack, a record of every first try at a puzzle, and a
// rating worked out from that record.
//
// A Lichess puzzle starts one move early: `fen` is the position before the opponent's move, and the first UCI move
// in `moves` is that move (the setup), played by the board before the solver's turn. Every other move after it is
// the solver's, answered by the opponent's reply.
//
// The pack is puzzles.json (scripts/build_web.py writes it from puzzle_packs/lichess.parquet: rows {id, fen, moves,
// rating, popularity, plays, themes, game_url, opening}, themes space-separated), so no Parquet reader is needed.
// The record is progress.sqlite's puzzle_attempts table (db.js), one row per former puzzle_attempts.jsonl line:
// {id, ts, solved, ms, hinted, rating}. Only the first try at a puzzle counts, the way Lichess does it, and the
// rating is Glicko-1 replayed from the record. Resetting the rating moves the record aside (archive = 'reset-<when>',
// as the puzzle_attempts.reset-<when>.jsonl file was named) and the rating starts again at 1500; the puzzles tried
// before stay out of the deal.
//
// `db` below is a db.js connection with a puzzle_attempts table: Store.progress() for the library, Store.profile(p)
// for own puzzles (own-puzzles.js). Times (`now`) are epoch seconds, as `ts` is.

import { boardFromFen, fen, isCheckmate, legalMoves, moveFromUci, push, san, uci as uciOf } from '../core/chess.js';
import { capitalize, pyRound } from '../core/py.js';
import { ATTEMPTS_SCHEMA } from './db.js';

export const START_RATING = 1500.0, START_RD = 350.0;
export const MIN_RD = 60.0;           // never fully settled, so the rating keeps following you
export const PUZZLE_RD = 75.0;        // the pack keeps puzzles whose own rating deviation is at most 80
export const PROVISIONAL_RD = 110.0;  // shown with a "?" above this, like Lichess
export const WINDOW = 150;            // next puzzle: within this of your rating, widened when nothing is left there

const Q = Math.log(10) / 400;

// Lichess's own names where splitting the camelCase id doesn't give them
export const THEME_NAMES = {
  mateIn1: 'Mate in 1', mateIn2: 'Mate in 2', mateIn3: 'Mate in 3', mateIn4: 'Mate in 4', mateIn5: 'Mate in 5+',
  oneMove: 'One-move puzzle', veryLong: 'Very long puzzle', short: 'Short puzzle', long: 'Long puzzle',
  attackingF2F7: 'Attacking f2 or f7', xRayAttack: 'X-ray attack', enPassant: 'En passant',
  superGM: 'Super GM game', masterVsMaster: 'Master vs master', master: 'Master game',
  crushing: 'Crushing', advantage: 'Advantage', equality: 'Equality', mate: 'Checkmate',
  hangingPiece: 'Hanging piece', underPromotion: 'Underpromotion', killBoxMate: 'Kill box mate',
  morphysMate: "Morphy's mate", pillsburysMate: "Pillsbury's mate", swallowstailMate: "Swallow's tail mate",
};

export function themeName(tag) {
  if (Object.hasOwn(THEME_NAMES, tag)) return THEME_NAMES[tag];
  const words = tag.replace(/(?<=[a-z0-9])(?=[A-Z])/g, ' ').split(/\s+/).filter(Boolean);
  return words.length ? [capitalize(words[0]), ...words.slice(1).map(w => w.toLowerCase())].join(' ') : tag;
}

/** sorted(xs, key=...) on strings as Python compares them (code points; ASCII here). */
const byString = f => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0);

/** random.choice(xs) with rng() in [0, 1) (Math.random by default). */
export const choice = (xs, rng = Math.random) => xs[Math.floor(rng() * xs.length)];

/** The shipped puzzles, read once on first use. read() returns puzzles.json's rows, parsed; it may throw while the
 * pack isn't there yet (the web worker downloads it alongside the app), and is asked again next time. */
export class Pack {
  constructor(read) {
    this.read = read;
    this._rows = null;
    this._byId = new Map();
  }

  rows() {
    if (this._rows === null) {
      const rows = this.read().map(r => ({ ...r, themes: typeof r.themes === 'string' ? r.themes.split(/\s+/).filter(Boolean) : [...r.themes] }));
      this._rows = rows;
      this._byId = new Map(rows.map(r => [r.id, r]));
    }
    return this._rows;
  }

  get(pid) {
    this.rows();
    return this._byId.get(pid) ?? null;
  }

  themes() {
    const counts = new Map();
    for (const r of this.rows()) for (const t of r.themes) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([t, n]) => ({ id: t, name: themeName(t), count: n })).sort(byString(d => d.name));
  }
}

function playMove(board, u) {
  const mv = moveFromUci(u);
  const s = san(board, mv);
  push(board, mv);
  return { uci: u, san: s, fen: fen(board) };
}

/** What the page plays: every move with its SAN and the FEN after it, and -- where the solution ends in mate --
 * the other mates the solver's last move may give instead (Lichess accepts any mate there). */
export function line(p) {
  const board = boardFromFen(p.fen);
  const ucis = p.moves.split(/\s+/).filter(Boolean);
  const moves = ucis.map(u => playMove(board, u));
  const mates = [];
  if (isCheckmate(board) && ucis.length % 2 === 0) {     // the solver moved last and it mates
    const before = boardFromFen(moves[moves.length - 2].fen);
    for (const mv of legalMoves(before)) {
      const u = uciOf(mv);
      if (u === ucis[ucis.length - 1]) continue;
      const after = before.clone();
      push(after, mv);
      if (isCheckmate(after)) mates.push(playMove(before.clone(), u));
    }
  }
  const solver = boardFromFen(moves[0].fen).turn;
  return {
    id: p.id, source: 'lichess', fen: p.fen, rating: p.rating, colour: solver,
    themes: p.themes.map(t => ({ id: t, name: themeName(t) })),
    game_url: p.game_url || null, moves, mates,
  };
}

// ---------- the record and the rating ----------

const ATTEMPT = 'id, ts, solved, ms, hinted, rating';

/** The current record (what a reset hasn't moved aside), in the order it was written. */
export function attempts(db) {
  return db.all(`SELECT ${ATTEMPT} FROM puzzle_attempts WHERE archive IS NULL ORDER BY seq`);
}

/** One Glicko-1 rating period with a single game: the solver (r, rd) against a puzzle rated opp. */
export function glicko(r, rd, opp, score, oppRd = PUZZLE_RD) {
  const g = 1 / Math.sqrt(1 + 3 * Q * Q * oppRd * oppRd / Math.PI ** 2);
  const e = 1 / (1 + 10 ** (-g * (r - opp) / 400));
  const d2 = 1 / (Q * Q * g * g * e * (1 - e));
  const denom = 1 / (rd * rd) + 1 / d2;
  return [r + Q / denom * g * (score - e), Math.max(MIN_RD, Math.sqrt(1 / denom))];
}

export function stats(record) {
  let r = START_RATING, rd = START_RD;
  let streak = 0, best = 0, solved = 0;
  let lastDelta = null;
  for (const a of record) {
    const before = r;
    [r, rd] = glicko(r, rd, Number(a.rating), a.solved ? 1.0 : 0.0);
    lastDelta = pyRound(r) - pyRound(before);
    if (a.solved) {
      solved += 1;
      streak += 1;
      best = Math.max(best, streak);
    } else {
      streak = 0;
    }
  }
  return {
    rating: pyRound(r), rd: pyRound(rd), provisional: rd > PROVISIONAL_RD, played: record.length,
    solved, streak, best_streak: best, last_delta: lastDelta,
  };
}

const nowSeconds = () => Date.now() / 1000;

/** Append a first try; a second report for the same puzzle is ignored. Returns the new stats, or null when the
 * puzzle had been tried already. */
export function record(db, pid, puzzleRating, solved, ms = null, hinted = false, now = nowSeconds()) {
  return db.tx(() => {
    const rec = attempts(db);
    if (rec.some(a => a.id === pid)) return null;
    const a = { id: pid, ts: Math.floor(now), solved: !!solved && !hinted, ms, hinted: !!hinted, rating: Math.trunc(Number(puzzleRating)) };
    db.insert('puzzle_attempts', ATTEMPTS_SCHEMA, [a]);
    return stats([...rec, a]);
  });
}

const pad = n => String(n).padStart(2, '0');

/** time.strftime("%Y%m%d-%H%M%S") at `now`, local time. */
function stamp(now) {
  const d = new Date(now * 1000);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Move the current record aside as archive 'reset-<when>' (puzzles.archive's <name>.reset-<when>.jsonl), so a
 * reset can be undone. Returns the name the archived file would have had (puzzle_attempts.reset-<when>.jsonl,
 * what the reset route answers with), or null when there was nothing to move. */
export function archive(db, now = nowSeconds()) {
  return db.tx(() => {
    if (!db.value('SELECT count(*) FROM puzzle_attempts WHERE archive IS NULL')) return null;
    const base = `reset-${stamp(now)}`;
    let tag = base;
    for (let n = 2; db.value('SELECT count(*) FROM puzzle_attempts WHERE archive = ?', [tag]); n++) tag = `${base}-${n}`;
    db.run('UPDATE puzzle_attempts SET archive = ? WHERE archive IS NULL', [tag]);
    return `puzzle_attempts.${tag}.jsonl`;
  });
}

/** Start the rating over from 1500: the record is archived, not deleted (see archive()). */
export const reset = (db, now = nowSeconds()) => archive(db, now);

/** Every puzzle tried, before a reset as well: those stay out of the deal, so a new rating isn't propped up by
 * puzzles you remember the answer to. */
export function tried(db) {
  return new Set(db.column('SELECT DISTINCT id FROM puzzle_attempts'));
}

/** A random puzzle near `rating` carrying any of `themes` (all when empty), never one in `exclude`. The window
 * widens until something fits, so a narrow theme near the top or bottom still finds the closest puzzles. */
export function pick(rows, rating, themes = null, exclude = null, rng = Math.random) {
  const pool = rows.filter(r => (!themes?.size || r.themes.some(t => themes.has(t))) && !(exclude && exclude.has(r.id)));
  if (!pool.length) return null;
  for (let window = WINDOW; ; window += 100) {
    const near = pool.filter(r => Math.abs(r.rating - rating) <= window);
    if (near.length) return choice(near, rng);
  }
}

/** [the next library puzzle as line() has it, or null; the stats]. db: Store.progress(); pack: a Pack; themes: a
 * Set of theme ids (any of them) or null. */
export function nextPuzzle(db, pack, themes = null, skip = null, rng = Math.random) {
  const st = stats(attempts(db));
  const exclude = tried(db);
  if (skip) exclude.add(skip);
  const p = pick(pack.rows(), st.rating, themes, exclude, rng);
  return [p ? line(p) : null, st];
}
