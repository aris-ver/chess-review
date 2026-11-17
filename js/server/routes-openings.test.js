// The explorer's routes through the router, over a profile of a few games and a small opening tree: the position's
// name, book moves and the games' counts, scores and accuracy, the games list, and every refusal.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { setBook } from '../core/book.js';
import { boardFromFen, fen, parseUci, push } from '../core/chess.js';
import { START_KEY } from '../core/opening-tree.js';
import { bookTree } from '../desktop/book.js';
import { nodeSqlite } from './db-node.js';
import { EVALS_SCHEMA, MOVES_SCHEMA, Store, writeGames } from './db.js';
import { fenKey } from '../core/fen.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';
import { serve } from './router.js';
import { slug } from './site.js';

const TSV = [
  'eco\tname\tpgn',
  'B00\tKing\'s Pawn Game\t1. e4',
  'C20\tKing\'s Pawn Game: Open\t1. e4 e5',
  'C40\tKing\'s Knight Opening\t1. e4 e5 2. Nf3',
  'C44\tOpen: Knight\t1. e4 e5 2. Nf3 Nc6',
  'B20\tSicilian Defense\t1. e4 c5',
  '',
].join('\n');
const TREE = bookTree([TSV]);

const pool = { size: 1, name: 'none', async load() {}, async search() { throw new Error('no engine here'); } };

/** positions rows of a game along UCI moves, as extractPositions gives them */
function rowsOf(id, ucis) {
  const b = boardFromFen(START_KEY + ' 0 1');
  const rows = [];
  for (const u of ucis) {
    rows.push({ game_id: id, ply: rows.length, fen: fen(b), move_played: u, side_to_move: b.turn, clock_remaining: null });
    push(b, parseUci(b, u));
  }
  rows.push({ game_id: id, ply: rows.length, fen: fen(b), move_played: null, side_to_move: b.turn, clock_remaining: null });
  return rows;
}
const keyAfter = ucis => fenKey(rowsOf('x', ucis).at(-1).fen);

