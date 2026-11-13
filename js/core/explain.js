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

// --- sentences ------------------------------------------------------------------------------------------------
//
// Each sentence is built as {text, short, reason}: `text` the full sentence, line and all; `short` the same sentence
// without its line ("This leaves the rook on h1 hanging." for "...hanging: 4... Qxh1 5. Nf3."); `reason` whether it
// says something the move's header (its verdict, eval and the eval bar) and the arrows don't. Filler -- the verdict
// said again, a bare "X was better", how the game stands -- has reason false. `clock`: the "Played ..." sentence.
// `glue`: comment() runs it on after the sentence before, in one string. `on`: the line a reason is about (moveLine):
// 'after' the opponent's reply and on, 'before' the engine's choice and on, 'played' the move and the reply,
// 'second' a great move's next best.

const S = (on, text, short = text) => ({ text, short, reason: true, on });
const F = (text, short = text) => ({ text, short, reason: false });
/** A sentence ending in its line: built with the line `ref` and without it. */
const withRef = (on, fn, ref, reason = true) => ({ text: fn(ref), short: fn(null), reason, on });
/** ': <line>.' or '.'. */
const end = ref => (ref ? `: ${ref}.` : '.');

/** What a line loses for the mover, as a sentence about the line `ref`, or null when it loses less than two
 * pawns' worth (or what it loses isn't in the line shown, or the line stops before the material settles). */
function losses(t, ref) {
  if (!t || t.net > -200 || t.stable === false) return null;
  const promo = t.promotes.find(p => !p.by_mover);
  if (promo) return withRef('after', r => `This lets the ${promo.file}-pawn queen${end(r)}`, ref);
  if (!t.lost.length) return null;
  return withRef('after', r => `This loses ${pieces(t.lost)}` + (t.won.length ? ` for ${pieces(t.won)}` : '') + end(r), ref);
}

/** The sentence for the piece the refutation takes (facts.lostPiece). */
function lostSentence(f, l, ref) {
  return withRef('after', r => {
    if (l.blocked) {
      const b = l.blocked;
      return `The ${b.by} on ${b.by_square} blocks the ${b.piece} on ${b.square} from taking back on ${l.square}, `
        + `so the ${l.piece} there is lost for nothing${end(r)}`;
    }
    if (l.kind === 'trade') return `${f.san} takes a ${l.captured} but loses the ${l.piece}${end(r)}`;
    if (l.kind === 'moved') return `This puts the ${l.piece} on ${l.square}, where the ${l.taker} takes it${end(r)}`;
    if (l.kind === 'left') return `This leaves the ${l.piece} on ${l.square} hanging${end(r)}`;
    if (l.kind === 'unguarded') return `The ${l.guard} no longer guards the ${l.piece} on ${l.square}${end(r)}`;
    return `This lets the ${l.taker} take the ${l.piece} on ${l.square}${end(r)}`;
  }, ref);
}

const SIDE = { white: 'White', black: 'Black' };

/** 'After <line>, <state>.', or without the line '<State>.'. */
const after = (ref, state) => (ref ? `After ${ref}, ${state}.` : `${capitalize(state)}.`);

/** How the move changed the game, from the mover's win chance before and after: for a bad move that loses no
 * material the line shows. Filler: the eval bar says as much. */
function standing(f, ref) {
  return withRef('after', r => after(r, standingState(f)), ref, false);
}

/** standing()'s clause: 'the game is level'. */
function standingState(f) {
  const me = SIDE[f.side] ?? 'The mover', them = f.side === 'white' ? 'Black' : f.side === 'black' ? 'White' : 'the opponent';
  const b = f.wp_before, a = f.wp_after;
  if (a == null || b == null) return 'the position is worse';
  let state;
  if (a >= 85) state = `${me} is still winning`;
  else if (a >= 65) state = `${me} is still winning, but much of the advantage is gone`;
  else if (a >= 55) state = b >= 65 ? `${me} is only slightly better` : `${me}'s edge is smaller`;
  else if (a > 45) state = b >= 55 ? `the advantage is gone and the game is level` : `the game is level`;
  else if (a > 35) state = `${them} is now better`;
  else if (b <= 35) state = `${them}'s advantage grows`;
  else state = b >= 65 ? `the win is gone: ${them} is now winning` : `${them} is now winning`;
  return state;
}

