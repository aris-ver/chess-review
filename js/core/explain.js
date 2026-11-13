// Plain-English rendering of MoveFacts. Format strings over structured data, nothing else.

import { band } from './critical.js';
import { capitalize, formatFixed } from './py.js';

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

const NUMBER = ['', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

/** 'a rook', 'two pawns', 'a rook and a pawn': roles, most valuable first. */
export function pieces(roles) {
  const counts = [];
  for (const r of roles) {
    const c = counts.find(x => x[0] === r);
    if (c) c[1]++;
    else counts.push([r, 1]);
  }
  const parts = counts.map(([r, n]) => (n === 1 ? `${r === 'queen' ? 'the' : 'a'} ${r}` : `${NUMBER[n] ?? n} ${r}s`));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
}

/** What a line wins for the mover, as words ('a knight', 'a rook for a knight', 'the bishop on c3'), or null when it
 * wins less than two pawns' worth. */
function gains(t) {
  if (!t || t.net < 200) return null;
  const promo = t.promotes.find(p => p.by_mover);
  if (promo && !t.won.length) return `a new queen on the ${promo.file}-file`;
  if (!t.won.length) return null;
  if (t.won.length === 1 && !t.lost.length && t.first) return `the ${t.won[0]} on ${t.first}`;
  return pieces(t.won) + (t.lost.length ? ` for ${pieces(t.lost)}` : '');
}

/** What a line loses for the mover, as a sentence about the line `ref`, or null when it loses less than two
 * pawns' worth (or what it loses isn't in the line shown). */
function losses(t, ref) {
  if (!t || t.net > -200) return null;
  const promo = t.promotes.find(p => !p.by_mover);
  if (promo) return `This lets the ${promo.file}-pawn queen: ${ref}.`;
  if (!t.lost.length) return null;
  return `This loses ${pieces(t.lost)}` + (t.won.length ? ` for ${pieces(t.won)}` : '') + `: ${ref}.`;
}

/** The sentence for the piece the refutation takes (facts.lostPiece). */
function lostSentence(f, l, ref) {
  if (l.blocked) {
    const b = l.blocked;
    return `The ${b.by} on ${b.by_square} blocks the ${b.piece} on ${b.square} from taking back on ${l.square}, `
      + `so the ${l.piece} there is lost for nothing: ${ref}.`;
  }
  if (l.kind === 'trade') return `${f.san} takes a ${l.captured} but loses the ${l.piece}: ${ref}.`;
  if (l.kind === 'moved') return `This puts the ${l.piece} on ${l.square}, where the ${l.taker} takes it: ${ref}.`;
  if (l.kind === 'left') return `This leaves the ${l.piece} on ${l.square} hanging: ${ref}.`;
  if (l.kind === 'unguarded') return `The ${l.guard} no longer guards the ${l.piece} on ${l.square}: ${ref}.`;
  return `This lets the ${l.taker} take the ${l.piece} on ${l.square}: ${ref}.`;
}

const SIDE = { white: 'White', black: 'Black' };

/** How the move changed the game, from the mover's win chance before and after: for a bad move that loses no
 * material the line shows. */
function standing(f, ref) {
  const me = SIDE[f.side] ?? 'The mover', them = f.side === 'white' ? 'Black' : f.side === 'black' ? 'White' : 'the opponent';
  const b = f.wp_before, a = f.wp_after;
  if (a == null || b == null) return `After ${ref}, the position is worse.`;
  let state;
  if (a >= 65) state = `${me} is still winning, but much of the advantage is gone`;
  else if (a >= 55) state = b >= 65 ? `${me} is only slightly better` : `${me}'s edge is smaller`;
  else if (a > 45) state = b >= 55 ? `the advantage is gone and the game is level` : `the game is level`;
  else if (a > 35) state = `${them} is now better`;
  else if (b <= 35) state = `${them}'s advantage grows`;
  else state = b >= 65 ? `the win is gone: ${them} is now winning` : `${them} is now winning`;
  return `After ${ref}, ${state}.`;
}

/** The second sentence: what the engine's choice did instead. `aboutLost`: the first sentence was about f.lost. */
function better(f, best, aboutLost) {
  if (f.was_only_move) return `${best} was the only move.`;
  if (f.best_saves && aboutLost) {
    const s = f.best_saves;
    return s.moved ? `${best} moves the ${s.piece} to safety.` : `${best} keeps the ${s.piece} on ${s.square} safe.`;
  }
  const g = gains(f.best_trade);
  if (g) return `${best} wins ${g}.`;
  const b0 = f.wp_before != null ? band(f.wp_before) : 'equal';
  if (b0 === 'winning') return `${best} kept the win.`;
  if (b0 === 'losing') return `${best} was the best chance.`;
  return `${best} held the balance.`;
}

/** What the engine's choice for a miss would have done. */
function missed(f, best) {
  const bl = f.best_line.length ? `: ${line(f.best_line, f.ply)}` : '';
  if (f.best_mate === 1) return `Missed ${best}, which was mate.`;
  if (f.best_mate) return `Missed ${best}, which mates in ${f.best_mate}${bl}.`;
  const g = gains(f.best_trade);
  if (g) return `Missed ${best}, which wins ${g}${bl}.`;
  const me = SIDE[f.side];
  if (me && f.wp_before != null && f.wp_before >= 65) return `Missed ${best}, which kept ${me} winning${bl}.`;
  if (me && f.wp_before != null && f.wp_before >= 55) return `Missed ${best}, which kept ${me} better${bl}.`;
  return `Missed ${best}${bl}.`;
}

/** The clock, when it says something about the move: little time left, a long think, or an instant move. */
function clockNote(f) {
  const left = f.clock_remaining, spent = f.time_spent;
  const parts = [];
  if (left != null && left < 30) parts.push(`with ${clock(left)} left`);
  if (spent != null && spent >= 30) parts.push(`after thinking for ${clock(spent)}`);
  else if (spent != null && spent <= 2 && left != null && left > 60) parts.push('in under 3 seconds');
  return parts.length ? `Played ${parts.join(', ')}.` : null;
}

/** Ordered sentences. The first is the main reason, the rest are supporting facts. */
export function explain(f) {
  const s = [];
  const replyPly = f.ply + 1;
  const ref = f.refutation.length ? line(f.refutation, replyPly) : null;
  const best = f.best_san;
  const l = ref ? f.lost : null;
  const lossLine = ref ? losses(f.trade, ref) : null;
  const lostAlready = f.wp_before != null && f.wp_before < 10;

  let aboutLost = false;
  if (f.label === 'miss' && best) {
    s.push(missed(f, best));
    if (f.still_mates) s.push(`After ${f.san} there is still mate in ${f.still_mates}.`);
  }
  else if (f.missed_mate && best) {
    s.push(f.missed_mate === 1 ? `${best} was mate.` : `${best} mates in ${f.missed_mate}: ${line(f.best_line, f.ply)}.`);
  }
  else if (f.allowed_mate && ref) {
    const n = f.allowed_mate === 1 ? 'mate' : `mate in ${f.allowed_mate}`;
    s.push(lostAlready ? `${capitalize(n)} follows: ${ref}.` : `This allows ${n}: ${ref}.`);
  }
  else if (l && (l.piece !== 'pawn' || l.blocked)) {
    s.push(lostSentence(f, l, ref));
    aboutLost = true;
  }
  else if (f.motif && ref) s.push(`${f.refutation[0]} ${f.motif_detail}: ${ref}.`);
  else if (lossLine) s.push(lossLine);
  else if (l) {
    s.push(lostSentence(f, l, ref));
    aboutLost = true;
  }
  else if (ref) s.push(standing(f, ref));

  if (best && !f.missed_mate && f.label !== 'miss') s.push(better(f, best, aboutLost));

  const c = clockNote(f);
  if (c) s.push(c);
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
