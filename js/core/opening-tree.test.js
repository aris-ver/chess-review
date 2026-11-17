import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bookTree } from '../desktop/book.js';
import { boardFromFen, fen, parseUci, push } from './chess.js';
import { fenKey } from './fen.js';
import { START_KEY, bookMoves, deviation, deviationCost, inTree, lines, loadTree, nameOf, target } from './opening-tree.js';

const TSV = [
  'eco\tname\tpgn',
  'B00\tKing\'s Pawn Game\t1. e4',
  'C20\tKing\'s Pawn Game: Open\t1. e4 e5',
  'C44\tOpen: Knight\t1. e4 e5 2. Nf3 Nc6',
  'C44\tOpen: Knight, Bishop\t1. e4 e5 2. Nf3 Nc6 3. Bc4',
  'B20\tSicilian Defense\t1. e4 c5',
  'B27\tSicilian Defense: Knight\t1. e4 c5 2. Nf3',
  'A40\tQueen\'s Pawn\t1. d4 e5 2. e4',   // reaches no position of the e4 lines' (d4 and e4 both played)
  '',
].join('\n');

/** A game's positions rows along UCI moves from the start, as extractPositions gives them. */
function positions(ucis, start = START_KEY + ' 0 1') {
  const b = boardFromFen(start);
  const rows = [];
  for (const u of ucis) {
    rows.push({ ply: rows.length, fen_key: fenKey(fen(b)), move_played: u, side_to_move: b.turn });
    push(b, parseUci(b, u));
  }
  rows.push({ ply: rows.length, fen_key: fenKey(fen(b)), move_played: null, side_to_move: b.turn });
  return rows;
}
const keyAfter = ucis => positions(ucis).at(-1).fen_key;

/** moves rows for a game: wp_loss per ply from a list (null where not analysed). */
const movesOf = (rows, losses) => rows.slice(0, -1).map((r, i) => ({ ply: r.ply, side_to_move: r.side_to_move,
  wp_loss: losses[i] ?? null }));

loadTree(JSON.parse(JSON.stringify(bookTree([TSV]))));

