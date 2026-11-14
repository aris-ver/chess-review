// The move panel's text (explain.reasons / moveLine, sent by site.panelFields): each sentence with its line and
// without, filler left out, and the one line Explain plays out: the sequence its text prints, or none. comment()
// itself is unchanged (the parity dumps).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setBook } from './book.js';
import { boardFromFen, moveFromUci, san } from './chess.js';
import { comment, line, moveLine, reasons, sentences } from './explain.js';
import { extract } from './facts.js';
import { panelFields } from '../server/site.js';

setBook([]);

// every fixture the tests build, for the invariant at the end
const SEEN = [];
const facts = x => { const f = facts0(x); SEEN.push([x, f]); return f; };
const facts0 = ({ fen, played, label, ply, wp = [50, 50], before, after, multipv = null, clock = null, spent = null, prev = null }) => {
  const board = boardFromFen(fen);
  const best = before.pv?.length ? san(board, moveFromUci(before.pv[0])) : null;
  return extract({ game_id: 'g', ply, side_to_move: board.turn, is_mine: true, move_played: played,
    san: san(board, moveFromUci(played)), best_san: best, label, wp_before: wp[0], wp_after: wp[1],
    wp_loss: wp[0] - wp[1], clock_remaining: clock, time_spent: spent }, board, before, after, multipv, prev);
};
const quiet = pv => ({ eval_cp: 0, mate_in: null, pv });

// 4.Nc3?? leaves the rook on h1 to the queen on d5; Nf3 would have blocked
const HANG = { fen: 'rnb1kbnr/ppp2ppp/8/3qp3/6P1/8/PP1PPP1P/RNBQKBNR w KQkq - 0 4', played: 'b1c3', label: 'blunder',
  ply: 6, wp: [39, 7], before: { eval_cp: -122, mate_in: null, pv: ['g1f3', 'c8g4', 'b1c3'] },
  after: { eval_cp: 687, mate_in: null, pv: ['d5h1', 'g1f3', 'c8g4', 'd1a4', 'g4d7'] }, spent: 83 };

// 4.h3 hits the bishop on g4
const PUSH = { fen: 'rn1qkbnr/ppp2ppp/3p4/4p3/2B1P1b1/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 4', played: 'h2h3', label: 'best', ply: 6,
  before: quiet(['h2h3', 'g4h5']), after: quiet(['g4h5', 'd2d3', 'b8c6']) };

/** The move's facts, once checked that the panel has nothing for it: no text, no line, Explain greyed out. */
const empty = x => {
  const f = facts(x);
  const other = f.side === 'white' ? 'black' : 'white';
  assert.deepEqual(reasons(f), []);
  assert.equal(moveLine(f, x.played), null);
  assert.deepEqual(panelFields(f, x.played, null, { ...x.before, side_to_move: f.side }, { ...x.after, side_to_move: other }, null),
    { short: [], full: [], line: null });
  return f;
};

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

