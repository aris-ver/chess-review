// Python's number and string behaviour where the ported modules depend on it: float sums, the exact population
// standard deviation of `statistics`, round() and format specs (both round half to even on the exact binary value),
// int() of a string, and the iteration order of a small set of ints.

/** sum(xs) over floats: Python 3.12+ adds them with Neumaier compensation. */
export function pySum(xs) {
  let sum = 0, c = 0;
  for (const x of xs) {
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? (sum - t) + x : (x - t) + sum;
    sum = t;
  }
  return c && Number.isFinite(c) ? sum + c : sum;
}

/** A finite double as an exact fraction: [numerator, power of two] with x = n * 2**e. */
function exact(x) {
  if (x === 0) return [0n, 0];
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0), lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased) mant |= 1n << 52n;
  const e = (biased || 1) - 1075;
  return [hi >>> 31 ? -mant : mant, e];
}

const bitLength = n => n === 0n ? 0 : n.toString(2).length;

function isqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** statistics._float_sqrt_of_frac: sqrt(n/m), correctly rounded. */
function sqrtOfFrac(n, m) {
  const rto = (a, b) => { const r = isqrt(a / b); return r * r * b !== a ? r | 1n : r; };
  const q = Math.floor((bitLength(n) - bitLength(m) - 109) / 2);
  return q >= 0 ? Number(rto(n, m << BigInt(2 * q)) << BigInt(q))
    : Number(rto(n << BigInt(-2 * q), m)) / 2 ** -q;
}

/** statistics.pstdev(xs): computed exactly on the floats' binary values, then rounded once, as Python does. */
export function pstdev(xs) {
  if (!xs.length) throw new Error('pstdev requires at least one data point');
  const parts = xs.map(exact);
  const e = Math.min(...parts.map(p => p[1]));
  const X = parts.map(([n, pe]) => n << BigInt(pe - e));
  const count = BigInt(xs.length);
  const s = X.reduce((a, b) => a + b, 0n);
  let num = X.reduce((a, x) => a + (count * x - s) ** 2n, 0n);    // variance = num / (count**3 * 2**(-2e))
  let den = count ** 3n;
  if (e >= 0) num <<= BigInt(2 * e); else den <<= BigInt(-2 * e);
  return sqrtOfFrac(num, den);
}

/** x rounded to `nd` decimals, ties to even on the exact value, as a decimal digit string (sign apart). */
function roundDigits(x, nd) {
  const [n, e] = exact(Math.abs(x));
  let num = n * 10n ** BigInt(nd), den = 1n;
  if (e >= 0) num <<= BigInt(e); else den <<= BigInt(-e);
  let q = num / den;
  const r2 = 2n * (num % den);
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
  return q;
}

/** round(x, nd) for a float x and nd >= 0. */
export function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  const q = roundDigits(x, nd);
  const v = Number(`${q}e-${nd}`);
  return x < 0 || Object.is(x, -0) ? -v : v;
}

/** f"{x:.{nd}f}" */
export function formatFixed(x, nd) {
  const digits = roundDigits(x, nd).toString().padStart(nd + 1, '0');
  const body = nd ? `${digits.slice(0, -nd)}.${digits.slice(-nd)}` : digits;
  return (x < 0 || Object.is(x, -0) ? '-' : '') + body;
}

/** f"{x:g}": six significant digits, trailing zeros dropped, exponent outside 1e-4 <= |x| < 1e6. */
export function formatG(x) {
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const [mant, exp] = x.toExponential(5).split('e');
  const p = Number(exp);
  if (p < -4 || p >= 6) {
    const m = mant.replace(/\.?0+$/, '');
    return `${m}e${p < 0 ? '-' : '+'}${String(Math.abs(p)).padStart(2, '0')}`;
  }
  const fixed = formatFixed(x, Math.max(0, 5 - p));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** int(s) for a str: surrounding whitespace, a sign, digits with single underscores between them; null where
 * Python raises ValueError. */
export function pyInt(s) {
  const m = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/.exec(s);
  if (!m) return null;
  const v = Number(m[2].replaceAll('_', ''));
  return m[1] === '-' ? 0 - v : v;
}

/** float(s) for a str; null where Python raises ValueError. */
export function pyFloat(s) {
  const t = s.trim().replaceAll('_', '');
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  return null;
}

/** str.capitalize() */
export const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** A CPython set of small non-negative ints (a square's number is its hash), kept slot for slot so that it
 * iterates in CPython's order. Only what facts.motif needs: add, has, iteration, difference. */
export class IntSet {
  constructor(keys = [], size = 8) {
    this.table = new Array(size).fill(null);
    this.used = 0;
    for (const k of keys) this.add(k);
  }

  get mask() { return this.table.length - 1; }

  /** set_insert_clean: the first free slot along CPython's probe sequence. */
  static slot(table, key) {
    const mask = table.length - 1;
    let i = key & mask, perturb = key;
    for (;;) {
      const probes = i + 9 <= mask ? 9 : 0;
      for (let j = 0; j <= probes; j++) if (table[i + j] === null) return i + j;
      perturb >>>= 5;
      i = (i * 5 + 1 + perturb) & mask;
    }
  }

  has(key) { return this.table.includes(key); }

  add(key) {
    if (this.has(key)) return;
    this.table[IntSet.slot(this.table, key)] = key;
    this.used += 1;
    if (this.used * 5 >= this.mask * 3) this.resize(this.used > 50000 ? this.used * 2 : this.used * 4);
  }

  resize(minUsed) {
    let size = 8;
    while (size <= minUsed) size <<= 1;
    const old = this.table;
    this.table = new Array(size).fill(null);
    for (const k of old) if (k !== null) this.table[IntSet.slot(this.table, k)] = k;
  }

  * [Symbol.iterator]() { for (const k of this.table) if (k !== null && k !== DUMMY) yield k; }

  get size() { return this.used; }

  /** self - other, built the way CPython's set_difference builds it. */
  difference(other) {
    if ((this.used >> 2) > other.size) {          // set_copy_and_difference: copy, then discard
      const out = new IntSet();
      if (this.used * 5 >= out.mask * 3) out.resize(this.used * 2);
      if (out.mask === this.mask) out.table = [...this.table];
      else for (const k of this) out.table[IntSet.slot(out.table, k)] = k;
      out.used = this.used;
      for (const k of other) {
        const i = out.table.indexOf(k);
        if (i >= 0) { out.table[i] = DUMMY; out.used -= 1; }
      }
      return out;
    }
    const out = new IntSet();
    for (const k of this) if (!other.has(k)) out.add(k);
    return out;
  }
}

// a discarded slot: iterated past (nothing is added to a set after a difference, so no reuse is needed)
const DUMMY = -1;
