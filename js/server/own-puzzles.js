// Puzzles from your own games, as chess_review/own_puzzles.py: the moves where you went wrong although one move
// clearly stood out, replayed as puzzles and brought back on a schedule until you find them.
//
// A position qualifies when it was your move, not forced and out of book, you lost at least MISTAKE win% with the
// move you played, you were level or better before it (wp_before >= 50) and MultiPV says the engine's first choice
// was the only good one (moves.only_move). The puzzle starts one move early, like a Lichess one. The solution is the
// engine's move, and then, the way lichess-puzzler does it, the engine's line for as long as each of your moves in it
// is the only good one too (walk()). Those searches run in the background (extend(), a server job) and go into the
// shared engine cache; until a puzzle's line is settled it is a one-move puzzle. The engine's line after the last
// move of the solution is handed along (`follow`) for the board to show once the puzzle is over.
//
// These stay out of the puzzle rating. Every finished showing goes into the profile's puzzle_attempts table
// (games.sqlite), and a puzzle you missed comes back after 1 day, then 3, then 7 days for as long as you keep
// finding it; a miss at any point starts it over. Solved first time, or found at the 7-day review, it is learned.
// Starting the schedule over (reset()) archives the record, and every puzzle is new again.
//
// Times (`now`, `ts`, `due`) are epoch seconds.

import { boardFromFen, fen, isGameOver, isLegal, moveFromUci, push, san, InvalidMoveError } from '../core/chess.js';
import { onlyMove } from '../core/classify.js';
import { MISTAKE } from '../core/config.js';
import { fenKey } from '../core/fen.js';
import { cachedLines } from './analyse.js';
import { sha1 } from './classify.js';
import { ATTEMPTS_SCHEMA } from './db.js';
import { archive, attempts as attemptRows, choice, line } from './puzzles.js';

export const INTERVALS = [1, 3, 7];   // days until the next showing, after a miss and then each review found
export const DAY = 86400;
export const FOLLOW_PLIES = 6;        // the engine's line after the answer, for the board to show
export const MAX_SOLVER_MOVES = 8;    // a solution stops here even while every move in it is still the only good one

export const CANDIDATES_SQL = `
    SELECT m.game_id, m.ply, m.side_to_move, m.san, m.best_move, m.best_san, m.label, m.wp_before, m.wp_after,
           prev.fen AS setup_fen, prev.move_played AS setup_move, e.pv,
           g.opponent, g.played_at, g.time_class, g.my_colour
    FROM moves m
    JOIN positions p ON p.game_id = m.game_id AND p.ply = m.ply
    JOIN positions prev ON prev.game_id = m.game_id AND prev.ply = m.ply - 1
    JOIN games g ON g.game_id = m.game_id
    LEFT JOIN evals e ON e.fen_key = p.fen_key
    WHERE m.is_mine AND NOT m.is_forced AND NOT m.in_book AND m.only_move
      AND m.wp_loss >= ${MISTAKE.toFixed(1)} AND m.wp_before >= 50 AND m.best_move IS NOT NULL AND m.best_move <> m.move_played
    ORDER BY g.played_at DESC, m.ply
`;

export const puzzleId = (gameId, ply) => 'm' + sha1(`${gameId}:${ply}`).slice(0, 10);

export const isOwnId = pid => typeof pid === 'string' && pid.length === 11 && pid.startsWith('m');

// SEAM (site): site.slug, until the `site` session's js/server/site.js lands; then import it from there and drop this
// copy. Pass { slug } to Pool to use another one meanwhile.
export function slug(gameId) {
  const tail = gameId.replace(/\/+$/, '').split('/').pop();
  return /^[0-9]+$/.test(tail) ? tail : sha1(gameId).slice(0, 12);
}

/** chess.Move.from_uci, null where python-chess raises ValueError. */
function parse(u) {
  if (typeof u !== 'string') return null;
  try {
    return moveFromUci(u);
  } catch (e) {
    if (e instanceof InvalidMoveError) return null;
    throw e;
  }
}