test('panel: "After <line>, <state>." loses its line as "<State>."; standing alone is filler, but a bad move keeps its line', () => {
  const f = facts({ fen: 'rnbqkbnr/pp3ppp/2p5/3p4/3PP3/2N5/PP3PPP/R1BQKBNR b KQkq - 0 5', played: 'b7b5', label: 'mistake',
    ply: 9, wp: [51, 35], before: { eval_cp: 15, mate_in: null, pv: ['d5e4', 'c3e4'] },
    after: { eval_cp: 163, mate_in: null, pv: ['e4e5', 'b8a6', 'f1d3', 'g8e7', 'c3e2'] } });
  assert.deepEqual(comment(f), ['After 6. e5 Na6 7. Bd3 Ne7 8. Nce2, White is now clearly better.', 'dxe4 held the balance.']);
  assert.deepEqual(sentences(f).map(x => x.short), ['White is now clearly better.', 'dxe4 held the balance.']);
  // both sentences only say what the eval bar shows: nothing to explain under the header
  assert.deepEqual(reasons(f), []);
  // but a mistake still has the line that punishes it: Explain shows it, and plays it from after the move
  assert.deepEqual(moveLine(f, 'b7b5'), { base_ply: 10, san: ['e5', 'Na6', 'Bd3', 'Ne7', 'Nce2'],
    uci: ['e4e5', 'b8a6', 'f1d3', 'g8e7', 'c3e2'], on: 'after' });
  const p = panelFields(f, 'b7b5', null, { eval_cp: 15, mate_in: null, side_to_move: 'black' },
    { eval_cp: 163, mate_in: null, side_to_move: 'white' }, null);
  assert.deepEqual(p.short, []);
  assert.deepEqual(p.full, ['After 6. e5 Na6 7. Bd3 Ne7 8. Nce2, White is now clearly better.']);
  assert.equal(p.line.base_ply, 10);
  assert.equal(p.line.eval, '+1.6');
  // an inaccuracy's line is the engine playing on, not a refutation: nothing to explain, nothing to play
  const inacc = facts({ fen: 'rnbqkbnr/pp3ppp/2p5/3p4/3PP3/2N5/PP3PPP/R1BQKBNR b KQkq - 0 5', played: 'b7b5', label: 'inaccuracy',
    ply: 9, wp: [51, 47], before: { eval_cp: 15, mate_in: null, pv: ['a7a6', 'g1f3'] },
    after: { eval_cp: 40, mate_in: null, pv: ['e4e5', 'b8a6', 'f1d3'] } });
  assert.deepEqual(reasons(inacc), []);
  assert.equal(moveLine(inacc, 'b7b5'), null);
  assert.deepEqual(comment(inacc), ['b5 is an inaccuracy.', 'a6 was better.']);
  const q = panelFields(inacc, 'b7b5', null, { eval_cp: 15, mate_in: null, side_to_move: 'black' },
    { eval_cp: 40, mate_in: null, side_to_move: 'white' }, null);
  assert.deepEqual([q.short, q.full, q.line], [[], [], null]);
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
    before: quiet(['h1h2']), after: quiet(['h8g8']) });
  assert.deepEqual(comment(best), ['Kg1 is the best move.']);
  assert.deepEqual(reasons(best), []);
});

test('panel: two sentences in one comment string are told apart', () => {
  const f = facts({ fen: 'r2qkb1r/2p1pppp/p4n2/2Pp4/5Bb1/3QPN2/PPP2PPP/RN2K2R b KQkq - 0 8', played: 'c7c6',
    label: 'good', ply: 15, wp: [44, 40], before: quiet(['g4f3', 'g2f3']), after: quiet(['b1c3']) });
  assert.deepEqual(comment(f), ['c6 is a good move. Bxf3 was better: it trades the bishop for the knight.']);
  assert.deepEqual(reasons(f).map(r => r.text), ['Bxf3 was better: it trades the bishop for the knight.']);
  // the reason is about the engine's choice, but prints none of its line: nothing to play
  assert.equal(moveLine(f, 'c7c6'), null);
  const e = facts({ ...PUSH, label: 'excellent', wp: [50, 48], before: quiet(['d2d3', 'b8c6']) });
  assert.deepEqual(comment(e), ['h3 is an excellent move: it threatens to take the bishop on g4. d3 was the engine\'s choice.']);
  assert.deepEqual(reasons(e).map(r => r.text), ['h3 is an excellent move: it threatens to take the bishop on g4.']);
  // the short form leaves the verdict to the header, as a best move reads
  assert.deepEqual(reasons(e).map(r => r.short), ['h3 threatens to take the bishop on g4.']);
  // about the move played, with no line printed: nothing to play
  assert.equal(moveLine(e, 'h2h3'), null);
});

