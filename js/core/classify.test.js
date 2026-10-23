// Whole games through classify, critical, facts, explain and accuracy against the Python dump
// (scripts/dump_parity.py's games.json): the golden game single-PV and MultiPV, and made-up evals over it and over
// random games. The golden game must also reproduce tests/golden/clocks.json itself.
import { test } from 'node:test';

import { GOLDEN, checkDumpedGame, load, same } from '../parity.js';
import { pyRound } from './py.js';

const CASES = load('games.json');

for (const c of CASES) {
  test(`classify: ${c.name}`, () => checkDumpedGame(c));
}

test('classify: the golden game matches tests/golden/clocks.json', () => {
  const c = CASES.find(x => x.name === 'golden');
  const moves = checkDumpedGame(c);
  const view = {
    moves: moves.map(m => ({ ply: m.ply, san: m.san, label: m.label, best_san: m.best_san, wp_loss: m.wp_loss === null ? null : pyRound(m.wp_loss, 1) })),
    critical: c.critical.map(cr => {
      const e = c.explain[cr.ply];
      return { ply: cr.ply, rank: cr.rank, crosses_boundary: cr.crosses_boundary, headline: e.headline, text: e.text,
        hung: e.facts.hung_pieces.map(h => h.square), motif: e.facts.motif, missed_mate: e.facts.missed_mate,
        allowed_mate: e.facts.allowed_mate };
    }),
  };
  same(view, load('clocks.json', GOLDEN), 'golden');
});
