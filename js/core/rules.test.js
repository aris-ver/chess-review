// Hand-made cases for labelling rules the parity dumps can't check: the dumps were regenerated from the rules
// themselves, and none of them holds a move that only the hung-material rule makes a blunder.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setBook } from './book.js';
import { boardFromFen, moveFromUci, san } from './chess.js';
import { classifyGame, hangsMaterial } from './classify.js';
import { comment, explain } from './explain.js';
import { extract, settledLength } from './facts.js';

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

// --- what the bad-move sentences claim (explain.js over facts.lostPiece / tradeOver / bestSaves) ------------------
// Positions from reviewed games, with the engine lines the review had.

const bad = ({ fen, played, label = 'blunder', ply, wp = [50, 10], before, after, clock = null, spent = null }) => {
  const board = boardFromFen(fen);
  const m = moveFromUci(played);
  const best = before.pv?.length ? san(board, moveFromUci(before.pv[0])) : null;
  return extract({ game_id: 'g', ply, side_to_move: board.turn, is_mine: true, move_played: played, san: san(board, m),
    best_san: best, label, wp_before: wp[0], wp_after: wp[1], wp_loss: wp[0] - wp[1], clock_remaining: clock,
    time_spent: spent }, board, before, after);
};

test('explain: a piece that was already hanging is "left hanging", and the better move keeps it', () => {
  // 4.Nc3: the queen on d5 already hit h1; Nf3 would have blocked
  const f = bad({ fen: 'rnb1kbnr/ppp2ppp/8/3qp3/6P1/8/PP1PPP1P/RNBQKBNR w KQkq - 0 4', played: 'b1c3', ply: 6,
    wp: [39, 7], before: { eval_cp: -122, mate_in: null, pv: ['g1f3', 'c8g4', 'b1c3'] },
    after: { eval_cp: 687, mate_in: null, pv: ['d5h1', 'g1f3', 'c8g4', 'd1a4', 'g4d7'] } });
  assert.equal(f.lost.kind, 'left');
  assert.deepEqual(explain(f).slice(0, 2), ['This leaves the rook on h1 hanging: 4... Qxh1 5. Nf3 Bxg4 6. Qa4+ Bd7.',
    'Nf3 keeps the rook on h1 safe.']);
});

test('explain: a capture that loses the capturing piece is a bad trade, not a hang', () => {
  const f = bad({ fen: 'rnbqkbnr/ppp2ppp/8/3pp3/8/2N1P3/PPPP1PPP/R1BQKBNR w KQkq - 0 3', played: 'c3d5', ply: 4,
    wp: [49, 11], before: { eval_cp: -11, mate_in: null, pv: ['d1h5', 'b8c6'] },
    after: { eval_cp: 575, mate_in: null, pv: ['d8d5', 'd2d4', 'f8e7', 'c2c4', 'd5e6'] } });
  assert.equal(explain(f)[0], 'Nxd5 takes a pawn but loses the knight: 3... Qxd5 4. d4 Be7 5. c4 Qe6.');
});

test('explain: a miss says what was missed, and that the move still mates', () => {
  const f = bad({ fen: '2B2R2/4k3/2Q5/4B3/3p4/8/PPP2P1P/R3K3 w Q - 1 27', played: 'c6d7', label: 'miss', ply: 52,
    wp: [100, 100], before: { eval_cp: null, mate_in: 1, pv: ['e5d6'] },
    after: { eval_cp: null, mate_in: -2, pv: ['e7f8', 'e5d4', 'f8g8', 'd7g7'] } });
  assert.deepEqual(explain(f), ['Missed Bd6#, which was mate.', 'After Qd7+ there is still mate in 2.']);
});