test('panel: a miss plays out the move missed when it prints it; a bare "Missed X" is filler', () => {
  const m = facts({ fen: '2B2R2/4k3/2Q5/4B3/3p4/8/PPP2P1P/R3K3 w Q - 1 27', played: 'c6d7', label: 'miss', ply: 52,
    wp: [100, 100], before: { eval_cp: null, mate_in: 1, pv: ['e5d6'] },
    after: { eval_cp: null, mate_in: -2, pv: ['e7f8', 'e5d4', 'f8g8', 'd7g7'] } });
  assert.deepEqual(reasons(m).map(r => r.short), ['Missed Bd6#, which was mate.', 'After Qd7+ there is still mate in 2.']);
  // the mating move is named, no sequence printed: no line to play
  assert.equal(moveLine(m, 'c6d7'), null);
  const stronger = facts({ fen: 'r3qrk1/pp1b1ppp/2n2n2/1BbN4/8/4BN2/PPP2PPP/R2QK2R b KQ - 2 11', played: 'c5e3',
    label: 'miss', ply: 21, wp: [92, 80], before: { eval_cp: 100, mate_in: null, pv: ['f6d5', 'd1d5'] },
    after: { eval_cp: 0, mate_in: null, pv: ['d5e3', 'f6g4', 'd1d2', 'g4e3', 'f2e3', 'a7a6'] } });
  assert.equal(comment(stronger)[0], 'Missed Nxd5, which was stronger: 11... Nxd5 12. Qxd5.');
  assert.ok(!reasons(stronger).some(r => r.text.startsWith('Missed')));
  // with no reason, Explain shows the move missed with its line, and plays that
  assert.deepEqual(moveLine(stronger, 'c5e3'), { base_ply: 21, san: ['Nxd5', 'Qxd5'], uci: ['f6d5', 'd1d5'], on: 'before' });
  const p = panelFields(stronger, 'c5e3', null, { eval_cp: 100, mate_in: null, side_to_move: 'black' },
    { eval_cp: 0, mate_in: null, side_to_move: 'white' }, null);
  assert.deepEqual(p.full, ['Missed Nxd5, which was stronger: 11... Nxd5 12. Qxd5.']);
  assert.equal(p.line.base_ply, 21);
});

test('panel: a missed mate in two or more plays out the mate it prints', () => {
  const f = facts({ fen: '7k/2r3pp/8/8/8/8/8/RR4K1 w - - 0 1', played: 'a1a2', label: 'blunder', ply: 0, wp: [100, 50],
    before: { eval_cp: null, mate_in: 2, pv: ['b1b8', 'c7c8', 'b8c8'] }, after: { eval_cp: 0, mate_in: null, pv: ['c7c1', 'b1c1'] } });
  assert.deepEqual(reasons(f).map(r => r.text), ['Rb8+ mates in 2: 1. Rb8+ Rc8 2. Rxc8#.']);
  assert.deepEqual(reasons(f).map(r => r.short), ['Rb8+ mates in 2.']);
  assert.deepEqual(moveLine(f, 'a1a2'), { base_ply: 0, san: ['Rb8+', 'Rc8', 'Rxc8#'], uci: ['b1b8', 'c7c8', 'b8c8'], on: 'before' });
});

test('panel: a bad move whose only reason names the engine\'s move has no line to play', () => {
  // 3.a3? leaves the queen on h4 en prise: "Nxh4 wins the queen" names the move, prints no sequence
  const f = facts({ fen: 'rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', played: 'a2a3', label: 'mistake', ply: 4,
    wp: [80, 55], before: { eval_cp: 800, mate_in: null, pv: ['f3h4', 'g8f6'] }, after: { eval_cp: 0, mate_in: null, pv: ['h4h5', 'd2d3'] } });
  assert.deepEqual(reasons(f).map(r => r.text), ['Nxh4 wins the queen on h4.']);
  assert.equal(moveLine(f, 'a2a3'), null);
  const p = panelFields(f, 'a2a3', null, { eval_cp: 800, mate_in: null, side_to_move: 'white' }, { eval_cp: 0, mate_in: null, side_to_move: 'black' }, null);
  assert.deepEqual([p.full, p.line], [['Nxh4 wins the queen on h4.'], null]);
});

test('panel: a great move plays out the next best; a brilliant move the line after the offer', () => {
  const fen = 'r2k1b1r/pp1n4/4p2p/2P1B1p1/3R4/5N2/P4PPP/2K4R b - - 2 19';
  const multipv = [{ rank: 1, move: 'h8h7', eval_cp: 0, mate_in: null, pv: ['h8h7'] },
    { rank: 2, move: 'f8c5', eval_cp: -600, mate_in: null, pv: ['f8c5', 'e5h8', 'a7a6'] }];
  const g = facts({ fen, played: 'h8h7', label: 'great', ply: 37, before: quiet(['h8h7']), after: quiet(['e5g3']), multipv });
  // the rook stepping away goes without saying; what the next best loses is why the move is great
  assert.equal(comment(g)[0], 'Rh7 moves the rook out of danger.');
  assert.deepEqual(reasons(g).map(r => r.short), ['The next best, Bxc5, loses a rook for a pawn.']);
  assert.deepEqual(moveLine(g, 'h8h7'), { base_ply: 37, san: ['Bxc5', 'Bxh8', 'a6'], uci: ['f8c5', 'e5h8', 'a7a6'], on: 'second' });
  const p = panelFields(g, 'h8h7', null, { ...quiet(['h8h7']), side_to_move: 'black' }, { ...quiet(['e5g3']), side_to_move: 'white' }, multipv);
  assert.equal(p.line.eval, '+6.0');    // the next best's own eval, White's view

  const b = facts({ fen: '1k1r2nr/p2b2Qp/8/8/6p1/1P6/PK4PP/3B3n b - - 0 27', played: 'g8e7', label: 'brilliant', ply: 53,
    wp: [69, 70], before: quiet(['g8e7']), after: quiet(['g7e7', 'd7c6', 'e7c5', 'c6g2', 'd1g4']) });
  assert.deepEqual(reasons(b).map(r => r.short), ['Ne7 is brilliant: it offers the knight on e7.',
    'Taking it does not pay: Black is winning.']);
  assert.equal(moveLine(b, 'g8e7').base_ply, 54);
});