test('tree: names are the shortest line ending there, or inherited along the shortest line', () => {
  assert.equal(nameOf(START_KEY), null);
  assert.deepEqual(nameOf(keyAfter(['e2e4'])), { eco: 'B00', name: 'King\'s Pawn Game' });
  assert.deepEqual(nameOf(keyAfter(['e2e4', 'e7e5'])), { eco: 'C20', name: 'King\'s Pawn Game: Open' });
  // after 2. Nf3 no line ends: the name of 1...e5's position, the last named on the way
  assert.deepEqual(nameOf(keyAfter(['e2e4', 'e7e5', 'g1f3'])), { eco: 'C20', name: 'King\'s Pawn Game: Open' });
  assert.deepEqual(nameOf(keyAfter(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'])), { eco: 'C44', name: 'Open: Knight, Bishop' });
  assert.equal(nameOf(keyAfter(['a2a3'])), null);
});

test('tree: book moves, the ones more lines take first, and a transposition counts', () => {
  assert.deepEqual(bookMoves(START_KEY), ['e2e4', 'd2d4']);       // 6 lines start 1. e4, one 1. d4
  assert.deepEqual(bookMoves(keyAfter(['e2e4'])), ['e7e5', 'c7c5']);
  assert.deepEqual(bookMoves(keyAfter(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'])), []);   // a leaf
  // no line plays 1. e4 e5 2. d4, but it reaches 1. d4 e5 2. e4's position: a book move by transposition, after the
  // moves lines play
  assert.ok(bookMoves(keyAfter(['e2e4', 'e7e5'])).includes('d2d4'));
  assert.equal(bookMoves(keyAfter(['e2e4', 'e7e5']))[0], 'g1f3');
  assert.ok(inTree(keyAfter(['e2e4'])));
  assert.ok(!inTree(START_KEY));
  assert.ok(!inTree(keyAfter(['a2a3'])));
});

test('deviation: the first move out of the book, with who played it', () => {
  const rows = positions(['e2e4', 'e7e5', 'g1f3', 'd7d6', 'f1c4']);
  assert.deepEqual(deviation(rows), { ply: 3, key: keyAfter(['e2e4', 'e7e5', 'g1f3']), move: 'd7d6', side: 'black' });
  assert.deepEqual(deviation(positions(['a2a3'])), { ply: 0, key: START_KEY, move: 'a2a3', side: 'white' });
  assert.equal(deviation(positions(['e2e4', 'e7e5'])), null);   // ends in book
  const other = positions(['e2e4'], 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w Qkq - 0 1');
  assert.equal(deviation(other), null);                         // not from the start position
  // once out, the game stays out: 2...Nf6 leaves, the knights go back to 1. e4 e5, and that's still ply 3
  const back = positions(['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'b8c6']);
  assert.ok(inTree(back.at(-1).fen_key));
  assert.equal(deviation(back).ply, 3);
});

test('deviationCost: the deviating move\'s own wp_loss, nothing after it', () => {
  const rows = positions(['e2e4', 'e7e5', 'g1f3', 'd7d6', 'f1c4', 'c8g4', 'b1c3']);
  const dev = deviation(rows);
  assert.equal(deviationCost(dev, movesOf(rows, [0, 0, 0, 4.5, 0, 30, 0])), 4.5);
  assert.equal(deviationCost(dev, movesOf(rows, [0, 0, 0, null, 0, 30])), null);
  assert.equal(deviationCost(dev, []), null);
});

test('lines: my deviations grouped by position, ranked by games x cost, minor ones last', () => {
  const devA = ['e2e4', 'e7e5', 'g1f3', 'd7d6'];        // black leaves after 2. Nf3
  const devB = ['e2e4', 'c7c5', 'b1c3'];                // white leaves after 1...c5
  const g = (id, colour, ucis, losses) => {
    const rows = positions(ucis);
    return { game_id: id, my_colour: colour, positions: rows, moves: losses ? movesOf(rows, losses) : [] };
  };
  const games = [
    g('a1', 'black', devA, [0, 0, 0, 10]),
    g('a2', 'black', devA, [0, 0, 0, 20]),
    g('a3', 'black', devA),                             // not analysed: counts at the line's average
    g('b1', 'white', devB, [0, 0, 1]),                  // costs 1: minor
    g('b2', 'white', devB, [0, 0, 2]),
    g('c1', 'black', ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']),   // leaves where the book ends: no line
    g('d1', 'white', ['e2e4', 'e7e5', 'g1f3', 'd7d6']), // the opponent's deviation: not mine
    g('e1', 'white', ['g2g3'], null),                   // once and unanalysed: not a line yet
  ];
  const ls = lines(games);
  assert.deepEqual(ls.map(l => l.key), [keyAfter(devA.slice(0, 3)), keyAfter(devB.slice(0, 2))]);
  const [a, b] = ls;
  assert.equal(a.side, 'black');
  assert.equal(a.cost, 15);
  assert.equal(a.rank, 45);
  assert.equal(a.minor, false);
  assert.deepEqual(a.played, { d7d6: 3 });
  assert.deepEqual(a.path, ['e2e4', 'e7e5', 'g1f3']);
  assert.deepEqual(a.name, { eco: 'C20', name: 'King\'s Pawn Game: Open' });
  assert.deepEqual(a.games.map(x => [x.game_id, x.ply, x.cost]), [['a1', 3, 10], ['a2', 3, 20], ['a3', 3, null]]);
  assert.equal(b.minor, true);
  assert.equal(b.cost, 1.5);
});

test('lines: a leaf of the book isn\'t a deviation; one position left by different moves is one line', () => {
  const leaf = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'];   // after 3. Bc4 the book has no move
  const game = (id, ucis) => ({ game_id: id, my_colour: 'black', positions: positions(ucis), moves: [] });
  assert.deepEqual(lines([game('x', leaf), game('y', leaf)]), []);
  // two games leave at one position with different moves: one line, both moves counted, no cost known
  const ls = lines([game('p', ['e2e4', 'e7e5', 'g1f3', 'd7d6']), game('q', ['e2e4', 'e7e5', 'g1f3', 'f7f6'])]);
  assert.equal(ls.length, 1);
  assert.deepEqual(ls[0].played, { d7d6: 1, f7f6: 1 });
  assert.equal(ls[0].cost, null);
  assert.equal(ls[0].rank, 0);
});

test('target: the book move the engine ranks highest; the engine\'s when it has no book move; else the main one', () => {
  const key = keyAfter(['e2e4', 'e7e5']);
  assert.deepEqual(target(key, [{ rank: 1, move: 'f1c4' }, { rank: 2, move: 'd2d4' }, { rank: 3, move: 'g1f3' }]),
    { move: 'd2d4', book: true, checked: true });
  assert.deepEqual(target(key, [{ rank: 2, move: 'g1f3' }, { rank: 1, move: 'd2d4' }]),
    { move: 'd2d4', book: true, checked: true });
  // the engine likes none of the book's moves: drill its own, not a dubious book move
  assert.deepEqual(target(key, [{ rank: 2, move: 'b1c3' }, { rank: 1, move: 'f1c4' }]),
    { move: 'f1c4', book: false, checked: true });
  assert.deepEqual(target(key), { move: 'g1f3', book: true, checked: false });
  assert.equal(target(keyAfter(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'])), null);
});
