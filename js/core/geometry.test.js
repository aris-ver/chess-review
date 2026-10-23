// Board geometry against python-chess: legal moves in python-chess's order, SAN, checks, pins, attackers, SEE,
// sacrifices, hung pieces, motifs, threats and ideas, on the positions in scripts/dump_parity.py's geometry.json
// (the Python tests' FENs, lichess puzzles, the fixture game).
import { test } from 'node:test';

import { load, same } from '../parity.js';
import {
  attackers, boardFromFen, castlingMoves, colorAt, copy, fen, givesCheck, hasCastlingRights, isCapture, isCheck,
  isCheckmate, isGameOver, isPinned, legalMoves, moveFromUci, opposite, push, san, uci,
} from './chess.js';
import { givesAway, isSacrifice, materialLost, sacrificeHolds } from './classify.js';
import { attackTargets, hungPieces, ideaArrows, material, materialSwing, motif, sans, see, threatMove } from './facts.js';

const CASES = load('geometry.json');

test(`geometry: ${CASES.length} positions`, () => {
  for (const c of CASES) {
    const at = c.fen;
    const pos = boardFromFen(c.fen);
    same(fen(pos), c.fen, `${at} fen`);
    const legal = legalMoves(pos);
    same(legal.map(uci), c.legal, `${at} legal`);
    same(legal.map(m => san(pos, m)), c.san, `${at} san`);
    same([isCheck(pos), isCheckmate(pos), isGameOver(pos)], [c.check, c.checkmate, c.game_over], `${at} check/mate/over`);
    same(castlingMoves(pos).map(uci), c.castling, `${at} castling`);
    same([hasCastlingRights(pos, 'white'), hasCastlingRights(pos, 'black')], c.castling_rights, `${at} castling rights`);
    for (const [sq, pinned] of c.pinned) same(isPinned(pos, colorAt(pos, sq), sq), pinned, `${at} pinned ${sq}`);
    for (const [sq, targets] of c.attack_targets) same(attackTargets(pos, sq), targets, `${at} attack targets ${sq}`);
    for (const [sq, w, b] of c.attackers) same([[...attackers(pos, 'white', sq)], [...attackers(pos, 'black', sq)]], [w, b], `${at} attackers ${sq}`);
    same([material(pos, 'white'), material(pos, 'black')], c.material, `${at} material`);
    same([materialSwing(pos, c.line, 'white'), materialSwing(pos, c.line.slice(0, 3), 'black')], c.material_swing, `${at} material swing`);
    same(legal.map(m => motif(pos, m)), c.motif, `${at} motif`);

    const mover = pos.turn;
    legal.forEach((m, i) => {
      const e = c.moves[i], where = `${at} ${e.uci}`;
      const after = copy(pos);
      push(after, m);
      const over = isGameOver(after);
      const got = {
        uci: uci(m), capture: isCapture(pos, m), see: isCapture(pos, m) ? see(pos, m) : null,
        sacrifice: isSacrifice(pos, m), fen_after: fen(after), gives_check: givesCheck(pos, m),
        hung: over ? null : hungPieces(after, mover),
      };
      if (!over) Object.assign(got, { threat: threatMove(pos, m, []), idea: ideaArrows(pos, m, []) });
      same(got, e, where);
    });

    if (c.with_line) {
      const played = moveFromUci(c.line[0]), reply = c.line.slice(1);
      const after = copy(pos);
      push(after, played);
      const over = isGameOver(after);
      same({
        threat: over ? null : threatMove(pos, played, reply),
        idea: over ? null : ideaArrows(pos, played, reply),
        gives_away: givesAway(pos, played, c.line, reply),
        material_lost: materialLost(pos, played, c.line, reply),
        sacrifice_holds: [null, -2, 3].map(m => sacrificeHolds(after, reply, mover, m)),
        sans: sans(pos, c.line, 5),
      }, c.with_line, `${at} with line ${c.line.join(' ')}`);
    }
    void opposite;
  }
});
