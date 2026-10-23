// The review files of chess_review/site.py: what the page reads under /p/<id>/.
//
//     profiles/<id>/site/games.json           {username, games: [summary...]}
//     profiles/<id>/site/games/<slug>.json    full review: every move with eval/label/clock/comment, key moments
//
// Each game is classified live from positions ⋈ evals, so writeGame can be called for one game while the server is
// still analysing it. Each review JSON carries the fingerprint of what it was built from, so build only redoes the
// games that are new or whose evals (or the code) changed since. (The fingerprint isn't Python's: the first JS build
// redoes every game once.) The static page itself (site.write_static) is served as it is and isn't written here.
//
// `db` is a profile's db.js connection (Store.profile(p)), `files` a profiles-files.js adapter, `p` a profiles.js
// profile. The JSON is JSON.stringify's, not json.dumps': the same values, but whole floats lose their ".0".

import { gameAccuracy } from '../core/accuracy.js';
import { boardFromFen } from '../core/chess.js';
import { classifyGame } from '../core/classify.js';
import { select } from '../core/critical.js';
import { comment, explain, headline, moveLabel } from '../core/explain.js';
import { extract } from '../core/facts.js';
import { povWinPct, toWhitePov } from '../core/pov.js';
import { formatFixed, pyRound } from '../core/py.js';
import { POSITIONS_SQL, gameFingerprint, loadMultipv, sha1 } from './classify.js';

/** The review's file name: a chess.com/lichess game's number, else a hash of its id. */
export function slug(gameId) {
  const tail = gameId.replace(/\/+$/, '').split('/').at(-1);
  return /^\d+$/.test(tail) ? tail : sha1(gameId).slice(0, 12);
}

/** White-POV display string: '+0.4', '-2.1', 'M3', '-M2', '#' for checkmate on board. */
export function evalText(evalCp, mateIn, sideToMove) {
  const [cp, mate] = toWhitePov(evalCp, mateIn, sideToMove);
  if (mate !== null) {
    if (mate === 0) return '#';
    return mate > 0 ? `M${mate}` : `-M${-mate}`;
  }
  if (cp === null) return null;
  const s = formatFixed(cp / 100, 1);
  return s.startsWith('-') ? s : `+${s}`;
}

function wpWhite(p) {
  if (p.eval_cp == null && p.mate_in == null) return null;
  return pyRound(povWinPct(p.eval_cp, p.mate_in, p.side_to_move, 'white'), 1);
}

function counts(moves, side) {
  const out = {};
  for (const m of moves) if (m.side_to_move === side && m.label) out[m.label] = (out[m.label] ?? 0) + 1;
  return out;
}

/** positions: positions ⋈ evals rows (terminal row last); moves: classified rows; both ordered by ply. */
export function buildGame(game, positions, moves, critical, multipv, username = 'me') {
  const posByPly = new Map(positions.map(p => [p.ply, p]));
  const critByPly = new Map(critical.map(c => [c.ply, c]));
  const p0 = positions[0];

  const outMoves = [], keyMoments = [];
  for (const m of moves) {
    const before = posByPly.get(m.ply), after = posByPly.get(m.ply + 1);
    const facts = m.label ? extract(m, boardFromFen(before.fen), before, after, multipv[before.fen_key] ?? null) : null;
    outMoves.push({
      ply: m.ply, san: m.san, uci: m.move_played, fen: after.fen,
      label: m.label, is_mine: m.is_mine,
      wp_white: wpWhite(after), eval: evalText(after.eval_cp, after.mate_in, after.side_to_move),
      wp_loss: m.wp_loss == null ? null : pyRound(m.wp_loss, 1),
      best_san: m.best_san, best_uci: before.best_move,
      clock: m.clock_remaining, spent: m.time_spent,
      comment: facts ? comment(facts, m.in_book ? game.opening_name : null) : [],
      hung: facts ? facts.hung_pieces.map(h => h.square) : [],
      reply_uci: facts && facts.refutation_uci.length ? facts.refutation_uci[0] : null,
      idea: facts ? facts.idea : [],
      threat: facts ? facts.threat : null,
    });
    const c = critByPly.get(m.ply);
    if (c && facts) {
      keyMoments.push({
        ply: c.ply, rank: c.rank, label: m.label,
        move: moveLabel(c.ply, m.san),
        headline: headline(facts), text: explain(facts),
        refutation_uci: facts.refutation_uci, best_uci: before.best_move,
        hung: facts.hung_pieces.map(h => h.square), motif: facts.motif,
      });
    }
  }

  const leftBook = moves.find(m => !m.in_book)?.ply ?? moves.length;
  const me = { name: game.my_name || username, rating: game.my_rating };
  const them = { name: game.opponent || 'opponent', rating: game.opponent_rating };
  const [white, black] = game.my_colour === 'white' ? [me, them] : [them, me];
  const evaluated = positions.filter(p => p.eval_cp != null || p.mate_in != null).length;
  return {
    id: slug(game.game_id), url: game.game_id,
    played_at: game.played_at,
    time_control: game.time_control, time_class: game.time_class,
    my_colour: game.my_colour, result: game.result, termination: game.termination,
    eco: game.eco, opening_name: game.opening_name, left_book_ply: leftBook,
    white: { ...white, accuracy: gameAccuracy(moves, 'white', wpWhite(p0)), counts: counts(moves, 'white') },
    black: { ...black, accuracy: gameAccuracy(moves, 'black', wpWhite(p0)), counts: counts(moves, 'black') },
    start_fen: p0.fen, start_wp_white: wpWhite(p0),
    analysed: positions.length ? pyRound(evaluated / positions.length, 3) : 0.0,
    moves: outMoves, key_moments: keyMoments.sort((a, b) => a.ply - b.ply),
  };
}

