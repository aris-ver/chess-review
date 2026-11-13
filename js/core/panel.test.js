// The move panel's text (explain.reasons / moveLine, sent by site.panelFields): each sentence with its line and
// without, filler left out, and the one line Explain plays out. comment() itself is unchanged (the parity dumps).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setBook } from './book.js';
import { boardFromFen, moveFromUci, san } from './chess.js';
import { comment, moveLine, reasons, sentences } from './explain.js';
import { extract } from './facts.js';
import { panelFields } from '../server/site.js';

setBook([]);

const facts = ({ fen, played, label, ply, wp = [50, 50], before, after, multipv = null, clock = null, spent = null }) => {
  const board = boardFromFen(fen);
  const best = before.pv?.length ? san(board, moveFromUci(before.pv[0])) : null;
  return extract({ game_id: 'g', ply, side_to_move: board.turn, is_mine: true, move_played: played,
    san: san(board, moveFromUci(played)), best_san: best, label, wp_before: wp[0], wp_after: wp[1],
    wp_loss: wp[0] - wp[1], clock_remaining: clock, time_spent: spent }, board, before, after, multipv);
};
const quiet = pv => ({ eval_cp: 0, mate_in: null, pv });

// 4.Nc3?? leaves the rook on h1 to the queen on d5; Nf3 would have blocked
const HANG = { fen: 'rnb1kbnr/ppp2ppp/8/3qp3/6P1/8/PP1PPP1P/RNBQKBNR w KQkq - 0 4', played: 'b1c3', label: 'blunder',
  ply: 6, wp: [39, 7], before: { eval_cp: -122, mate_in: null, pv: ['g1f3', 'c8g4', 'b1c3'] },
  after: { eval_cp: 687, mate_in: null, pv: ['d5h1', 'g1f3', 'c8g4', 'd1a4', 'g4d7'] }, spent: 83 };

test('panel: a sentence with its line, and the same sentence without it', () => {
  const f = facts(HANG);
  assert.deepEqual(reasons(f).map(r => r.text), ['This leaves the rook on h1 hanging: 4... Qxh1 5. Nf3 Bxg4 6. Qa4+ Bd7.',
    'Nf3 keeps the rook on h1 safe.']);
  assert.deepEqual(reasons(f).map(r => r.short), ['This leaves the rook on h1 hanging.', 'Nf3 keeps the rook on h1 safe.']);
  // the comment keeps its full text, the clock sentence too; the panel's forms leave the clock out
  assert.equal(comment(f).at(-1), 'Played after thinking for 1:23.');
  assert.ok(!reasons(f).some(r => /^Played /.test(r.text)));
});

test('panel: a bad move plays out the reply, from after the move', () => {
  const f = facts(HANG);
  assert.deepEqual(moveLine(f, HANG.played), { base_ply: 7, san: ['Qxh1', 'Nf3', 'Bxg4', 'Qa4+', 'Bd7'],
    uci: ['d5h1', 'g1f3', 'c8g4', 'd1a4', 'g4d7'], on: 'after' });
  const p = panelFields(f, HANG.played, null, { ...HANG.before, side_to_move: 'white' }, { ...HANG.after, side_to_move: 'black' }, null);
  assert.deepEqual(p.short, ['This leaves the rook on h1 hanging.', 'Nf3 keeps the rook on h1 safe.']);
  assert.equal(p.line.base_ply, 7);
  assert.equal(p.line.eval, '-6.9');
  assert.equal('on' in p.line, false);
});

test('panel: "After <line>, <state>." loses its line as "<State>."; standing alone is filler', () => {
  const f = facts({ fen: 'rnbqkbnr/pp3ppp/2p5/3p4/3PP3/2N5/PP3PPP/R1BQKBNR b KQkq - 0 5', played: 'b7b5', label: 'mistake',
    ply: 9, wp: [51, 35], before: { eval_cp: 15, mate_in: null, pv: ['d5e4', 'c3e4'] },
    after: { eval_cp: 163, mate_in: null, pv: ['e4e5', 'b8a6', 'f1d3', 'g8e7', 'c3e2'] } });
  assert.deepEqual(comment(f), ['After 6. e5 Na6 7. Bd3 Ne7 8. Nce2, White is now winning.', 'dxe4 held the balance.']);
  assert.deepEqual(sentences(f).map(x => x.short), ['White is now winning.', 'dxe4 held the balance.']);
  // both sentences only say what the eval bar shows: nothing to explain, no line to play
  assert.deepEqual(reasons(f), []);
  assert.equal(moveLine(f, 'b7b5'), null);
});

test('panel: a verdict said again and a bare "X was better" are filler', () => {
  const inacc = facts({ fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', played: 'a1b1', label: 'inaccuracy',
    ply: 0, wp: [50, 45], before: quiet(['e1g1', 'e8g8']), after: quiet(['e8g8']) });
  assert.deepEqual(comment(inacc), ['Rb1 is an inaccuracy.', 'O-O was better.']);
  assert.deepEqual(reasons(inacc), []);
  const close = facts({ fen: '7k/8/8/8/8/8/6PP/7K w - - 0 40', played: 'h1g1', label: 'excellent', ply: 78,
    wp: [50, 49.5], before: quiet(['g2g4']), after: quiet(['h8g8']) });
  assert.deepEqual(reasons(close), []);
  const best = facts({ fen: '7k/8/8/8/8/8/6PP/7K w - - 0 40', played: 'h1g1', label: 'best', ply: 78,
    before: quiet(['h1g1']), after: quiet(['h8g8']) });
  assert.deepEqual(comment(best), ['Kg1 is the best move.']);
  assert.deepEqual(reasons(best), []);
});