const GAMES = [
  // id, my colour, result, played_at, moves, my accuracy per own move (null: not analysed)
  ['g1', 'white', 'win', '2026-11-01T10:00:00', ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'], 80],
  ['g2', 'white', 'loss', '2026-11-02T10:00:00', ['e2e4', 'e7e5', 'g1f3', 'd7d6'], 60],
  ['g3', 'white', 'draw', '2026-11-03T10:00:00', ['e2e4', 'e7e5', 'f1c4'], null],
  ['g4', 'black', 'win', '2026-11-04T10:00:00', ['e2e4', 'e7e5', 'g1f3', 'b8c6'], 90],
  ['g5', 'white', 'loss', '2026-11-05T10:00:00', ['d2d4', 'd7d5'], 50],
];

async function withRouter(fn, { tree = TREE, profile = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-routes-openings-'));
  setBook([]);
  const store = new Store(nodeSqlite(dir)), files = memoryFiles();
  const env = { store, files, profiles: new Profiles(files, store), ...(tree === null ? {} : { openingTree: async () => tree }) };
  try {
    if (profile) {
      const p = await env.profiles.create('chesscom', 'me');
      const db = await store.profile(p);
      const games = GAMES.map(([game_id, my_colour, result, played_at]) => ({ game_id: `https://x/${game_id}`, my_colour, result, played_at,
        opponent: `opp-${game_id}`, opponent_rating: 1500, time_class: 'blitz' }));
      writeGames(db, games, GAMES.flatMap(([id, , , , ucis]) => rowsOf(`https://x/${id}`, ucis)));
      const moves = GAMES.flatMap(([id, colour, , , ucis, acc]) => acc === null ? [] : ucis.map((u, ply) => ({
        game_id: `https://x/${id}`, ply, side_to_move: ply % 2 ? 'black' : 'white', is_mine: (ply % 2 ? 'black' : 'white') === colour,
        move_played: u, accuracy: acc })));
      db.insert('moves', MOVES_SCHEMA, moves);
      // the cache's eval after 1. e4 e5 2. Nf3 (black to move: +0.3 for white is -30 from black's side)
      db.insert('evals', EVALS_SCHEMA, [{ fen_key: keyAfter(['e2e4', 'e7e5', 'g1f3']), nodes: 1000, eval_cp: -30 }]);
    }
    const router = await serve({ env, pool, nodes: 1, scan: false });
    const ask = async path => {
      const out = await router.handle('GET', path, '', null);
      assert.equal(out.headers['Content-Type'], 'application/json', `${path} type`);
      return { status: out.status, body: JSON.parse(out.body) };
    };
    await fn(ask);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const P = '/api/openings/position?profile=chesscom-me';

test('position: the start, every game counted, the book moves after the ones played', async () => {
  await withRouter(async ask => {
    const r = await ask(P);
    assert.equal(r.status, 200);
    const b = r.body;
    assert.deepEqual([b.key, b.turn, b.in_book, b.left_at, b.name, b.games], [START_KEY, 'white', true, null, null, 5]);
    assert.deepEqual(b.score, { win: 2, draw: 1, loss: 2 });
    assert.deepEqual(b.next.map(m => [m.san, m.book, m.games]), [['e4', true, 4], ['d4', false, 1]]);
    assert.deepEqual(b.next[0].score, { win: 2, draw: 1, loss: 1 });
  });
});

test('position: after 1. e4 e5, colour, accuracy, the eval of where a move leads, unplayed book moves last', async () => {
  await withRouter(async ask => {
    const r = await ask(`${P}&moves=e2e4,e7e5&colour=white`);
    assert.equal(r.status, 200);
    const b = r.body;
    assert.deepEqual(b.path.map(p => p.san), ['e4', 'e5']);
    assert.deepEqual(b.name, { eco: 'C20', name: 'King\'s Pawn Game: Open' });
    assert.equal(b.games, 3);                         // g4 was played as black
    const [nf3, bc4] = b.next;
    assert.deepEqual([nf3.san, nf3.book, nf3.games, nf3.score], ['Nf3', true, 2, { win: 1, draw: 0, loss: 1 }]);
    assert.equal(nf3.accuracy, 70);                   // g1 at 80, g2 at 60
    assert.equal(nf3.eval, '+0.3');                   // white's view
    assert.deepEqual([bc4.san, bc4.book, bc4.games, bc4.accuracy, bc4.eval], ['Bc4', false, 1, null, null]);
    const all = await ask(`${P}&moves=e2e4,e7e5`);
    assert.equal(all.body.games, 4);
    assert.equal(all.body.next[0].games, 3);
  });
});

test('position: out of the book, the last book position names it', async () => {
  await withRouter(async ask => {
    const b = (await ask(`${P}&moves=e2e4,e7e5,g1f3,d7d6`)).body;
    assert.equal(b.in_book, false);
    assert.equal(b.left_at, 3);
    assert.deepEqual(b.name, { eco: 'C40', name: 'King\'s Knight Opening' });
    assert.equal(b.games, 1);
    assert.deepEqual(b.next, []);                     // g2 ended there
    // a position no game reached, in the book: only its book moves
    const c = (await ask(`${P}&moves=e2e4,c7c5`)).body;
    assert.deepEqual([c.in_book, c.games, c.next], [true, 0, []]);
  });
});

test('games: who reached it, and who played a move there, newest first', async () => {
  await withRouter(async ask => {
    const r = await ask('/api/openings/games?profile=chesscom-me&moves=e2e4,e7e5');
    assert.equal(r.status, 200);
    const id = g => slug(`https://x/${g}`);
    assert.deepEqual(r.body.games.map(g => [g.id, g.ply, g.result]),
      [[id('g4'), 2, 'win'], [id('g3'), 2, 'draw'], [id('g2'), 2, 'loss'], [id('g1'), 2, 'win']]);
    const nf3 = await ask('/api/openings/games?profile=chesscom-me&moves=e2e4,e7e5&move=g1f3&colour=white');
    assert.deepEqual(nf3.body.games.map(g => g.id), [id('g2'), id('g1')]);
    assert.deepEqual(Object.keys(nf3.body.games[0]).sort(),
      ['game_id', 'id', 'my_colour', 'opponent', 'opponent_rating', 'played_at', 'ply', 'result', 'time_class']);
  });
});

test('refusals: bad profile, bad moves, bad colour, no tree', async () => {
  await withRouter(async ask => {
    assert.equal((await ask('/api/openings/position?profile=a/b')).status, 400);
    assert.equal((await ask('/api/openings/position?profile=nobody')).status, 404);
    const illegal = await ask(`${P}&moves=e2e5`);
    assert.equal(illegal.status, 400);
    assert.match(illegal.body.error, /illegal move e2e5/);
    assert.equal((await ask(`${P}&colour=red`)).status, 400);
    assert.equal((await ask(`${P}&moves=${Array(81).fill('g1f3').join(',')}`)).status, 400);
    assert.equal((await ask('/api/openings/games?profile=chesscom-me&move=e2e5')).status, 400);
    assert.equal((await ask('/api/openings/nothing?profile=chesscom-me')).status, 404);
  });
  await withRouter(async ask => {
    const r = await ask(P);
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, 'no_tree');
  }, { tree: null });
});