/** The second sentence: what the engine's choice did instead. `aboutLost`: the first sentence was about f.lost. */
function better(f, best, aboutLost) {
  if (f.was_only_move) return S('before', `${best} was the only move.`);
  if (f.best_saves && aboutLost) {
    const s = f.best_saves;
    return S('before', s.moved ? `${best} moves the ${s.piece} to safety.` : `${best} keeps the ${s.piece} on ${s.square} safe.`);
  }
  const g = gains(f.best_trade);
  if (g) return S('before', `${best} wins ${g}.`);
  const b0 = f.wp_before != null ? band(f.wp_before) : 'equal';
  if (b0 === 'winning') return F(f.wp_after >= 65 ? `${best} was stronger.` : `${best} kept the win.`);   // the win wasn't in danger
  if (b0 === 'losing') return F(`${best} was the best chance.`);
  return F(`${best} held the balance.`);
}

// what a missed move does that says nothing about it: answering a check, castling, a trade offered, a push prepared,
// a plain check
const THIN = new Set(['escapes', 'blocks', 'castles', 'castle_prep', 'offers', 'prepares']);

/** What the engine's choice for a miss would have done: mate, material, else what the move does (facts.describeMove),
 * else how it kept the game. */
function missed(f, best) {
  const ref = f.best_line.length ? line(f.best_line, f.ply) : null;
  const bl = r => (r ? `: ${r}` : '');
  if (f.best_mate === 1) return S('before', `Missed ${best}, which was mate.`);
  if (f.best_mate) return withRef('before', r => `Missed ${best}, which mates in ${f.best_mate}${bl(r)}.`, ref);
  const g = gains(f.best_trade);
  if (g) return withRef('before', r => `Missed ${best}, which wins ${g}${bl(r)}.`, ref);
  const d = f.best_does;
  const c = d && !THIN.has(d.kind) && !(d.kind === 'check' && !gains(d.wins)) ? does(d) : null;
  if (c) return withRef('before', r => `Missed ${best}, which ${c}${bl(r)}.`, ref);
  // the rest say only that it was better, or how the game stood: filler
  const me = SIDE[f.side];
  if (me && f.wp_before != null && f.wp_before >= 65) {
    return withRef('before', r => (f.wp_after >= 65 ? `Missed ${best}, which was stronger${bl(r)}.`
      : `Missed ${best}, which kept ${me} winning${bl(r)}.`), ref, false);
  }
  if (me && f.wp_before != null && f.wp_before >= 55) return withRef('before', r => `Missed ${best}, which kept ${me} better${bl(r)}.`, ref, false);
  return withRef('before', r => `Missed ${best}${bl(r)}.`, ref, false);
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
  return explainSentences(f).map(x => x.text);
}

