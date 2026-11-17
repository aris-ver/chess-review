// The opening tree the Openings tab walks (docs/openings.md): book_tree.json, made from the lichess chess-openings
// TSVs by js/desktop/book.js's bookTree, with each book position's name and book moves, and over it where a player's
// games leave the book, what that cost and which book move to learn there.
//
// "Leaving the book" means what classify.js's in_book means: the first move whose position isn't a book position.
// The tree's keys are the book's (book.js) plus the start position, and a position's book moves are exactly the
// legal moves into a book position, transpositions included, so the two always agree.
//
// Pure: no I/O. The server reads the games and the evals; this sorts them out.

export const START_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

export const MINOR_COST = 3;     // an average cost under this (win % points) isn't a problem: listed last
export const MIN_GAMES = 2;      // a deviation is a line once in this many games, or once with a known cost

let names = [], pos = new Map();

/** Load book_tree.json (its text or the parsed object). */
export function loadTree(tree) {
  const t = typeof tree === 'string' ? JSON.parse(tree) : tree;
  names = t.names;
  pos = new Map(Object.entries(t.pos));
}

/** Whether a fen_key is a book position (the start position isn't one, as in book.js). */
export const inTree = key => key !== START_KEY && pos.has(key);

/** {eco, name} of a book position or the start position; null for one out of the book or with no name. */
export function nameOf(key) {
  const p = pos.get(key);
  if (!p || p[0] < 0) return null;
  const [eco, name] = names[p[0]];
  return { eco, name };
}

/** The book moves from a position, in UCI, the main ones first; [] out of the book. */
export function bookMoves(key) {
  const p = pos.get(key);
  return p && p[1] ? p[1].split(' ') : [];
}

/** Where one game leaves the book. rows: its positions in ply order ({ply, fen_key, move_played, side_to_move}).
 * {ply, key, move, side}: the position the move was played from, the move and who played it. null when the game
 * doesn't start from the start position or never leaves the book. */
export function deviation(rows) {
  if (!rows.length || rows[0].fen_key !== START_KEY) return null;
  for (let i = 0; i + 1 < rows.length; i++) {
    if (!inTree(rows[i + 1].fen_key)) {
      const r = rows[i];
      return { ply: r.ply, key: r.fen_key, move: r.move_played, side: r.side_to_move };
    }
  }
  return null;
}

/** The cost of a deviation: the deviating move's own wp_loss. moves: the game's moves rows ({ply, wp_loss}). null
 * when it has none (not analysed).
 *
 * Only that move: the moves after it mostly measure the player's middlegame, not the opening. On the main profile
 * (448 games) a player's out-of-book moves lose 7.4 points each on average, so a sum over the next five came to
 * about 37 for any line at all, and ranked a fine 3. Nc3 against the Queen's Gambit Accepted first. */
export function deviationCost(dev, moves) {
  const m = moves.find(x => x.ply === dev.ply);
  return m && m.wp_loss != null ? m.wp_loss : null;
}

/** The player's own deviations, grouped into lines. games: [{game_id, my_colour, positions, moves}], moves [] when
 * not analysed. Only deviations from a position with book moves count: one where the book has none left is the
 * book ending, not the player leaving it. Lines, most costly first:
 *     {key, side, name, games: [{game_id, ply, move, cost}], played: {uci: n}, path: [uci...], cost, minor, rank}
 * path is the most common move order from the start to key; cost the average over the games with one (null with
 * none); minor when that average is under MINOR_COST. A line's rank is games x cost, so unanalysed games count at
 * the line's average (0 with no cost known); minor lines come after the rest. */
export function lines(games) {
  const groups = new Map();
  for (const g of games) {
    const rows = [...g.positions].sort((a, b) => a.ply - b.ply);
    const dev = deviation(rows);
    // the opponent's deviations are v2; where the book has no move left it just ends, and there's nothing to learn
    if (!dev || dev.side !== g.my_colour || !bookMoves(dev.key).length) continue;
    const path = rows.filter(r => r.ply < dev.ply).map(r => r.move_played);
    let grp = groups.get(dev.key);
    if (!grp) groups.set(dev.key, grp = { key: dev.key, side: dev.side, games: [], paths: new Map() });
    grp.games.push({ game_id: g.game_id, ply: dev.ply, move: dev.move, cost: deviationCost(dev, g.moves || []) });
    const p = path.join(' ');
    grp.paths.set(p, (grp.paths.get(p) || 0) + 1);
  }

  const out = [];
  for (const grp of groups.values()) {
    const costs = grp.games.map(x => x.cost).filter(c => c !== null);
    if (grp.games.length < MIN_GAMES && !costs.length) continue;
    const cost = costs.length ? costs.reduce((s, c) => s + c, 0) / costs.length : null;
    const played = {};
    for (const x of grp.games) played[x.move] = (played[x.move] || 0) + 1;
    // the most common move order; the shortest, then the first in text order, among equals
    const [path] = [...grp.paths.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length
      || (a[0] < b[0] ? -1 : 1))[0];
    out.push({
      key: grp.key, side: grp.side, name: nameOf(grp.key),
      games: grp.games, played, path: path ? path.split(' ') : [], cost,
      minor: cost !== null && cost < MINOR_COST,
      rank: grp.games.length * (cost ?? 0),
    });
  }
  out.sort((a, b) => (a.minor - b.minor) || b.rank - a.rank || b.games.length - a.games.length
    || (a.key < b.key ? -1 : 1));
  return out;
}

/** The move to learn at a deviation position. multipv: its evals_multipv rows ({rank, move}), possibly none.
 * {move, book, checked}:
 *   - the book move the engine ranks highest among its lines (book, checked);
 *   - when none of its lines is a book move, the engine's first (not book, checked): the TSVs name dubious lines
 *     too (1. e4 e5 2. Nf3 f5, 2. Qh5 Nh6), and drilling those would teach a bad move;
 *   - with no engine lines at all, the main book move (book, not checked).
 * null when the position has no book moves. */
export function target(key, multipv = []) {
  const book = bookMoves(key);
  if (!book.length) return null;
  const ranked = [...multipv].sort((a, b) => a.rank - b.rank);
  const inBook = ranked.find(r => book.includes(r.move));
  if (inBook) return { move: inBook.move, book: true, checked: true };
  if (ranked.length) return { move: ranked[0].move, book: false, checked: true };
  return { move: book[0], book: true, checked: false };
}