test('panel: a great move whose next best only leaves the game level has no line to play', () => {
  const fen = 'r2k1b1r/pp1n4/4p2p/2P1B1p1/3R4/5N2/P4PPP/2K4R b - - 2 19';
  const multipv = [{ rank: 1, move: 'h8h7', eval_cp: 0, mate_in: null, pv: ['h8h7'] },
    { rank: 2, move: 'f8e7', eval_cp: 0, mate_in: null, pv: ['f8e7', 'd4d7'] }];
  const g = facts({ fen, played: 'h8h7', label: 'great', ply: 37, before: quiet(['h8h7']), after: quiet(['e5g3']), multipv });
  assert.deepEqual(reasons(g).map(r => r.text), ['The next best, Be7, leaves the game level.']);
  assert.equal(moveLine(g, 'h8h7'), null);
});

test('panel: a book move has no reason or line, but Explain says the opening it comes from', () => {
  const f = facts({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', played: 'e2e4', label: 'book', ply: 0,
    before: quiet(['e2e4']), after: quiet(['e7e5']) });
  assert.deepEqual(reasons(f, 'King\'s Pawn Game'), []);
  assert.equal(moveLine(f, 'e2e4'), null);
  const before = { eval_cp: 0, mate_in: null, side_to_move: 'white' }, after = { ...before, side_to_move: 'black' };
  assert.deepEqual(panelFields(f, 'e2e4', 'King\'s Pawn Game', before, after, null),
    { short: [], full: ['e4 is theory in the King\'s Pawn Game.'], line: null });
  // no opening name: nothing to say beyond the header
  assert.deepEqual(panelFields(f, 'e2e4', null, before, after, null), { short: [], full: [], line: null });
});

test('panel: a forced move has nothing to explain', () => {
  const f = facts({ fen: '6rk/8/8/8/8/8/8/7K w - - 0 1', played: 'h1h2', label: 'forced', ply: 0,
    before: quiet(['h1h2']), after: quiet([]) });
  const before = { eval_cp: -900, mate_in: null, side_to_move: 'white' }, after = { ...before, side_to_move: 'black' };
  assert.deepEqual(panelFields(f, 'h1h2', null, before, after, null), { short: [], full: [], line: null });
});

// --- what goes without saying: the comment keeps it; the panel has no text and no line, and Explain is greyed out ---