/** The engine's line after the answer, as legal moves with SAN and FEN (cut where it stops being legal). */
export function follow(fenAfterBest, pv) {
  const out = [], board = boardFromFen(fenAfterBest);
  for (const u of (pv ?? []).slice(1, 1 + FOLLOW_PLIES)) {
    const mv = parse(u);
    if (!mv || !isLegal(board, mv)) break;
    const s = san(board, mv);
    push(board, mv);
    out.push({ uci: u, san: s, fen: fen(board) });
  }
  return out;
}

// ---------- the line: as long as every move of yours is the only good one ----------

/** The solution from `board` (the solver to move; `first` is the game's best move there, already known to be the
 * only good one): [waiting, solution, pv]. linesOf(fen_key) gives a position's MultiPV rows, or undefined/null while
 * it isn't searched yet. Each solver move is MultiPV #1 of its position and the opponent's reply is the next move of
 * #1's line; the solution grows by a reply and the solver's next move only when that move is the only good one too,
 * so it always ends on a solver move. `pv` is #1's line from the last solver move on. `waiting` is the first position
 * on the way whose MultiPV isn't searched yet: the puzzle stays the one move it was ([first], pv null). */
export function walk(board, first, linesOf, maxSolverMoves = MAX_SOLVER_MOVES) {
  board = board.clone();
  const solver = board.turn;
  const solution = [];
  let pv = null, reply = null;
  for (;;) {
    const key = fenKey(fen(board));
    let ranks = linesOf(key);
    if (ranks === undefined || ranks === null) return [key, [first], null];
    ranks = ranks.filter(r => r.rank > 0 && r.move).sort((a, b) => a.rank - b.rank);   // rank 0: game over
    if (!ranks.length) break;
    const top = ranks[0];
    if (!solution.length && top.move !== first) break;   // the game's analysis named another move: keep it one move
    if (solution.length && !onlyMove(ranks, solver)) break;
    const mv = parse(top.move);
    if (!mv || !isLegal(board, mv)) break;
    if (reply) solution.push(reply);
    solution.push(top.move);
    pv = [...(top.pv?.length ? top.pv : [top.move])];
    push(board, mv);
    if (Math.floor((solution.length + 1) / 2) >= maxSolverMoves || isGameOver(board) || pv.length < 2) break;
    const answer = parse(pv[1]);
    if (!answer || !isLegal(board, answer)) break;
    push(board, answer);
    if (isGameOver(board)) break;
    reply = pv[1];
  }
  return [null, solution.length ? solution : [first], pv];
}

/** walk() for many puzzles at once, reading the cache a ply at a time for all of them (one query per round, not one
 * per position). fetch(keys) returns fen_key → MultiPV rows for the keys that are in the cache. */
export function settle(starts, fetch, maxSolverMoves = MAX_SOLVER_MOVES) {
  const known = new Map();
  const asked = new Set();
  for (;;) {
    const out = starts.map(([b, first]) => walk(b, first, k => known.get(k), maxSolverMoves));
    const need = [...new Set(out.map(([w]) => w).filter(w => w !== null && !asked.has(w)))];
    if (!need.length) return out;
    for (const k of need) asked.add(k);
    for (const [k, v] of Object.entries(fetch(need))) known.set(k, v);
  }
}

/** The position the solver faces (after the opponent's setup move) and the game's best move there, or null. */
export function start(r) {
  let board;
  try {
    board = boardFromFen(r.setup_fen);
  } catch {
    return null;
  }
  const setup = parse(r.setup_move), best = parse(r.best_move);
  if (!setup || !best) return null;
  push(board, setup);
  return isLegal(board, best) ? [board, r.best_move] : null;
}