test('explain: allowing mate when already lost says so quietly', () => {
  const f = bad({ fen: 'r3kbnr/3b1ppp/pN6/n5B1/B2P4/5N2/PP3PPP/R3K2R b KQkq - 0 14', played: 'a8b8', label: 'mistake',
    ply: 27, wp: [7, 0], before: { eval_cp: -698, mate_in: null, pv: ['d7a4', 'b6a8'] },
    after: { eval_cp: null, mate_in: 1, pv: ['a4d7'] } });
  assert.deepEqual(explain(f), ['Mate follows: 15. Bxd7#.', 'Bxa4 was the best chance.']);
});

test('explain: a pawn let through to queen is named, and the clock only when it tells something', () => {
  const f = bad({ fen: '1k6/ppp4p/6p1/8/8/B2p3P/PP4K1/8 w - - 0 40', played: 'h3h4', ply: 78, wp: [81, 4], clock: 18,
    before: { eval_cp: 394, mate_in: null, pv: ['g2f3', 'd3d2'] },
    after: { eval_cp: 887, mate_in: null, pv: ['d3d2', 'a3b4', 'd2d1q', 'b4c3', 'b7b5'] } });
  assert.deepEqual(explain(f), ['This lets the d-pawn queen: 40... d2 41. Bb4 d1=Q 42. Bc3 b5.', 'Kf3 kept the win.',
    'Played with 18 seconds left.']);
  f.clock_remaining = 300;
  assert.equal(explain(f).length, 2);
  f.time_spent = 45;
  assert.equal(explain(f)[2], 'Played after thinking for 45 seconds.');
});

test('explain: losing no material, the sentence says how the game changed', () => {
  const f = bad({ fen: 'rnbqkbnr/pp3ppp/2p5/3p4/3PP3/2N5/PP3PPP/R1BQKBNR b KQkq - 0 5', played: 'b7b5', label: 'mistake',
    ply: 9, wp: [51, 35], before: { eval_cp: 15, mate_in: null, pv: ['d5e4', 'c3e4'] },
    after: { eval_cp: 163, mate_in: null, pv: ['e4e5', 'b8a6', 'f1d3', 'g8e7', 'c3e2'] } });
  assert.deepEqual(explain(f), ['After 6. e5 Na6 7. Bd3 Ne7 8. Nce2, White is now winning.', 'dxe4 held the balance.']);
});

test('explain: a line is shown to the end of the exchange it stops in', () => {
  // 1. Nxd5 ... the knight takes, the bishop takes back, the rook takes back: three plies, not one
  const b = boardFromFen('4k3/8/4b3/3p4/8/2N5/8/3RK3 w - - 0 1');
  assert.equal(settledLength(b, ['c3d5', 'e6d5', 'd1d5', 'e8e7'], 1), 3);
});

// --- what the good-move sentences say (explain.comment over facts.describeMove / secondLine / offered) -------------
// Positions from reviewed games; the engine lines are cut to what the sentence needs.

const said = ({ fen, played, label = 'best', ply, wp = [50, 50], before, after, multipv = null, prev = null }) => {
  const board = boardFromFen(fen);
  const best = before.pv?.length ? san(board, moveFromUci(before.pv[0])) : null;
  const f = extract({ game_id: 'g', ply, side_to_move: board.turn, is_mine: true, move_played: played,
    san: san(board, moveFromUci(played)), best_san: best, label, wp_before: wp[0], wp_after: wp[1],
    wp_loss: wp[0] - wp[1] }, board, before, after, multipv, prev);
  return comment(f);
};
const quiet = pv => ({ eval_cp: 0, mate_in: null, pv });

test('comment: a best capture says what it wins, and what it forks', () => {
  // 17.Nxd6+: the queen on a4 also checks once the knight leaves b5, so cxd6 is illegal
  assert.deepEqual(said({ fen: '1rq1k2r/p1p2p2/3b1pp1/1N1P4/Q3P3/8/PP3PPP/R3KB1R w KQk - 2 17', played: 'b5d6', ply: 32,
    before: quiet(['b5d6']), after: quiet(['e8e7', 'd6c8']),
    prev: { fen: '1rq1k2r/p1p1bp2/5pp1/1N1P4/Q3P3/8/PP3PPP/R3KB1R b KQk - 1 16', move_played: 'e7d6' } }),
  ['Nxd6+ wins the bishop on d6 and forks the king and the queen on c8.']);
});

