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
 * wins less than two pawns' worth, or the line stops before the material settles (facts.settledTrade). */
function gains(t) {
  if (!t || t.net < 200 || t.stable === false) return null;
  const promo = t.promotes.find(p => p.by_mover);
  if (promo && !t.won.length) return `a new queen on the ${promo.file}-file`;
  if (!t.won.length) return null;
  if (t.won.length === 1 && !t.lost.length && t.first) return `the ${t.won[0]} on ${t.first}`;
  return pieces(t.won) + (t.lost.length ? ` for ${pieces(t.lost)}` : '');
}

/** What a line loses for the mover, as a sentence about the line `ref`, or null when it loses less than two
 * pawns' worth (or what it loses isn't in the line shown, or the line stops before the material settles). */
function losses(t, ref) {
  if (!t || t.net > -200 || t.stable === false) return null;
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
  // a piece the line takes but the engine's line wins back (its material settles above two pawns down) wasn't lost
  const comesBack = f.trade?.stable === false && f.trade.settled > -200;
  const l = ref && !comesBack ? f.lost : null;
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

/** A clause for describeMove's data, to follow the move's SAN or "it": 'wins the pawn on e5'. null when there is
 * nothing to say. */
export function does(d) {
  if (!d) return null;
  const on = x => (x.piece === 'king' ? 'the king' : `the ${x.piece} on ${x.square}`);
  switch (d.kind) {
    case 'mate': return d.n === 1 ? 'mates' : `forces mate in ${d.n}`;
    case 'promotes': return `makes a new ${d.piece}`;
    case 'wins': return `wins ${on(d)}` + (d.for ? ` for the ${d.for}` : '') + (d.forks ? ` and forks ${d.forks.map(on).join(' and ')}` : '');
    case 'recapture': return `takes back on ${d.square}`;
    case 'trade': return d.piece === d.gives ? `trades ${d.piece}s` : `trades the ${d.gives} for the ${d.piece}`;
    case 'takes': return `takes ${on(d)}`;
    case 'fork': return `forks ${d.targets.map(on).join(' and ')}`;
    case 'blocks': return 'blocks the check';
    case 'escapes': return 'gets the king out of check';
    case 'check': {
      const g = gains(d.wins);
      return g ? `gives check and wins ${g}` : 'gives check';
    }
    case 'threat': return d.mate ? `threatens mate with ${d.mate}` : `threatens to take ${on(d)}`;
    case 'saves': return d.moved ? `moves the ${d.piece} out of danger` : `keeps ${on(d)} safe`;
    case 'castles': return 'castles';
    case 'attacks': return `attacks ${on(d)}`;
    case 'offers': return `offers a trade of ${d.piece}s`;
    case 'castle_prep': return 'clears the way to castle';
    case 'prepares': return `prepares ${d.san}`;
    default: return null;
  }
}

/** The move's own sentence from what it does ('Nxe5 wins the pawn on e5.'), or null. */
function itDoes(f) {
  const d = f.does;
  if (!d || d.kind === 'castles') return null;
  if (d.kind === 'mate' && d.n === 1) return `${f.san} is checkmate.`;
  return `${f.san} ${does(d)}.`;
}

/** What the engine's choice did instead: 'Nf3 was better: it protects the pawn on e5.' */
function betterDoes(f, plain = `${f.best_san} was better.`) {
  const c = does(f.best_does);
  return c ? `${f.best_san} was better: it ${c}.` : plain;
}

/** Why an inaccuracy cost what it did, when the facts show it: a sentence and whether it is about f.lost. */
function whyInaccurate(f) {
  if (!f.refutation.length) return null;
  const ref = line(f.refutation, f.ply + 1);
  if (f.allowed_mate) return [`This allows ${f.allowed_mate === 1 ? 'mate' : `mate in ${f.allowed_mate}`}: ${ref}.`, false];
  // material only when it stays lost: a few plies more of the engine's line don't win it back (the line shown can
  // stop mid-exchange, and a piece taken can be paid for)
  const settled = f.trade && f.trade.stable !== false && f.material_swing != null
    && Math.abs(f.material_swing - f.trade.net) <= 100;
  if (f.lost && settled && f.trade.net <= -100) return [lostSentence(f, f.lost, ref), true];
  if (f.motif) return [`${f.refutation[0]} ${f.motif_detail}: ${ref}.`, false];
  const l = settled ? losses(f.trade, ref) : null;
  return l ? [l, false] : null;
}

/** A great move: what it does, then what the next best move would have left (facts.secondLine). */
function great(f) {
  const s = [itDoes(f) ?? `${f.san} is the only good move.`];
  const sec = f.second;
  if (!sec) return s;
  const me = SIDE[f.side] ?? 'the mover', them = SIDE[f.side === 'white' ? 'black' : 'white'] ?? 'the opponent';
  const alt = `The next best, ${sec.san},`;
  const t = sec.trade;
  if (sec.mate != null && sec.mate > 0) s.push(`${alt} lets ${them} mate${sec.mate === 1 ? '' : ` in ${sec.mate}`}.`);
  else if (t && t.net <= -200 && t.stable !== false && t.lost.length && sec.line.length) {
    s.push(`${alt} loses ${pieces(t.lost)}${t.won.length ? ` for ${pieces(t.won)}` : ''}: ${line(sec.line, f.ply)}.`);
  }
  else {
    const w = sec.wp;
    const state = w >= 65 ? `keeps less of ${me}'s advantage` : w >= 55 ? `leaves ${me} only slightly better`
      : w > 45 ? 'leaves the game level' : w > 35 ? `leaves ${them} better` : `leaves ${them} winning`;
    s.push(`${alt} ${state}.`);
  }
  return s;
}

/** A brilliant move: the piece it offers (facts.offered), then why taking it fails. */
function brilliant(f) {
  const o = f.offered;
  if (!o) return [`${f.san} is brilliant: a sacrifice that holds.`];
  const s = [`${f.san} is brilliant: it offers the ${o.piece} on ${o.square}.`];
  if (!f.refutation.length) return s;
  const ref = line(f.refutation, f.ply + 1);
  const me = SIDE[f.side] ?? 'the mover', them = SIDE[f.side === 'white' ? 'black' : 'white'] ?? 'the opponent';
  if (!o.taken && !o.later) {
    s.push(`${them} does better not to take it: ${ref}.`);
    return s;
  }
  if (f.still_mates) {
    s.push(`Taking it allows mate in ${f.still_mates}: ${ref}.`);
    return s;
  }
  const g = o.taken ? gains(o.back) : null;
  if (g) {
    s.push(`Taking it fails: after ${ref}, ${me} wins ${g}.`);
    return s;
  }
  const w = f.wp_after;
  const state = w == null ? null : w >= 65 ? `${me} is winning` : w >= 55 ? `${me} is better` : w > 45 ? 'the game is level'
    : `${them} is only slightly better`;
  if (state) s.push(`Taking it does not pay: after ${ref}, ${state}.`);
  return s;
}

/** One or two sentences for ANY move (the move list / current-move panel). Mistakes and worse get the full
 * explanation. Good moves say what they do, or what the engine's choice did instead. */
export function comment(f, opening = null) {
  if (f.label == null) return [];
  if (f.label === 'book') return [`${f.san} is a book move.` + (opening ? ` (${opening})` : '')];
  if (f.label === 'forced') return [`${f.san} was the only legal move.`];
  if (f.label === 'brilliant') return brilliant(f);
  if (f.label === 'great') return great(f);
  if (f.label === 'best') return [itDoes(f) ?? `${f.san} is the best move.`];
  const close = f.best_san && f.wp_loss != null && f.wp_loss < 1;
  if (f.label === 'excellent' || f.label === 'good') {
    const what = `${f.san} is ${f.label === 'excellent' ? 'an excellent' : 'a good'} move`;
    if (!f.best_san) return [`${what}.`];
    if (close) return [`${what}, as good as the engine's ${f.best_san}.`];
    const plain = f.label === 'excellent' ? `${f.best_san} was the engine's choice.` : `${f.best_san} was better.`;
    const mine = !f.best_does && does(f.does);    // nothing to say for the engine's choice: say what the move does
    return [mine ? `${what}: it ${mine}. ${plain}` : `${what}. ` + betterDoes(f, plain)];
  }
  if (f.label === 'inaccuracy') {
    const s = [`${f.san} is an inaccuracy.`];
    const why = f.wp_loss != null && f.wp_loss >= 6 ? whyInaccurate(f) : null;
    if (why) s.push(why[0]);
    if (f.best_san) {
      const saves = why?.[1] && !f.best_san.includes('+') && f.best_saves;   // a check keeps nothing safe for long
      s.push(saves ? (saves.moved ? `${f.best_san} moves the ${saves.piece} to safety.`
        : `${f.best_san} keeps the ${saves.piece} on ${saves.square} safe.`) : betterDoes(f));
    }
    return s;
  }
  return explain(f);
}