/** One candidate row and its walk() as the puzzle the page plays. */
export function puzzle(profileId, r, walked, slugOf = slug) {
  let [, solution, pv] = walked;
  if (pv === null) pv = r.pv?.length && r.pv[0] === r.best_move ? r.pv : null;   // not settled yet: the one-move puzzle
  const pid = puzzleId(r.game_id, r.ply);
  const p = line({ id: pid, fen: r.setup_fen, moves: [r.setup_move, ...solution].join(' '), rating: null, themes: [] });
  const played = r.played_at;
  return Object.assign(p, {
    source: 'mine', profile: profileId, themes: [],
    follow: follow(p.moves[p.moves.length - 1].fen, pv),
    game: {
      slug: slugOf(r.game_id), ply: r.ply, opponent: r.opponent, date: played ? String(played).slice(0, 10) : null,
      time_class: r.time_class, played_san: r.san, label: r.label,
    },
  });
}

/** The background half: search every position the puzzles' lines are waiting on, a round (a ply) at a time, until
 * each line is settled. db: the profile's connection (Store.profile(p), the cache attached); search(keys) puts the
 * MultiPV of those positions into the cache (it may be async). Settled lines cost a few cache reads, nothing else. */
export async function extend(db, search, shouldStop = () => false, onProgress = null) {
  const starts = db.all(CANDIDATES_SQL).map(start).filter(Boolean);
  const searched = new Set();
  let out = [];
  for (;;) {
    out = settle(starts, keys => cachedLines(db, keys));
    const need = [...new Set(out.map(([w]) => w).filter(w => w !== null))].sort();
    const waiting = out.filter(([w]) => w !== null).length;
    if (onProgress) onProgress(out.length - waiting, out.length);
    if (!need.length || shouldStop() || need.every(k => searched.has(k))) break;    // (the last: a search that stored nothing)
    await search(need);
    for (const k of need) searched.add(k);
  }
  return {
    puzzles: out.length, searched: searched.size, waiting: out.filter(([w]) => w !== null).length,
    lines: out.filter(([, s]) => s.length > 1).length,
  };
}

/** What changes when a profile's classified moves do (classify.js's build rewrites them with their fingerprints),
 * standing in for moves.parquet's mtime. */
export function movesStamp(db) {
  const r = db.get(`SELECT count(*) n, group_concat(fp, ',') fps FROM (SELECT fp FROM move_fingerprints ORDER BY game_id)`);
  return `${db.value('SELECT count(*) FROM moves')}:${r.n}:${r.fps ?? ''}`;
}

/** Each profile's puzzles, rebuilt when its classified moves change (after an analysis or a refresh) or the
 * background job has settled more lines (invalidate()). store: db.js's Store. */
export class Pool {
  constructor(store, { slug: slugOf = slug, stamp = movesStamp } = {}) {
    this.store = store;
    this.slug = slugOf;
    this.stamp = stamp;
    this.cache = new Map();     // profile id → {stamp, puzzles, waiting}
  }

  invalidate(profileId) {
    this.cache.delete(profileId);
  }

  async puzzles(profile) {
    return (await this.load(profile)).puzzles;
  }

  /** How many of the profile's puzzles are still one-move puzzles until the background job searches more. */
  async waiting(profile) {
    return (await this.load(profile)).waiting;
  }

  async load(profile) {
    const db = await this.store.profile(profile);
    const stamp = this.stamp(db);
    const hit = this.cache.get(profile.id);
    if (hit && hit.stamp === stamp) return hit;
    const rows = db.all(CANDIDATES_SQL).map(r => [r, start(r)]).filter(([, s]) => s);
    const walked = settle(rows.map(([, s]) => s), keys => cachedLines(db, keys));
    const entry = {
      stamp, puzzles: rows.map(([r], i) => puzzle(profile.id, r, walked[i], this.slug)),
      waiting: walked.filter(([w]) => w !== null).length,
    };
    this.cache.set(profile.id, entry);
    return entry;
  }