const INDEX_FIELDS = ['id', 'played_at', 'time_class', 'time_control', 'my_colour', 'result', 'termination', 'eco',
  'opening_name', 'analysed'];

/** The game's line in games.json. */
export function indexEntry(game, review) {
  const mine = game.my_colour, theirs = game.my_colour === 'white' ? 'black' : 'white';
  return {
    ...Object.fromEntries(INDEX_FIELDS.map(k => [k, review[k]])),
    opponent: game.opponent, opponent_rating: game.opponent_rating, my_rating: game.my_rating,
    my_accuracy: review[mine].accuracy, opp_accuracy: review[theirs].accuracy,
    n_moves: review.moves.length, n_key: review.key_moments.length,
    blunders: review[mine].counts.blunder ?? 0,
    brilliants: review[mine].counts.brilliant ?? 0,
    brilliants_any: (review.white.counts.brilliant ?? 0) + (review.black.counts.brilliant ?? 0),
  };
}

/** The review JSON, stamped with the fingerprint of what it was built from (see cached). */
function review(game, positions, multipv, username) {
  const moves = classifyGame(game, positions, multipv);
  const out = buildGame(game, positions, moves, select(moves), multipv, username);
  out.fp = gameFingerprint(game, positions, multipv, username);
  return out;
}

/** The review already on disk if it was built from exactly this input, else null. */
async function cached(files, path, fp) {
  let r;
  try {
    r = JSON.parse(await files.readText(path));
  } catch {
    return null;
  }
  return r?.fp === fp ? r : null;
}

const reviewPath = (p, id) => `${p.siteDir}/games/${id}.json`;

/** One game's review, built from the database now. */
export function gameReview(db, p, game) {
  const positions = db.all(`${POSITIONS_SQL} WHERE p.game_id = ? ORDER BY p.game_id, p.ply`, [game.game_id]);
  return review(game, positions, loadMultipv(db, game.game_id), p.username);
}

/** Rebuild one game's JSON (the server does, during on-demand analysis). Returns the index entry. */
export async function writeGame(db, files, p, gameId) {
  const game = db.get('SELECT * FROM games WHERE game_id = ?', [gameId]);
  if (game === undefined) throw new Error(`no such game: ${gameId}`);
  const r = gameReview(db, p, game);
  await files.writeText(reviewPath(p, r.id), JSON.stringify(r));
  return indexEntry(game, r);
}

/** Put one game's entry into games.json, replacing its old one; newest first. */
export async function updateIndex(files, p, entry) {
  const path = `${p.siteDir}/games.json`;
  const text = await files.readText(path);
  const data = text !== null ? JSON.parse(text) : { username: p.username, games: [] };
  data.games = data.games.map(g => (g.id === entry.id ? entry : g));
  if (!data.games.some(g => g.id === entry.id)) data.games.push(entry);
  const key = g => g.played_at || '';
  data.games.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  await files.writeText(path, JSON.stringify(data));
}

/** Every game's review JSON and the index, for one profile: {games, rebuilt, dir}. */
export async function build(db, files, p) {
  const games = db.all('SELECT * FROM games ORDER BY played_at DESC');
  const multipv = loadMultipv(db);
  const byGame = new Map();
  for (const r of db.all(`${POSITIONS_SQL} ORDER BY p.game_id, p.ply`)) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }
  const username = p.username;
  await files.mkdir(`${p.siteDir}/games`);
  const index = [];
  let rebuilt = 0;
  for (const g of games) {
    const pos = byGame.get(g.game_id);
    if (!pos || pos.length < 2) continue;
    // only games that are new, or whose evals (or the code) changed since their JSON was written, are redone
    const path = reviewPath(p, slug(g.game_id));
    let r = await cached(files, path, gameFingerprint(g, pos, multipv, username));
    if (r === null) {
      r = review(g, pos, multipv, username);
      await files.writeText(path, JSON.stringify(r));
      rebuilt += 1;
    }
    index.push(indexEntry(g, r));
  }
  await files.writeText(`${p.siteDir}/games.json`, JSON.stringify({ username, games: index }));
  return { games: index.length, rebuilt, dir: p.siteDir };
}
