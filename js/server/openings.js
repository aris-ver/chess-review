// The Openings tab's explorer (docs/openings.md): a position reached along book moves or any others, its name and
// book moves from the opening tree (core/opening-tree.js), and how a profile's own games went from it.
//
// The tree comes from env.openingTree(), an async function giving book_tree.json's text or parsed object, read the
// first time the tab asks and kept for good: the web worker fetches it, the desktop reads it from app.asar (or makes
// it from DATA/book's TSVs in a checkout). Without one, everything here throws TreeMissing.

import { boardFromFen, copy, fen, parseUci, push, san } from '../core/chess.js';
import { fenKey } from '../core/fen.js';
import { START_KEY, bookMoves, inTree, loadTree, nameOf } from '../core/opening-tree.js';
import { BadRequest } from './http.js';
import { evalText } from './site.js';

export const MAX_PLIES = 80;         // the longest move list a position is asked for by
export const ACC_PLIES = 20;         // a move's accuracy: the player's own moves over this many plies from it (10 of theirs)
export const MAX_GAMES = 200;        // the most games one list gives
export const COLOURS = ['all', 'white', 'black'];

/** There is no opening tree here (none shipped, or it failed to load). */
export class TreeMissing extends Error {}

const loaded = new WeakMap();        // env → the promise of its tree loaded into opening-tree.js

/** Load env's opening tree once (opening-tree.js keeps one tree, as book.js keeps one book). */
export function ensureTree(env) {
  if (!loaded.has(env)) {
    const p = (async () => {
      if (!env.openingTree) throw new TreeMissing('no opening tree in this build');
      const t = await env.openingTree();
      if (!t) throw new TreeMissing('no opening tree in this build');
      loadTree(t);
    })();
    loaded.set(env, p);
    p.catch(() => loaded.delete(env));     // the next request tries again
  }
  return loaded.get(env);
}

/** The positions along UCI moves from the start: [{uci, san, fen}], with the board after the last. Throws
 * BadRequest for an illegal or malformed move, or more than MAX_PLIES of them. */
export function replay(ucis) {
  if (ucis.length > MAX_PLIES) throw new BadRequest(`at most ${MAX_PLIES} moves`);
  const board = boardFromFen(START_KEY + ' 0 1');
  const path = [];
  for (const u of ucis) {
    let m;
    try {
      m = parseUci(board, u);
    } catch (e) {
      throw new BadRequest(`illegal move ${u} after ${path.map(p => p.san).join(' ') || 'the start'}`);
    }
    if (m.null) throw new BadRequest('no null moves');
    const s = san(board, m);
    push(board, m);
    path.push({ uci: u, san: s, fen: fen(board) });
  }
  return { path, board };
}

/** "e2e4,e7e5" (or '' / null) → ['e2e4', 'e7e5']. */
export const parseMoves = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);

const colourWhere = colour => (colour === 'all' ? ['', []] : [' AND g.my_colour = ?', [colour]]);

/** The engine cache's eval of a position (one row a position) as the page shows it ('+0.4', 'M3'), or null. */
function cachedEval(db, key, sideToMove) {
  const r = db.get('SELECT eval_cp, mate_in FROM evals WHERE fen_key = ?', [key]);
  return r ? evalText(r.eval_cp, r.mate_in, sideToMove) : null;
}

/** One position of the explorer. db: the profile's (store.profile), with the evals attached. ucis: the moves from the
 * start; colour: 'all', or the colour the player had in the games counted.
 *     {path: [{uci, san, fen}], fen, key, turn, in_book, left_at, name: {eco, name} | null, eval,
 *      games, score: {win, draw, loss}, next: [{uci, san, book, games, score, accuracy, eval}]}
 * left_at: the index in path of the first move out of the book (null while in it); name: this position's, or out of
 * the book the last book position's; eval: the cache's, white's view. next: every move the games played from here,
 * most played first, then the book moves none of them played, in the book's order. A move's games and score count
 * the games (in the colour asked) that played it here; accuracy is the player's average over their moves in the
 * ACC_PLIES plies from it, in analysed games (null with none); eval is the cache's for the position it leads to. */
