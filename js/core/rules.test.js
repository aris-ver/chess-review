// Hand-made cases for labelling rules the parity dumps can't check: the dumps were regenerated from the rules
// themselves, and none of them holds a move that only the hung-material rule makes a blunder.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setBook } from './book.js';
import { boardFromFen, moveFromUci, san } from './chess.js';
import { classifyGame, hangsMaterial } from './classify.js';
import { explain } from './explain.js';
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
