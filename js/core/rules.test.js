// Hand-made cases for labelling rules the parity dumps can't check: the dumps were regenerated from the rules
// themselves, and none of them holds a move that only the hung-material rule makes a blunder.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setBook } from './book.js';
import { boardFromFen, moveFromUci } from './chess.js';
import { classifyGame, hangsMaterial } from './classify.js';
import { explain } from './explain.js';
import { extract } from './facts.js';

// 7.dxe4 in chess.com/game/live/187084467344 (White 547): 6...Nxe4 uncovered Be7 on the queen on g5; dxe4 takes
// the knight and leaves the queen. -3.26 -> -8.64, a graded win% loss of 19.2 (just under the blunder line).
const BEFORE = 'r1bq1rk1/ppppbppp/2n5/6Q1/2B1n3/3P4/PPP2PPP/RNB1K1NR w KQ - 0 7';
const AFTER = 'r1bq1rk1/ppppbppp/2n5/6Q1/2B1P3/8/PPP2PPP/RNB1K1NR b KQ - 0 7';
const BEST_PV = ['g5h5', 'e4f6', 'h5d1', 'd7d5', 'c4b3', 'f8e8', 'e1f1', 'c6d4', 'h2h3', 'c7c5'];
const REPLY_PV = ['e7g5', 'c1g5', 'd8g5', 'g1e2', 'd7d5', 'c4d5', 'c6b4', 'e1g1', 'g5h6', 'e2g3'];
const GAME = { game_id: 'g', my_colour: 'black', my_rating: 614, opponent_rating: 547, time_control: '600' };

const rows = (cpBefore, cpAfter, move = 'd3e4', after = AFTER, replyPv = REPLY_PV) => [
  { game_id: 'g', ply: 12, fen: BEFORE, side_to_move: 'white', move_played: move, clock_remaining: null,
    eval_cp: cpBefore, mate_in: null, best_move: 'g5h5', pv: BEST_PV },
  { game_id: 'g', ply: 13, fen: after, side_to_move: 'black', move_played: null, clock_remaining: null,
    eval_cp: cpAfter, mate_in: null, best_move: replyPv[0], pv: replyPv },
];
const label = r => classifyGame(GAME, r)[0].label;

setBook([]);

test('hung material: a queen left to a discovered attack loses a rook or more at every cut', () => {
  assert.equal(hangsMaterial(boardFromFen(BEFORE), moveFromUci('d3e4'), BEST_PV, REPLY_PV), true);
});

test('hung material: 7.dxe4 is a blunder, though its win% loss alone makes it a mistake', () => {
  assert.equal(label(rows(-326, 864)), 'blunder');
});

test('hung material: not when the eval drops less than five pawns', () => {
  assert.equal(label(rows(-326, 700)), 'mistake');
});

test('hung material: not when the mover was already lost (the losing side\'s rule decides)', () => {
  assert.notEqual(label(rows(-450, 1000)), 'blunder');
});

test('hung material: not when the queen is saved (the played line keeps the material)', () => {
  // 7.Qf4, the queen steps away: the engine's reply line wins nothing more
  const after = 'r1bq1rk1/ppppbppp/2n5/8/2B1nQ2/3P4/PPP2PPP/RNB1K1NR b KQ - 1 7';
  const pv = ['e4f6', 'c4b3', 'd7d5'];
  assert.equal(hangsMaterial(boardFromFen(BEFORE), moveFromUci('g5f4'), BEST_PV, pv), false);
  // a five-pawn eval drop that the win% curve alone grades a mistake: no material lost, so it stays one
  assert.equal(label(rows(-326, 830, 'g5f4', after, pv)), 'mistake');
});

// 14.Kf1 in the same game: 13...Nxc2+ forks the king and the rook on a1. Kd2 or Kf2 leave the back rank so Rh1
// takes the knight back on a1; Kf1 stands between them and the rook is lost for nothing (+1.78 -> -4.71).
const FORK = 'r4rk1/ppp2ppp/8/3B4/4PNb1/2N5/PPn3PP/R3K2R w KQ - 0 14';
const forkFacts = (u, reply) => extract(
  { game_id: 'g', ply: 26, side_to_move: 'white', is_mine: false, move_played: u, san: 'K', best_san: 'Kd2',
    label: 'blunder', wp_before: 66.6, wp_after: 15.4, wp_loss: 51.2 },
  boardFromFen(FORK), { eval_cp: 178, mate_in: null, pv: ['e1d2', 'c2a1', 'h2h3'] },
  { eval_cp: 471, mate_in: null, pv: reply });

test('explain: a king move that cuts the rook off from the recapture says so', () => {
  const f = forkFacts('e1f1', ['c2a1', 'f1f2', 'c7c6', 'h2h3', 'g4d7']);
  assert.deepEqual(f.hung_pieces[0].blocked, { piece: 'rook', square: 'h1', by: 'king', by_square: 'f1' });
  assert.match(explain(f)[0], /^The king on f1 blocks the rook on h1 from taking back on a1, so the rook there is lost for nothing: 14\.\.\. Nxa1/);
});

test('explain: no blocked recapture when the rook can take back', () => {
  const f = forkFacts('e1f2', ['c2a1', 'h1a1', 'c7c6']);
  assert.equal(f.hung_pieces[0]?.blocked, undefined);
});
