// Game accuracy as lila computes it: +1 per move, the harmonic mean's floor at 1.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gameAccuracy, moveAccuracy } from './accuracy.js';

/** One side's moves (white), each losing `losses[i]` win%; black's replies lose nothing. */
function side(losses) {
  const moves = [];
  let wp = 50;
  for (const loss of losses) {
    const after = Math.max(0, wp - loss);
    moves.push({ ply: moves.length + 1, side_to_move: 'white', wp_before: wp, wp_after: after, wp_loss: loss });
    moves.push({ ply: moves.length + 1, side_to_move: 'black', wp_before: 100 - after, wp_after: 100 - after, wp_loss: 0 });
    wp = after;
  }
  return moves;
}

test('accuracy: a perfect move is 100, a lost one 0, the curve carries lila\'s +1', () => {
  assert.equal(moveAccuracy(0), 100);
  assert.equal(moveAccuracy(100), 0);
  assert.ok(moveAccuracy(100) >= 0);
  assert.ok(Math.abs(moveAccuracy(10) - (103.1668 * Math.exp(-0.4354) - 3.1669 + 1)) < 1e-9);
  assert.ok(Math.abs(moveAccuracy(10) - 64.6) < 0.1, String(moveAccuracy(10)));
});

test('accuracy: one lost move does not halve the game', () => {
  const moves = side([...Array(39).fill(2), 100]);
  assert.ok(gameAccuracy(moves, 'white') > 50, String(gameAccuracy(moves, 'white')));
});

test('accuracy: a side that never loses anything is 100', () => {
  assert.equal(gameAccuracy(side(Array(20).fill(0)), 'white'), 100.0);
});