test('comment: a capture on the square just captured on takes back, and without the move before only "takes"', () => {
  const fen = 'r1bqkbnr/1ppp1ppp/p1B5/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4';
  const prev = { fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4', move_played: 'b5c6' };
  const args = { fen, played: 'd7c6', ply: 7, before: quiet(['d7c6']), after: quiet(['e1g1']) };
  assert.deepEqual(said({ ...args, prev }), ['dxc6 takes back on c6.']);
  assert.deepEqual(said(args), ['dxc6 takes the bishop on c6.']);
});

test('comment: a capture the line answers by taking back is a trade', () => {
  assert.deepEqual(said({ fen: 'r1b1k1nr/ppp3pp/2n2q2/3p4/1b1P1B2/2N2N2/PPPQ2PP/2KR1B1R b kq - 1 10', played: 'b4c3',
    ply: 19, before: quiet(['b4c3']), after: quiet(['d2c3', 'c8g4']),
    prev: { fen: 'r1b1k1nr/ppp3pp/2n2q2/3p4/1b1P1B2/2N2N2/PPPQ2PP/R3KB1R w KQkq - 0 10', move_played: 'e1c1' } }),
  ['Bxc3 trades the bishop for the knight.']);
});

test('comment: a fork names both prongs', () => {
  assert.deepEqual(said({ fen: 'rnbqk2r/pppp1ppp/1b6/4P3/2B1PPn1/2N2N2/PPP3PP/R1BQK2R b KQkq - 2 7', played: 'g4f2',
    ply: 13, before: quiet(['g4f2']), after: quiet(['d1e2', 'f2h1']) }),
  ['Nf2 forks the queen on d1 and the rook on h1.']);
});

test('comment: a move that uncovers an attack threatens what it then takes', () => {
  // 22.Nd4: the rook on e1 now sees the knight on e4
  assert.deepEqual(said({ fen: 'r3k1r1/ppp3pp/8/8/4n1b1/6P1/PPP1N2P/2K1R3 w q - 3 22', played: 'e2d4', ply: 42,
    before: quiet(['e2d4']), after: quiet(['a8d8']) }),
  ['Nd4 threatens to take the knight on e4.']);
});

test('comment: a piece moved out of an attack, and one kept safe by another move', () => {
  assert.deepEqual(said({ fen: 'r2qk2r/1bp1npbp/p3p1pn/4P1B1/PppP4/2N2NP1/1P2QPBP/R4RK1 w kq - 0 13', played: 'c3e4',
    ply: 24, before: quiet(['c3e4']), after: quiet(['h6f5']) }),
  ['Ne4 moves the knight out of danger.']);
  // 13.O-O-O: the king now guards c2, which the queen on c5 attacked
  assert.deepEqual(said({ fen: 'r3kb1r/pp2nppp/8/2qPQ3/8/5B2/PPPB1PPP/R3K2R w KQkq - 3 13', played: 'e1c1', ply: 24,
    before: quiet(['e1c1']), after: quiet(['f7f6']) }),
  ['O-O-O keeps the pawn on c2 safe.']);
});

test('comment: answering a check by stepping in between', () => {
  assert.deepEqual(said({ fen: 'rnbqkb1r/pppp1ppp/5n2/4Q3/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 0 3', played: 'f8e7', ply: 5,
    before: quiet(['f8e7']), after: quiet(['b1c3']) }),
  ['Be7 blocks the check.']);
});

test('comment: a pawn move that the line follows up with the push it supports', () => {
  assert.deepEqual(said({ fen: 'rnbqkbnr/ppp2ppp/4p3/8/2pP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 0 4', played: 'e2e4', ply: 6,
    before: quiet(['e2e4']), after: quiet(['g8f6', 'd4d5']) }),
  ['e4 prepares d5.']);
});

test('comment: nothing to say about a best move keeps the plain sentence', () => {
  assert.deepEqual(said({ fen: '7k/8/8/8/8/8/6PP/7K w - - 0 40', played: 'h1g1', ply: 78,
    before: quiet(['h1g1']), after: quiet(['h8g8']) }), ['Kg1 is the best move.']);
});

test('comment: an excellent move barely worse than the engine\'s is as good as it', () => {
  assert.deepEqual(said({ fen: '7k/8/8/8/8/8/6PP/7K w - - 0 40', played: 'h1g1', label: 'excellent', ply: 78,
    wp: [50, 49.5], before: quiet(['g2g4']), after: quiet(['h8g8']) }),
  ['Kg1 is an excellent move, as good as the engine\'s g4.']);
});

test('comment: the engine\'s choice says what it does, or else the move played does', () => {
  assert.deepEqual(said({ fen: 'r2qkb1r/2p1pppp/p4n2/2Pp4/5Bb1/3QPN2/PPP2PPP/RN2K2R b KQkq - 0 8', played: 'c7c6',
    label: 'good', ply: 15, wp: [44, 40], before: quiet(['g4f3', 'g2f3']), after: quiet(['b1c3']) }),
  ['c6 is a good move. Bxf3 was better: it trades the bishop for the knight.']);
  assert.deepEqual(said({ fen: 'r1bqkb1r/ppp1pppp/2n2n2/3p4/3P4/4PN2/PPP2PPP/RNBQKB1R w KQkq - 1 4', played: 'f1e2',
    label: 'excellent', ply: 6, wp: [55, 53], before: quiet(['c2c4', 'e7e6']), after: quiet(['c8f5']) }),
  ['Be2 is an excellent move: it clears the way to castle. c4 was the engine\'s choice.']);
});

test('comment: an inaccuracy that costs 6% or more says why, when the material stays lost', () => {
  assert.deepEqual(said({ fen: 'r3kb1r/ppp1pppp/8/1N1Pn3/2P1n3/8/PB3KPP/3R1BNR w kq - 1 14', played: 'f2e3',
    label: 'inaccuracy', ply: 26, wp: [92, 84], before: quiet(['f2e1']),
    after: quiet(['e5g4', 'e3e4', 'g4f2', 'e4f3', 'f2d1']) }),
  ['Ke3 is an inaccuracy.', 'This loses a rook for a knight: 14... Ng4+ 15. Kxe4 Nf2+ 16. Kf3 Nxd1.', 'Ke1 was better.']);
});

test('comment: a great move says what the next best move would have cost', () => {
  const fen = 'r2k1b1r/pp1n4/4p2p/2P1B1p1/3R4/5N2/P4PPP/2K4R b - - 2 19';
  const mpv = second => [{ rank: 1, move: 'h8h7', eval_cp: 0, mate_in: null, pv: ['h8h7'] }, { rank: 2, ...second }];
  const args = { fen, played: 'h8h7', label: 'great', ply: 37, before: quiet(['h8h7']), after: quiet(['e5g3']) };
  assert.deepEqual(said({ ...args, multipv: mpv({ move: 'f8c5', eval_cp: -600, mate_in: null, pv: ['f8c5', 'e5h8'] }) }),
    ['Rh7 moves the rook out of danger.', 'The next best, Bxc5, loses a rook for a pawn: 19... Bxc5 20. Bxh8.']);
  assert.deepEqual(said({ ...args, multipv: mpv({ move: 'a7a6', eval_cp: -900, mate_in: null, pv: ['a7a6'] }) }),
    ['Rh7 moves the rook out of danger.', 'The next best, a6, leaves White winning.']);
  assert.deepEqual(said({ ...args, multipv: mpv({ move: 'a7a6', eval_cp: null, mate_in: -3, pv: ['a7a6'] }) }),
    ['Rh7 moves the rook out of danger.', 'The next best, a6, lets White mate in 3.']);
});

test('comment: a brilliant move names the piece on offer and why taking it fails', () => {
  const fen = '1k1r2nr/p2b2Qp/8/8/6p1/1P6/PK4PP/3B3n b - - 0 27';
  const args = { fen, played: 'g8e7', label: 'brilliant', ply: 53, wp: [69, 70], before: quiet(['g8e7']) };
  assert.deepEqual(said({ ...args, after: quiet(['g7e7', 'd7c6', 'e7c5', 'c6g2', 'd1g4']) }),
    ['Ne7 is brilliant: it offers the knight on e7.',
      'Taking it does not pay: after 28. Qxe7 Bc6 29. Qc5 Bxg2 30. Bxg4, Black is winning.']);
  // the engine's line never takes it: the sentence says so
  assert.deepEqual(said({ ...args, after: quiet(['d1g4', 'd7g4']) }),
    ['Ne7 is brilliant: it offers the knight on e7.', 'White does better not to take it: 28. Bxg4 Bxg4.']);
});

// --- where a line stops (facts.settledLength / settledTrade) -----------------------------------------------------

test('explain: a line runs on through a check to what it wins', () => {
  // 10.gxf3 ... 12.Nxc7+: the knight takes the rook on a8 after the king moves
  const f = bad({ fen: 'r1b1kb1r/ppp1pppp/5n2/1N1Pn3/1qP5/5p2/PP1B2PP/R2QKBNR b KQkq - 3 9', played: 'b4b2', ply: 17,
    wp: [80, 31], before: { eval_cp: 300, mate_in: null, pv: ['f3f2', 'e1f2', 'f6e4', 'f2e1', 'b4b2', 'a1c1'] },
    after: { eval_cp: 400, mate_in: null, pv: ['g2f3', 'e7e6', 'a1c1', 'e5g6', 'b5c7', 'e8d8', 'c7a8', 'f8c5', 'd1b3'] } });
  assert.equal(f.refutation.length, 7);
  assert.equal(explain(f)[0], 'This loses a rook and two pawns: 10. gxf3 e6 11. Rc1 Ng6 12. Nxc7+ Kd8 13. Nxa8.');
});

test('explain: no "loses a bishop" when the line wins it back a move later', () => {
  // 10...Nxd2 11.Nxd2 Bxd1 12.Bxd5 Rxd5, and 13.Rxd1 takes the bishop back
  const f = bad({ fen: '2kr1b1r/ppp2ppp/2n5/3q4/4n1b1/5NP1/PPPN1PBP/R1BQ1RK1 w - - 2 10', played: 'b2b3', ply: 18,
    wp: [45, 9], before: { eval_cp: 0, mate_in: null, pv: ['c2c3', 'e4d2'] },
    after: { eval_cp: 500, mate_in: null, pv: ['e4d2', 'f3d2', 'g4d1', 'g2d5', 'd8d5', 'f1d1', 'f8b4', 'c2c4', 'd5d3'] } });
  assert.equal(explain(f)[0], 'After 10... Nxd2 11. Nxd2 Bxd1 12. Bxd5 Rxd5 13. Rxd1, Black is now winning.');
});

test('settledLength: a long run of captures and checks stops six plies past the usual five', () => {
  const b = boardFromFen('2kr1b1r/1bp2ppp/p2qp3/3pN3/B2nP3/2N1P2P/PPP3P1/R1BQ1RK1 w - - 0 12');
  assert.equal(settledLength(b, ['e5f7', 'd4b5', 'a4b5', 'd5e4', 'd1d6', 'd8d6', 'f7h8', 'a6b5', 'f1f8', 'd6d8', 'f8d8',
    'c8d8'], 5), 11);
});

// --- forks, pins, skewers (facts.motif): pawns aren't targets, and the line must bear the pattern out -----------

test('explain: a pawn is no fork target; the line\'s material says what it costs', () => {
  // 54.Kc7: Rxa7+ "forked" the pawn on a3 and the king
  const f = bad({ fen: 'r7/P7/1K6/5k2/3R2p1/P7/6bP/8 w - - 20 54', played: 'b6c7', ply: 106, wp: [50, 13],
    before: { eval_cp: 0, mate_in: null, pv: ['d4b4', 'f5g5'] },
    after: { eval_cp: -400, mate_in: null, pv: ['a8a7', 'c7d6', 'a7a3', 'd4b4', 'g2f3', 'b4b5', 'f5g6'] } });
  assert.equal(f.motif, null);
  assert.equal(explain(f)[0], 'This loses two pawns: 54... Rxa7+ 55. Kd6 Rxa3 56. Rb4 Bf3.');
});

test('explain: a skewer by a piece that is simply taken is no skewer', () => {
  // 17...Rd8: Rxd8+ Kxd8
  const f = bad({ fen: 'r3kb1r/p5pp/2p1np2/4p3/1P6/6B1/P3P1PP/2KR1BNR b kq - 1 17', played: 'a8d8', label: 'mistake',
    ply: 33, wp: [40, 17], before: { eval_cp: 0, mate_in: null, pv: ['f8b4', 'g3e1'] },
    after: { eval_cp: 200, mate_in: null, pv: ['d1d8', 'e8d8', 'g3e1', 'f8d6', 'e2e3', 'd8e7'] } });
  assert.notEqual(f.motif, 'skewer');
  assert.equal(explain(f)[0], 'After 18. Rxd8+ Kxd8 19. Be1 Bd6 20. e3, White is now winning.');
});

test('explain: a pin the line wins nothing through is not given as the reason', () => {
  const f = bad({ fen: 'r1bqk2r/pppp1ppp/2n5/8/1b2n3/NQ3N2/PPPP1PPP/R1B1KB1R b KQkq - 1 7', played: 'd7d5', label: 'mistake',
    ply: 13, wp: [73, 58], before: { eval_cp: 0, mate_in: null, pv: ['e8g8', 'f1b5'] },
    after: { eval_cp: 0, mate_in: null, pv: ['f1b5', 'b4d6'] } });
  assert.equal(f.motif, 'pin');
  assert.equal(f.motif_backed, false);
  assert.equal(explain(f)[0], 'After 8. Bb5 Bd6, Black is only slightly better.');
});

test('explain: a fork the line wins through names the king first', () => {
  // 13.Nxc7+: Qxc7 would lose to Bxf6, so the engine's Kf8 is the answer and the rook on a8 goes
  const f = bad({ fen: 'r2qk2r/ppp2pbp/3p2p1/1N1Pp1B1/4Q3/5N2/PP3PPP/R4RK1 b kq - 2 12', played: 'g7f6', label: 'mistake',
    ply: 23, wp: [5, 3], before: { eval_cp: -600, mate_in: null, pv: ['d8d7', 'b5c3'] },
    after: { eval_cp: 900, mate_in: null, pv: ['b5c7', 'e8f8', 'g5f6', 'd8f6', 'c7a8', 'f8g7', 'a8c7', 'h8c8'] } });
  assert.equal(explain(f)[0], 'Nxc7+ forks the king and the rook on a8: 13. Nxc7+ Kf8 14. Bxf6 Qxf6 15. Nxa8.');
});

test('comment: a good move that hits a piece and a pawn attacks the piece, it doesn\'t fork', () => {
  assert.deepEqual(said({ fen: 'N1b4B/p2k1p1p/1p6/2p5/3p4/P2P1P2/3P1P1P/R3K2R b KQ - 0 18', played: 'c8b7', ply: 35,
    before: quiet(['c8b7']), after: quiet(['a8b6', 'a7b6']) }), ['Bb7 threatens to take the knight on a8.']);
});