test('panel: two sentences in one comment string are told apart', () => {
  const f = facts({ fen: 'r2qkb1r/2p1pppp/p4n2/2Pp4/5Bb1/3QPN2/PPP2PPP/RN2K2R b KQkq - 0 8', played: 'c7c6',
    label: 'good', ply: 15, wp: [44, 40], before: quiet(['g4f3', 'g2f3']), after: quiet(['b1c3']) });
  assert.deepEqual(comment(f), ['c6 is a good move. Bxf3 was better: it trades the bishop for the knight.']);
  assert.deepEqual(reasons(f).map(r => r.text), ['Bxf3 was better: it trades the bishop for the knight.']);
  // the reason is about the engine's choice: its line, from before the move
  assert.deepEqual(moveLine(f, 'c7c6'), { base_ply: 15, san: ['Bxf3', 'gxf3'], uci: ['g4f3', 'g2f3'], on: 'before' });
  const e = facts({ fen: 'r1bqkb1r/ppp1pppp/2n2n2/3p4/3P4/4PN2/PPP2PPP/RNBQKB1R w KQkq - 1 4', played: 'f1e2',
    label: 'excellent', ply: 6, wp: [55, 53], before: quiet(['c2c4', 'e7e6']), after: quiet(['c8f5']) });
  assert.deepEqual(comment(e), ['Be2 is an excellent move: it clears the way to castle. c4 was the engine\'s choice.']);
  assert.deepEqual(reasons(e).map(r => r.text), ['Be2 is an excellent move: it clears the way to castle.']);
  // about the move played: the move and the reply to it
  assert.deepEqual(moveLine(e, 'f1e2'), { base_ply: 6, san: ['Be2', 'Bf5'], uci: ['f1e2', 'c8f5'], on: 'played' });
});

test('panel: a miss plays out the move missed; a bare "Missed X" is filler', () => {
  const m = facts({ fen: '2B2R2/4k3/2Q5/4B3/3p4/8/PPP2P1P/R3K3 w Q - 1 27', played: 'c6d7', label: 'miss', ply: 52,
    wp: [100, 100], before: { eval_cp: null, mate_in: 1, pv: ['e5d6'] },
    after: { eval_cp: null, mate_in: -2, pv: ['e7f8', 'e5d4', 'f8g8', 'd7g7'] } });
  assert.deepEqual(reasons(m).map(r => r.short), ['Missed Bd6#, which was mate.', 'After Qd7+ there is still mate in 2.']);
  assert.deepEqual(moveLine(m, 'c6d7'), { base_ply: 52, san: ['Bd6#'], uci: ['e5d6'], on: 'before' });
  const stronger = facts({ fen: 'r3qrk1/pp1b1ppp/2n2n2/1BbN4/8/4BN2/PPP2PPP/R2QK2R b KQ - 2 11', played: 'c5e3',
    label: 'miss', ply: 21, wp: [92, 80], before: { eval_cp: 100, mate_in: null, pv: ['f6d5', 'd1d5'] },
    after: { eval_cp: 0, mate_in: null, pv: ['d5e3', 'f6g4', 'd1d2', 'g4e3', 'f2e3', 'a7a6'] } });
  assert.equal(comment(stronger)[0], 'Missed Nxd5, which was stronger: 11... Nxd5 12. Qxd5.');
  assert.ok(!reasons(stronger).some(r => r.text.startsWith('Missed')));
});

test('panel: a great move plays out the next best; a brilliant move the line after the offer', () => {
  const fen = 'r2k1b1r/pp1n4/4p2p/2P1B1p1/3R4/5N2/P4PPP/2K4R b - - 2 19';
  const multipv = [{ rank: 1, move: 'h8h7', eval_cp: 0, mate_in: null, pv: ['h8h7'] },
    { rank: 2, move: 'f8c5', eval_cp: -600, mate_in: null, pv: ['f8c5', 'e5h8', 'a7a6'] }];
  const g = facts({ fen, played: 'h8h7', label: 'great', ply: 37, before: quiet(['h8h7']), after: quiet(['e5g3']), multipv });
  assert.deepEqual(reasons(g).map(r => r.short), ['Rh7 moves the rook out of danger.', 'The next best, Bxc5, loses a rook for a pawn.']);
  assert.deepEqual(moveLine(g, 'h8h7'), { base_ply: 37, san: ['Bxc5', 'Bxh8', 'a6'], uci: ['f8c5', 'e5h8', 'a7a6'], on: 'second' });
  const p = panelFields(g, 'h8h7', null, { ...quiet(['h8h7']), side_to_move: 'black' }, { ...quiet(['e5g3']), side_to_move: 'white' }, multipv);
  assert.equal(p.line.eval, '+6.0');    // the next best's own eval, White's view

  const b = facts({ fen: '1k1r2nr/p2b2Qp/8/8/6p1/1P6/PK4PP/3B3n b - - 0 27', played: 'g8e7', label: 'brilliant', ply: 53,
    wp: [69, 70], before: quiet(['g8e7']), after: quiet(['g7e7', 'd7c6', 'e7c5', 'c6g2', 'd1g4']) });
  assert.deepEqual(reasons(b).map(r => r.short), ['Ne7 is brilliant: it offers the knight on e7.',
    'Taking it does not pay: Black is winning.']);
  assert.equal(moveLine(b, 'g8e7').base_ply, 54);
});

test('panel: book and forced moves have nothing to explain', () => {
  const f = facts({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', played: 'e2e4', label: 'book', ply: 0,
    before: quiet(['e2e4']), after: quiet(['e7e5']) });
  assert.deepEqual(reasons(f, 'King\'s Pawn'), []);
  assert.equal(moveLine(f, 'e2e4'), null);
});
