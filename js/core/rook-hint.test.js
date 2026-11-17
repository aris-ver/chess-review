// The rook drills' review hint (rook-hint.js): scores turned to white's view, the likely move, and every named hint on
// hand-made positions (with one move that isn't it beside each).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardFromFen, fen as fenOf, parseUci, push } from './chess.js';
import { HINT_CLAMP, likelyMove, namedHint, whiteScore } from './rook-hint.js';

const after = (fen, uci) => {
  const b = boardFromFen(fen);
  push(b, parseUci(b, uci));
  return fenOf(b);
};
const hintOf = (ending, before, uci, reply = null) => namedHint(ending, { before, uci, after: after(before, uci), reply });

test('whiteScore: the side to move\'s score as white\'s, mates and big scores clamped', () => {
  assert.equal(whiteScore('w', { cp: 120 }), 120);
  assert.equal(whiteScore('b', { cp: 120 }), -120);
  assert.equal(whiteScore('w', { cp: 4000 }), HINT_CLAMP);
  assert.equal(whiteScore('b', { cp: 4000 }), -HINT_CLAMP);
  assert.equal(whiteScore('w', { mate: 3 }), 1000);
  assert.equal(whiteScore('w', { mate: -3 }), -1000);
  assert.equal(whiteScore('b', { mate: -2 }), 1000);     // black to move, mated in 2: white wins
  assert.equal(whiteScore('b', { mate: 0 }), 1000);      // black mated on the board
  assert.equal(whiteScore('w', {}), null);
});

test('likelyMove: the biggest fall of 100 or more, the earliest on a tie, unscored moves skipped, wins held at 500', () => {
  const m = (b, a) => ({ score_before: b, score_after: a });
  assert.equal(likelyMove([m(600, 550), m(550, 0), m(0, -20)]), 1);
  assert.equal(likelyMove([m(600, 550), m(550, 480)]), null);       // nothing fell 100
  assert.equal(likelyMove([m(400, 300), m(300, 200)]), 0);          // a tie: the first
  // a win stays a win: falls are measured between scores held to +-500
  assert.equal(likelyMove([m(670, 1000), m(1000, 841), m(841, 817)]), null);
  assert.equal(likelyMove([m(1000, 650), m(650, 120)]), 1);
  assert.equal(likelyMove([m(-20, -700), m(-1000, -1000)]), 0);
  assert.equal(likelyMove([m(null, null), m(300, 0), m(0, null)]), 1);
  assert.equal(likelyMove([m(0, 100), m(100, 300)]), null);         // rises are no mistake
  assert.equal(likelyMove([]), null);
  // Philidor, white's view: letting black win is a fall too
  assert.equal(likelyMove([m(0, -10), m(-10, -900)]), 1);
});

test('namedHint, Lucena: the pawn left hanging, the rook no longer cutting the king off, the king out too soon', () => {
  // the king walks away from the pawn and the black rook takes it for free (or did take it: the reply)
  const hang = '8/7k/3P4/2K5/8/6R1/8/3r4 w - - 0 1';
  assert.equal(hintOf('Lucena', hang, 'c5b4'), 'pawn_hanging');
  assert.equal(hintOf('Lucena', hang, 'c5b4', 'd1d6'), 'pawn_hanging');
  assert.equal(hintOf('Lucena', hang, 'c5c6'), null);                 // still guarded
  // the rook on the e-file keeps the king on f7 away from the d-pawn; leaving the file lets it back
  const cut = '3K4/3P1k2/8/8/8/8/r7/4R3 w - - 0 1';
  assert.equal(hintOf('Lucena', cut, 'e1b1'), 'rook_cut');
  assert.equal(hintOf('Lucena', cut, 'e1e4'), null);                  // the bridge: still on the file
  // the king steps out from in front of the pawn with the rook still on the 1st rank: the checks start
  assert.equal(hintOf('Lucena', cut, 'd8c7', 'a2c2'), 'king_shelter');
  assert.equal(hintOf('Lucena', cut, 'd8c7'), 'king_shelter');        // the drill ended on it: no reply to see
  assert.equal(hintOf('Lucena', cut, 'd8c7', 'a2a3'), null);          // no check came
  const bridge = '3K4/3P1k2/8/8/4R3/8/r7/8 w - - 0 1';                // the rook on the 4th: stepping out is the plan
  assert.equal(hintOf('Lucena', bridge, 'd8c7', 'a2c2'), null);
  // a promotion is never "the mistake" by name
  assert.equal(hintOf('Lucena', '8/3P1k2/2K5/8/8/8/r7/4R3 w - - 0 1', 'd7d8q'), null);
});

test('namedHint, Philidor: the king off the pawn\'s path, the rook off the third rank too early, not behind in time', () => {
  const third = '8/8/8/4k3/4p3/7R/8/4K3 w - - 0 1';
  assert.equal(hintOf('Philidor', third, 'e1f1'), 'king_path');
  assert.equal(hintOf('Philidor', third, 'h3h8'), 'rook_third');
  assert.equal(hintOf('Philidor', third, 'h3g3'), null);              // along the third rank: still holding
  assert.equal(hintOf('Philidor', third, 'e1e2'), null);              // the king stays in front
  // the pawn is on the third: the rook belongs at the far end, checking from behind
  const behind = '8/8/8/8/8/4pk2/8/R3K3 w - - 0 1';
  assert.equal(hintOf('Philidor', behind, 'a1a2'), 'rook_behind');
  assert.equal(hintOf('Philidor', behind, 'a1a8'), null);
});