  /** The puzzle with this id in any of `list` (profiles.js Profiles.list()'s profiles), or null. */
  async find(pid, list) {
    for (const p of list) {
      for (const z of await this.puzzles(p)) if (z.id === pid) return z;
    }
    return null;
  }
}

// ---------- the record and the schedule ----------

/** The profile's current record, in the order it was written: {id, ts, solved, ms, hinted}. */
export const attempts = db => attemptRows(db).map(({ rating, ...a }) => a);

/** puzzle id → {box, due, learned} (a Map): box is how many reviews in a row you've found it since the last miss. */
export function schedule(record) {
  const out = new Map();
  for (const a of [...record].sort((x, y) => x.ts - y.ts)) {
    const s = out.get(a.id);
    if (!a.solved) out.set(a.id, { box: 0, due: a.ts + INTERVALS[0] * DAY, learned: false });
    else if (s === undefined || s.learned) out.set(a.id, { box: null, due: null, learned: true });   // found first time
    else if (s.box + 1 < INTERVALS.length) out.set(a.id, { box: s.box + 1, due: a.ts + INTERVALS[s.box + 1] * DAY, learned: false });
    else out.set(a.id, { box: null, due: null, learned: true });
  }
  return out;
}

const nowSeconds = () => Date.now() / 1000;

export function stats(puzzles, sched, now = nowSeconds()) {
  const ids = new Set(puzzles.map(p => p.id));
  const seen = [...sched].filter(([k]) => ids.has(k)).map(([, v]) => v);
  const due = seen.filter(v => !v.learned && v.due <= now);
  const later = seen.filter(v => !v.learned && v.due > now).map(v => v.due);
  return {
    total: ids.size, new: [...ids].filter(i => !sched.has(i)).length, due: due.length,
    learning: later.length, learned: seen.filter(v => v.learned).length,
    next_due: later.length ? Math.min(...later) : null,
  };
}

/** The review that has waited longest, else a puzzle you haven't seen yet (in no particular order). */
export function pick(puzzles, sched, skip = null, now = nowSeconds(), rng = Math.random) {
  const pool = puzzles.filter(p => p.id !== skip);
  const due = pool.filter(p => sched.has(p.id) && !sched.get(p.id).learned && sched.get(p.id).due <= now)
    .sort((a, b) => sched.get(a.id).due - sched.get(b.id).due);
  if (due.length) return due[0];
  const fresh = pool.filter(p => !sched.has(p.id));
  return fresh.length ? choice(fresh, rng) : null;
}

/** [the next puzzle or null, the stats]. */
export async function nextPuzzle(pool, profile, skip = null, now = nowSeconds(), rng = Math.random) {
  const puzzles = await pool.puzzles(profile);
  const sched = schedule(attempts(await pool.store.profile(profile)));
  return [pick(puzzles, sched, skip, now, rng), stats(puzzles, sched, now)];
}

export async function summary(pool, profile, now = nowSeconds()) {
  const puzzles = await pool.puzzles(profile);
  return stats(puzzles, schedule(attempts(await pool.store.profile(profile))), now);
}

/** Start the review schedule over: every puzzle is new again. The record is archived, not deleted (puzzles.js's
 * archive), so moving it back undoes this. Returns the archived file's name, or null. */
export async function reset(pool, profile, now = nowSeconds()) {
  return archive(await pool.store.profile(profile), now);
}

/** Record one finished showing; returns the profile's stats and this puzzle's place in the schedule. */
export async function record(pool, profile, pid, solved, ms = null, hinted = false, now = nowSeconds()) {
  const db = await pool.store.profile(profile);
  const a = { id: pid, ts: Math.floor(now), solved: !!solved && !hinted, ms, hinted: !!hinted };
  db.insert('puzzle_attempts', ATTEMPTS_SCHEMA, [a]);
  const sched = schedule(attempts(db));
  return { stats: stats(await pool.puzzles(profile), sched, now), review: sched.get(pid) ?? null };
}
