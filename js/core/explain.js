// Plain-English rendering of MoveFacts. Format strings over structured data, nothing else.

import { band } from './critical.js';
import { capitalize, formatFixed, formatG } from './py.js';

export function moveLabel(ply, san) {
  const n = Math.floor(ply / 2) + 1;
  return ply % 2 === 0 ? `${n}. ${san}` : `${n}... ${san}`;
}

/** Render a SAN list with move numbers, e.g. '14...Nc6 15. Bxf7+ Kxf7'. */
export function line(sans, startPly) {
  return sans.map((san, i) => {
    const p = startPly + i;
    const n = Math.floor(p / 2) + 1;
    if (p % 2 === 0) return `${n}. ${san}`;
    return i === 0 ? `${n}... ${san}` : san;
  }).join(' ');
}

export function clock(seconds) {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return `${seconds} seconds`;
}

export function headline(f) {
  const who = f.is_mine ? 'You' : 'Opponent';
  if (f.missed_mate) return `${who} missed mate in ${f.missed_mate}`;
  if (f.allowed_mate) return `${who} allowed mate in ${f.allowed_mate}`;
  const label = f.label || 'move';
  if (f.wp_before != null && f.wp_after != null) {
    return `${capitalize(label)} — win chance ${formatFixed(f.wp_before, 0)}% → ${formatFixed(f.wp_after, 0)}%`;
  }
  return capitalize(label);
}

/** Ordered sentences. The first is the main reason, the rest are supporting facts. */
export function explain(f) {
  const s = [];
  const replyPly = f.ply + 1;
  const ref = f.refutation.length ? line(f.refutation, replyPly) : null;
  const best = f.best_san;
  const hung = f.hung_pieces.length ? f.hung_pieces[0] : null;
  const swing = f.material_swing;

  if (f.missed_mate && best) s.push(`${best} forces mate: ${line(f.best_line, f.ply)}.`);
  else if (f.allowed_mate && ref) s.push(`After ${ref} there is no defence.`);
  else if (hung && ref) s.push(`This hangs the ${hung.piece} on ${hung.square}: ${ref}.`);
  else if (f.motif && ref) s.push(`${f.refutation[0]} ${f.motif_detail}: ${ref}.`);
  else if (swing != null && swing <= -200 && ref) s.push(`Loses material after ${ref} (down ${formatG(Math.abs(swing) / 100)} pawns).`);
  else if (f.label === 'miss' && best) s.push(`Missed ${best}` + (f.best_line.length ? `: ${line(f.best_line, f.ply)}.` : '.'));
  else if (f.wp_after != null && f.wp_after >= 65 && ref) s.push(`Still better after ${ref}, but much of the advantage is gone.`);
  else if (ref) s.push(`The position falls apart after ${ref}.`);

  if (best && !f.missed_mate && f.label !== 'miss') {
    const b0 = f.wp_before != null ? band(f.wp_before) : 'equal';
    if (f.was_only_move) s.push(`${best} was the only move.`);
    else if (b0 === 'winning') s.push(`${best} kept the win.`);
    else if (b0 === 'losing') s.push(`${best} was the best chance.`);
    else s.push(`${best} held the balance.`);
  }

  if (f.clock_remaining != null) {
    let c = `Played with ${clock(f.clock_remaining)} remaining`;
    if (f.time_spent != null && f.time_spent >= 30) c += `, after thinking for ${clock(f.time_spent)}`;
    else if (f.time_spent != null && f.time_spent <= 2 && f.clock_remaining > 60) c += ', in under 3 seconds';
    s.push(c + '.');
  }
  return s;
}

/** One or two sentences for ANY move (the move list / current-move panel). Mistakes and worse get the full
 * explanation. */
export function comment(f, opening = null) {
  if (f.label == null) return [];
  if (f.label === 'book') return [`${f.san} is a book move.` + (opening ? ` (${opening})` : '')];
  if (f.label === 'forced') return [`${f.san} was the only legal move.`];
  if (f.label === 'brilliant') return [`${f.san} is brilliant — ${movedPiece(f)} sacrifice that keeps the position under control.`];
  if (f.label === 'great') return [`${f.san} is a great move — the only move that keeps things together.`];
  if (f.label === 'best') return [`${f.san} is the best move.`];
  if (f.label === 'excellent') return [`${f.san} is an excellent move.` + (f.best_san ? ` ${f.best_san} was the engine's choice.` : '')];
  if (f.label === 'good') return [`${f.san} is a good move.` + (f.best_san ? ` ${f.best_san} was better.` : '')];
  if (f.label === 'inaccuracy') {
    const s = [`${f.san} is an inaccuracy.`];
    if (f.best_san) s.push(`${f.best_san} was better.`);
    return s;
  }
  return explain(f);
}

const movedPiece = f => ({ N: 'a knight', B: 'a bishop', R: 'a rook', Q: 'a queen' })[f.san[0]] ?? 'a piece';