export function position(db, ucis, colour = 'all') {
  if (!COLOURS.includes(colour)) throw new BadRequest(`colour: one of ${COLOURS.join(', ')}`);
  const { path, board } = replay(ucis);
  const key = fenKey(fen(board));
  const keys = [START_KEY, ...path.map(p => fenKey(p.fen))];
  const out = keys.findIndex((k, i) => i > 0 && !inTree(k));
  const leftAt = out < 0 ? null : out - 1;
  const lastBook = leftAt === null ? key : keys[leftAt];
  const [cw, cp] = colourWhere(colour);

  const here = db.all(`
    WITH here AS (
      SELECT game_id, move_played, min(ply) AS ply FROM positions WHERE fen_key = ? GROUP BY game_id, move_played)
    SELECT h.move_played AS uci, count(*) AS games,
           sum(g.result = 'win') AS win, sum(g.result = 'draw') AS draw, sum(g.result = 'loss') AS loss,
           avg((SELECT avg(m.accuracy) FROM moves m
                WHERE m.game_id = h.game_id AND m.is_mine AND m.ply >= h.ply AND m.ply < h.ply + ?)) AS accuracy
    FROM here h JOIN games g ON g.game_id = h.game_id
    WHERE 1${cw}
    GROUP BY h.move_played`, [key, ACC_PLIES, ...cp]);
  const total = db.get(`
    SELECT count(*) AS games, coalesce(sum(g.result = 'win'), 0) AS win, coalesce(sum(g.result = 'draw'), 0) AS draw,
           coalesce(sum(g.result = 'loss'), 0) AS loss
    FROM games g WHERE g.game_id IN (SELECT game_id FROM positions WHERE fen_key = ?)${cw}`, [key, ...cp]);

  const book = bookMoves(key);
  const played = here.filter(r => r.uci !== null).sort((a, b) => b.games - a.games
    || (book.includes(b.uci) - book.includes(a.uci)) || (a.uci < b.uci ? -1 : 1));
  const seen = new Set(played.map(r => r.uci));
  const rows = [...played, ...book.filter(u => !seen.has(u)).map(uci => ({ uci, games: 0, win: 0, draw: 0, loss: 0, accuracy: null }))];
  const next = rows.map(r => {
    const m = parseUci(board, r.uci);
    const after = copy(board);
    push(after, m);
    return {
      uci: r.uci, san: san(board, m), book: book.includes(r.uci), games: r.games,
      score: { win: r.win, draw: r.draw, loss: r.loss },
      accuracy: r.accuracy === null ? null : Math.round(r.accuracy * 10) / 10,
      eval: cachedEval(db, fenKey(fen(after)), after.turn),
    };
  });
  return {
    path, fen: fen(board), key, turn: board.turn, in_book: leftAt === null, left_at: leftAt, name: nameOf(lastBook),
    eval: cachedEval(db, key, board.turn),
    games: total.games, score: { win: total.win, draw: total.draw, loss: total.loss }, next,
  };
}

/** The games (in the colour asked) that reached the position along ucis, and played `move` there when one is given:
 * newest first, at most MAX_GAMES. [{game_id, played_at, my_colour, result, opponent, opponent_rating, time_class,
 * ply}], ply being where the position came up (the move after it is ply's). */
export function games(db, ucis, colour = 'all', move = null) {
  if (!COLOURS.includes(colour)) throw new BadRequest(`colour: one of ${COLOURS.join(', ')}`);
  const { board } = replay(ucis);
  if (move !== null) {
    try {
      parseUci(board, move);
    } catch {
      throw new BadRequest(`illegal move ${move}`);
    }
  }
  const [cw, cp] = colourWhere(colour);
  return db.all(`
    SELECT g.game_id, g.played_at, g.my_colour, g.result, g.opponent, g.opponent_rating, g.time_class, min(p.ply) AS ply
    FROM positions p JOIN games g ON g.game_id = p.game_id
    WHERE p.fen_key = ?${move === null ? '' : ' AND p.move_played = ?'}${cw}
    GROUP BY g.game_id
    ORDER BY g.played_at DESC, g.game_id
    LIMIT ?`, [fenKey(fen(board)), ...(move === null ? [] : [move]), ...cp, MAX_GAMES]);
}