/** explain()'s sentences as {text, short, reason, clock}. */
function explainSentences(f) {
  const s = [];
  const replyPly = f.ply + 1;
  const ref = f.refutation.length ? line(f.refutation, replyPly) : null;
  const best = f.best_san;
  // a piece the line takes but the engine's line wins back (its material settles above two pawns down) wasn't lost
  const comesBack = f.trade?.stable === false && f.trade.settled > -200;
  // nor one the line takes back: the mover ends no worse than a pawn down (a blocked recapture is lost all the same)
  const l = ref && !comesBack && f.lost && (f.lost.blocked || f.trade?.net <= -100) ? f.lost : null;
  const lossLine = ref ? losses(f.trade, ref) : null;
  const lostAlready = f.wp_before != null && f.wp_before < 10;

  /** What the move played cost, from the refutation: [sentence, about f.lost, only the standing]. */
  const cost = () => {
    if (f.allowed_mate) {
      const n = f.allowed_mate === 1 ? 'mate' : `mate in ${f.allowed_mate}`;
      return [withRef('after', r => (lostAlready ? `${capitalize(n)} follows${end(r)}` : `This allows ${n}${end(r)}`), ref), false];
    }
    if (l && (l.piece !== 'pawn' || l.blocked)) return [lostSentence(f, l, ref), true];
    if (f.motif && f.motif_backed) return [withRef('after', r => `${f.refutation[0]} ${f.motif_detail}${end(r)}`, ref), false];
    if (lossLine) return [lossLine, false];
    if (l) return [lostSentence(f, l, ref), true];
    return [standing(f, ref), false, true];
  };
  /** The sentence `c` with both its forms rewritten by `fn`. */
  const map = (c, fn) => ({ ...c, text: fn(c.text), short: fn(c.short) });

  let aboutLost = false;
  if (f.label === 'miss' && best) {
    s.push(missed(f, best));
    // what the move played gave away, when it gave away much: a miss is a bad move of its own too
    // (named, not "this": the sentence before is about the move missed)
    if (f.still_mates) s.push(S('played', `After ${f.san} there is still mate in ${f.still_mates}.`));
    else if (ref && f.wp_loss != null && f.wp_loss >= 10) {
      const [c, , plain] = cost();
      if (plain) {
        // without the line, the move played is still named
        const st = standing(f, line([f.san, ...f.refutation], f.ply));
        s.push({ ...st, on: 'played', short: `After ${f.san}, ${standingState(f)}.` });   // its line starts with the move
      }
      else if (c.text.startsWith('This ')) s.push(map(c, t => t.replace(/^This /, `${f.san} `)));
      else if (c.text.startsWith(`${f.san} `)) s.push(c);
      else s.push(map(c, t => `After ${f.san}, ${t.replace(/^The /, 'the ')}`));   // the reply's pattern, a guard or a block
    }
  }
  else if (f.missed_mate && best) {
    s.push(f.missed_mate === 1 ? S('before', `${best} was mate.`)
      : S('before', `${best} mates in ${f.missed_mate}: ${line(f.best_line, f.ply)}.`, `${best} mates in ${f.missed_mate}.`));
  }
  else if (ref) [s[0], aboutLost] = cost();

  if (best && !f.missed_mate && f.label !== 'miss') s.push(better(f, best, aboutLost));

  const c = clockNote(f);
  if (c) s.push({ ...F(c), clock: true });
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

// castling, or a check that wins nothing: saying so says nothing about the move
const bare = d => d.kind === 'castles' || (d.kind === 'check' && !gains(d.wins));

/** The move's own sentence from what it does ('Nxe5 wins the pawn on e5.'), or null. */
function itDoes(f) {
  const d = f.does;
  if (!d || bare(d)) return null;
  if (d.kind === 'mate' && d.n === 1) return F(`${f.san} is checkmate.`);   // the board says so
  return S('played', `${f.san} ${does(d)}.`);
}

/** What the engine's choice did instead: 'Nf3 was better: it protects the pawn on e5.' `plain` is the sentence when
 * there is nothing to say (filler), and leads the longer one ("Nf3 was the engine's choice: it ..."). */
function betterDoes(f, plain = `${f.best_san} was better.`) {
  const c = f.best_does && !bare(f.best_does) ? does(f.best_does) : null;
  return c ? S('before', `${plain.slice(0, -1)}: it ${c}.`) : F(plain);
}

/** Why an inaccuracy cost what it did, when the facts show it: a sentence and whether it is about f.lost. */
function whyInaccurate(f) {
  if (!f.refutation.length) return null;
  const ref = line(f.refutation, f.ply + 1);
  if (f.allowed_mate) return [withRef('after', r => `This allows ${f.allowed_mate === 1 ? 'mate' : `mate in ${f.allowed_mate}`}${end(r)}`, ref), false];
  // material only when it stays lost: a few plies more of the engine's line don't win it back (the line shown can
  // stop mid-exchange, and a piece taken can be paid for)
  const settled = f.trade && f.trade.stable !== false;
  if (f.lost && settled && f.trade.net <= -100) return [lostSentence(f, f.lost, ref), true];
  if (f.motif && f.motif_backed) return [withRef('after', r => `${f.refutation[0]} ${f.motif_detail}${end(r)}`, ref), false];
  const l = settled ? losses(f.trade, ref) : null;
  return l ? [l, false] : null;
}

/** A great move: what it does, then what the next best move would have left (facts.secondLine). The next best's
 * sentence is the reason it is great: what the move avoided. */
function great(f) {
  const s = [itDoes(f) ?? F(`${f.san} is the only good move.`)];
  const sec = f.second;
  if (!sec) return s;
  const me = SIDE[f.side] ?? 'the mover', them = SIDE[f.side === 'white' ? 'black' : 'white'] ?? 'the opponent';
  const alt = `The next best, ${sec.san},`;
  const t = sec.trade;
  if (sec.mate != null && sec.mate > 0) s.push(S('second', `${alt} lets ${them} mate${sec.mate === 1 ? '' : ` in ${sec.mate}`}.`));
  else if (t && t.net <= -200 && t.stable !== false && t.lost.length && sec.line.length) {
    s.push(withRef('second', r => `${alt} loses ${pieces(t.lost)}${t.won.length ? ` for ${pieces(t.won)}` : ''}${end(r)}`, line(sec.line, f.ply)));
  }
  else {
    const w = sec.wp;
    const state = w >= 65 ? `keeps less of ${me}'s advantage` : w >= 55 ? `leaves ${me} only slightly better`
      : w > 45 ? 'leaves the game level' : w > 35 ? `leaves ${them} better` : `leaves ${them} winning`;
    s.push(S('second', `${alt} ${state}.`));
  }
  return s;
}

/** A brilliant move: the piece it offers (facts.offered), then why taking it fails. */
function brilliant(f) {
  const o = f.offered;
  if (!o) return [F(`${f.san} is brilliant: a sacrifice that holds.`)];
  const s = [S('after', `${f.san} is brilliant: it offers the ${o.piece} on ${o.square}.`)];
  if (!f.refutation.length) return s;
  const ref = line(f.refutation, f.ply + 1);
  const me = SIDE[f.side] ?? 'the mover', them = SIDE[f.side === 'white' ? 'black' : 'white'] ?? 'the opponent';
  if (!o.taken && !o.later) {
    s.push(withRef('after', r => `${them} does better not to take it${end(r)}`, ref));
    return s;
  }
  if (f.still_mates) {
    s.push(withRef('after', r => `Taking it allows mate in ${f.still_mates}${end(r)}`, ref));
    return s;
  }
  const g = o.taken ? gains(o.back) : null;
  if (g) {
    s.push(withRef('after', r => `Taking it fails: ${r ? `after ${r}, ` : ''}${me} wins ${g}.`, ref));
    return s;
  }
  const w = f.wp_after;
  const state = w == null ? null : w >= 65 ? `${me} is winning` : w >= 55 ? `${me} is better` : w > 45 ? 'the game is level'
    : `${them} is only slightly better`;
  // "does not pay" only when the line takes it at once and the mover ends better for it
  if (state) {
    s.push(o.taken && w >= 55 ? withRef('after', r => `Taking it does not pay: ${r ? `after ${r}, ` : ''}${state}.`, ref)
      : withRef('after', r => after(r, state), ref, false));
  }
  return s;
}

/** comment()'s sentences as {text, short, reason, clock, glue} (see S and F above). */
export function sentences(f, opening = null) {
  if (f.label == null) return [];
  // the header already says it is book, or forced (the opening's name is on the first position)
  if (f.label === 'book') return [F(`${f.san} is a book move.` + (opening ? ` (${opening})` : ''))];
  if (f.label === 'forced') return [F(`${f.san} was the only legal move.`)];
  if (f.label === 'brilliant') return brilliant(f);
  if (f.label === 'great') return great(f);
  if (f.label === 'best') return [itDoes(f) ?? F(`${f.san} is the best move.`)];
  const close = f.best_san && f.wp_loss != null && f.wp_loss < 1;
  if (f.label === 'excellent' || f.label === 'good') {
    const what = `${f.san} is ${f.label === 'excellent' ? 'an excellent' : 'a good'} move`;
    if (!f.best_san) return [F(`${what}.`)];
    if (close) return [F(`${what}, as good as the engine's ${f.best_san}.`)];
    const plain = f.label === 'excellent' ? `${f.best_san} was the engine's choice.` : `${f.best_san} was better.`;
    const mine = !f.best_does && f.does && !bare(f.does) && does(f.does);    // nothing to say for the engine's choice: say what the move does
    // two sentences in one string, as the panel has always had them
    // the panel's short form leaves the verdict to the header: 'dxe5 takes back on e5.', as a best move reads
    if (mine) return [S('played', `${what}: it ${mine}.`, `${f.san} ${mine}.`), { ...F(plain), glue: true }];
    return [F(`${what}.`), { ...betterDoes(f, plain), glue: true }];
  }
  if (f.label === 'inaccuracy') {
    const s = [F(`${f.san} is an inaccuracy.`)];
    const why = f.wp_loss != null && f.wp_loss >= 6 ? whyInaccurate(f) : null;
    if (why) s.push(why[0]);
    if (f.best_san) {
      const saves = why?.[1] && !f.best_san.includes('+') && f.best_saves;   // a check keeps nothing safe for long
      s.push(saves ? S('before', saves.moved ? `${f.best_san} moves the ${saves.piece} to safety.`
        : `${f.best_san} keeps the ${saves.piece} on ${saves.square} safe.`) : betterDoes(f));
    }
    return s;
  }
  return explainSentences(f);
}

/** One or two sentences for ANY move (the move list / current-move panel). Mistakes and worse get the full
 * explanation. Good moves say what they do, or what the engine's choice did instead. */
export function comment(f, opening = null) {
  const out = [];
  for (const s of sentences(f, opening)) {
    if (s.glue && out.length) out[out.length - 1] += ` ${s.text}`;
    else out.push(s.text);
  }
  return out;
}

/** The sentences that say something: no verdict said again, no bare "X was better", no standing the eval bar
 * shows, no clock. Each {text (with its line), short (without), on (the line it is about)}. Empty: there is nothing
 * more to explain. */
export function reasons(f, opening = null) {
  return sentences(f, opening).filter(s => s.reason && !s.clock).map(({ text, short, on }) => ({ text, short, on }));
}

const PUNISHED = new Set(['mistake', 'blunder', 'miss']);

/** A mistake, blunder or miss with no reason: the sentence that carries the line punishing it ("After 25. d6+ Kh8
 * 26. dxe7, White is now winning.", or the move a miss missed), as {text, short, on}, or null. Explain shows it and
 * plays its line; the short form stays empty (no filler under the header). Inaccuracies are left out: their line is
 * the engine's play on, not a refutation. */
export function punishing(f, opening = null) {
  if (!PUNISHED.has(f.label)) return null;
  const ss = sentences(f, opening);
  if (ss.some(s => s.reason && !s.clock)) return null;
  const p = ss.find(s => !s.clock && s.on && s.text !== s.short);
  return p ? { text: p.text, short: p.short, on: p.on } : null;
}

/** The one line the move's explanation plays out, as {base_ply (main-line moves before it), san, uci, on}, or null: the
 * line its first reason is about (the opponent's reply to a bad move, the move a miss missed, what the engine's choice
 * does, the move played and its reply), and a great move's next best before all. With no reason, a bad move's
 * punishing line (punishing()); else null, nothing to play. played: the move's UCI. */
export function moveLine(f, played, opening = null) {
  const rs = reasons(f, opening);
  const r = rs.find(x => x.on === 'second') ?? rs.find(x => x.on) ?? punishing(f, opening);    // a great move: what the next best leaves
  if (!r) return null;
  const mk = (base, san, uci) => (san.length && uci.length >= san.length
    ? { base_ply: base, san: [...san], uci: uci.slice(0, san.length), on: r.on } : null);
  if (r.on === 'after') return mk(f.ply + 1, f.refutation, f.refutation_uci);
  if (r.on === 'before') return mk(f.ply, f.best_line, f.best_line_uci ?? []);
  if (r.on === 'second') return f.second ? mk(f.ply, f.second.line ?? [], f.second.uci ?? []) : null;
  return mk(f.ply, [f.san, ...f.refutation], [played, ...f.refutation_uci]);
}