test('panel: getting out of check, blocking it and taking back go without saying', () => {
  // the king steps out of a check, a queen down or not
  const kd8 = { fen: '4k3/8/8/8/8/8/5Q2/4R1K1 b - - 0 40', played: 'e8d8', label: 'best', ply: 79, wp: [5, 5],
    before: { eval_cp: -780, mate_in: null, pv: ['e8d8', 'f2f6'] }, after: { eval_cp: 780, mate_in: null, pv: ['f2f6', 'd8c7'] } };
  assert.deepEqual(comment(empty(kd8)), ['Kd8 gets the king out of check.']);
  empty({ ...kd8, wp: [50, 50], before: quiet(kd8.before.pv), after: quiet(kd8.after.pv) });
  const block = { fen: 'rnbqk1nr/pppp1ppp/8/4p3/1b1PP3/8/PPP2PPP/RNBQKBNR w KQkq - 1 3', played: 'c2c3', label: 'best', ply: 4,
    before: quiet(['c2c3', 'b4a5']), after: quiet(['b4a5', 'd4e5']) };
  assert.deepEqual(comment(empty(block)), ['c3 blocks the check.']);
  // 2...Qxd5 takes back the pawn that took on d5
  const back = { fen: 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2', played: 'd8d5', label: 'best', ply: 3,
    before: quiet(['d8d5', 'b1c3']), after: quiet(['b1c3', 'd5a5']),
    prev: { fen: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', move_played: 'e4d5' } };
  assert.deepEqual(comment(empty(back)), ['Qxd5 takes back on d5.']);
  // getting ready to castle, as the move played and as the engine's choice
  const prep = { fen: 'r1bqkb1r/ppp1pppp/2n2n2/3p4/3P4/4PN2/PPP2PPP/RNBQKB1R w KQkq - 1 4', played: 'f1e2', label: 'excellent',
    ply: 6, wp: [55, 53], before: quiet(['c2c4', 'e7e6']), after: quiet(['c8f5']) };
  assert.deepEqual(comment(empty(prep)), ['Be2 is an excellent move: it clears the way to castle. c4 was the engine\'s choice.']);
  const inacc = { ...prep, played: 'a2a3', label: 'inaccuracy', wp: [55, 50], before: quiet(['f1e2', 'c8f5']) };
  assert.deepEqual(comment(empty(inacc)), ['a3 is an inaccuracy.', 'Be2 was better: it clears the way to castle.']);
});

test('panel: material won and a threat made are still said, with nothing to play', () => {
  // 4...Qxh1 takes the rook 4.Nc3 left: said even with the game decided
  const f = facts({ fen: 'rnb1kbnr/ppp2ppp/8/3qp3/6P1/2N5/PP1PPP1P/R1BQKBNR b KQkq - 1 4', played: 'd5h1', label: 'best', ply: 7,
    wp: [93, 93], before: { eval_cp: 687, mate_in: null, pv: ['d5h1', 'g1f3'] }, after: { eval_cp: -687, mate_in: null, pv: ['g1f3', 'c8g4'] },
    prev: { fen: HANG.fen, move_played: 'b1c3' } });
  assert.deepEqual(reasons(f).map(r => r.short), ['Qxh1 wins the rook on h1.']);
  assert.equal(moveLine(f, 'd5h1'), null);
  const t = facts(PUSH);
  assert.deepEqual(reasons(t).map(r => r.short), ['h3 threatens to take the bishop on g4.']);
  assert.equal(moveLine(t, 'h2h3'), null);
  // the engine's choice made the threat: that is why it was better
  const g = facts({ ...PUSH, played: 'a2a3', label: 'good', wp: [50, 46], after: quiet(['b8c6', 'h2h3']) });
  assert.deepEqual(reasons(g).map(r => r.short), ['h3 was better: it threatens to take the bishop on g4.']);
  assert.equal(moveLine(g, 'a2a3'), null);
});

test('panel: with the game decided either way, only material and mate are worth a word', () => {
  // the same threat, lost and won: nothing is at stake
  assert.deepEqual(comment(empty({ ...PUSH, wp: [4, 4] })), ['h3 threatens to take the bishop on g4.']);
  assert.deepEqual(comment(empty({ ...PUSH, wp: [96, 96] })), ['h3 threatens to take the bishop on g4.']);
  assert.deepEqual(comment(empty({ ...PUSH, played: 'a2a3', label: 'good', wp: [96, 94], after: quiet(['b8c6', 'h2h3']) })),
    ['a3 is a good move. h3 was better: it threatens to take the bishop on g4.']);
  // a move that takes the game there, or out of it, is not one of them
  assert.equal(reasons(facts({ ...PUSH, wp: [88, 91] })).length, 1);
});

// --- the rule over every fixture above: a line only where Explain prints it, and then exactly that line ---

test('panel: Play line plays exactly the sequence the Explain text prints, and only then', () => {
  assert.ok(SEEN.length > 20);
  const numbered = /\b\d+\.(\.\.)? \S/;
  for (const [x, f] of SEEN) {
    const other = f.side === 'white' ? 'black' : 'white';
    const p = panelFields(f, x.played, null, { ...x.before, side_to_move: f.side }, { ...x.after, side_to_move: other }, x.multipv ?? null);
    const text = p.full.join(' ');
    if (p.line) assert.ok(text.includes(line(p.line.san, p.line.base_ply)), `${f.san}: ${text}`);
    if (!numbered.test(text)) assert.equal(p.line, null, `${f.san}: ${text}`);
  }
});
