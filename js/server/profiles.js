// Profiles: one per (source, username), as chess_review/profiles.py. Everything that belongs to one player lives
// under profiles/<id>/; the engine cache (evals.sqlite), the opening book and the static app are shared, so two
// players in the same openings reuse each other's engine work.
//
//     profiles/<id>/
//         meta.json               {"source": "chesscom", "username": "...", "created": iso}
//         raw/                    chess.com monthly archives (chesscom profiles), lichess ndjson
//         pgn/                    pasted PGNs keyed by content hash
//         games.sqlite            games, positions, moves (db.js; in the browser it lives in the SQLite pool)
//         site/games.json, site/games/<slug>.json, site/insights.html   (served at /p/<id>/...)
//
// The id is derived from source + username, so the directory listing is the registry. Every path is relative to
// the data directory and goes through a files adapter (profiles-files.js). meta.json is written byte for byte as
// Python's json.dumps writes it, so either side can read and rewrite the other's.

import { profileDb } from './db.js';

export const SOURCES = ['chesscom', 'lichess', 'pgn'];
export const PROFILES_DIR = 'profiles';
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,80}$/;
const DAY_MS = 86_400_000;

/** json.dumps(v) with Python's defaults: ', ' and ': ' separators, non-ASCII escaped. */
export function pyDumps(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN';
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u007f-￿]/g, c => (c === '\u007f' ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyDumps(k)}: ${pyDumps(x)}`).join(', ')}}`;
}

/** datetime.now(timezone.utc).isoformat(timespec="seconds") */
export const nowIso = (now = Date.now()) => new Date(now).toISOString().slice(0, 19) + '+00:00';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?)?(?:(Z)|([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/;

/** profiles._parse_ts: played_at (ISO, as games.json has it; naive means UTC) as epoch ms, or null. */
export function parseTs(playedAt) {
  if (!playedAt) return null;
  const m = ISO_RE.exec(String(playedAt));
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', , sign, oh = '0', om = '0', os = '0'] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Math.floor(+(frac.padEnd(6, '0')) / 1000));
  const check = new Date(ms);
  if (check.getUTCDate() !== +d || check.getUTCMonth() !== +mo - 1 || +h > 23 || +mi > 59 || +s > 59) return null;
  const off = sign ? (sign === '-' ? -1 : 1) * ((+oh * 60 + +om) * 60 + +os) * 1000 : 0;
  return ms - off;
}

/** A profile: its id, source and username, and its paths. */
export function profile(id, source, username) {
  const dir = `${PROFILES_DIR}/${id}`;
  return {
    id, source, username, dir,
    rawDir: `${dir}/raw`,
    pgnDir: `${dir}/pgn`,
    metaJson: `${dir}/meta.json`,
    siteDir: `${dir}/site`,
    exportDir: `${dir}/export`,
    db: profileDb(id),      // a Store name, not a path in files
  };
}

export function profileId(source, username) {
  const slug = username.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  const pid = `${source}-${slug}`;
  if (!SOURCES.includes(source) || !slug || !ID_RE.test(pid)) {
    throw new Error(`bad profile: source=${JSON.stringify(source)} username=${JSON.stringify(username)}`);
  }
  return pid;
}

export const validId = pid => typeof pid === 'string' && ID_RE.test(pid) && !pid.includes('..');

/** The profiles in a data directory. files: a profiles-files.js adapter; store: the db.js Store, whose databases
 * remove() deletes with the rest. */
export class Profiles {
  constructor(files, store = null) {
    this.files = files;
    this.store = store;
  }

  async meta(p) {
    const text = await this.files.readText(p.metaJson);
    return text === null ? {} : JSON.parse(text);
  }

  async load(pid) {
    if (!validId(pid)) return null;
    const text = await this.files.readText(`${PROFILES_DIR}/${pid}/meta.json`);
    if (text === null) return null;
    const m = JSON.parse(text);
    return profile(pid, m.source, m.username);
  }

  async create(source, username, now = Date.now()) {
    const p = profile(profileId(source, username), source, username.trim());
    await this.files.mkdir(p.dir);
    if (!(await this.files.exists(p.metaJson))) {
      await this.files.writeText(p.metaJson, pyDumps({ source, username: p.username, created: nowIso(now) }));
    }
    return p;
  }

  async updateMeta(pid, fn) {
    const p = await this.load(pid);
    if (p === null) return null;
    const meta = await this.meta(p);
    fn(meta);
    await this.files.writeText(p.metaJson, pyDumps(meta));
    return p;
  }

  /** Games a refresh just brought in: flagged "new" in the list until each is opened. */
  async addUnseen(pid, ids) {
    ids = [...ids];
    if (ids.length) await this.updateMeta(pid, meta => { meta.unseen = [...new Set([...(meta.unseen ?? []), ...ids])].sort(); });
  }

  /** Whether the site has games older than the oldest fetched (a profile is fetched a page at a time, newest
   * first). Profiles fetched whole before paging have no flag: nothing older. */
  async setOlder(pid, older) {
    await this.updateMeta(pid, meta => { meta.older = older; });
  }

  /** How many games the player has on the site in all, as the site counts them. */
  async setPlayed(pid, played) {
    await this.updateMeta(pid, meta => { meta.played = played; });
  }

  async markSeen(pid, gameId) {
    await this.updateMeta(pid, meta => {
      if ((meta.unseen ?? []).includes(gameId)) meta.unseen = meta.unseen.filter(i => i !== gameId);
    });
  }

  /** The list has displayed these "new" flags. They stay for the rest of this run but not into the next:
   * expireShown() drops them at launch, since seen is seen. */
  async markShown(pid, ids) {
    ids = new Set(ids);
    if (ids.size) await this.updateMeta(pid, meta => { meta.shown = [...new Set([...(meta.shown ?? []), ...ids])].sort(); });
  }

  /** At launch: every "new" flag an earlier run already displayed comes off. */
  async expireShown() {
    for (const p of await this.list()) {
      if (!('shown' in (await this.meta(p)))) continue;
      await this.updateMeta(p.id, meta => {
        const shown = new Set(meta.shown ?? []);
        delete meta.shown;
        meta.unseen = (meta.unseen ?? []).filter(i => !shown.has(i));
      });
    }
  }

  /** Pin (stamp the time, so pins keep the order they were made in) or unpin a profile on the home screen. */
  async setPinned(pid, on, now = Date.now()) {
    const p = await this.load(pid);
    if (p === null) return null;
    const meta = await this.meta(p);
    if (on) meta.pinned ??= nowIso(now);
    else delete meta.pinned;
    await this.files.writeText(p.metaJson, pyDumps(meta));
    return this.summary(p, now);
  }

  async remove(pid) {
    const p = await this.load(pid);
    if (p === null) return false;
    if (this.store) await this.store.drop(p);
    await this.files.remove(p.dir);
    return true;
  }

  async list() {
    const out = [];
    for (const e of await this.files.list(PROFILES_DIR)) {
      if (!e.dir) continue;
      const p = await this.load(e.name);
      if (p !== null) out.push(p);
    }
    return out;
  }

  async gameIds(p) {
    try {
      return new Set(JSON.parse(await this.files.readText(`${p.siteDir}/games.json`)).games.map(g => g.id));
    } catch {
      return new Set();
    }
  }

  /** What the home screen shows: id, source, username, game counts (`games` fetched, `played` on the site in all,
   * null until a fetch has asked), and per time class the current rating with its net change over the last 7 days.
   * `rating`/`rating_delta_7d` are the most recently played class's. */
  async summary(p, now = Date.now()) {
    let games = 0, analysed = 0;
    let rating = null, ratingDelta7d = null;
    let ratings = {};
    const text = await this.files.readText(`${p.siteDir}/games.json`);
    if (text !== null) {
      try {
        const entries = JSON.parse(text).games;
        if (entries === undefined) throw new Error('no games');
        const rated = new Map();
        for (const g of entries) {
          games += 1;
          analysed += (g.analysed ?? 0) >= 0.999 ? 1 : 0;
          const ts = parseTs(g.played_at);
          if (ts !== null && g.my_rating != null) {
            const cls = g.time_class || 'other';
            if (!rated.has(cls)) rated.set(cls, []);
            rated.get(cls).push([ts, g.my_rating]);
          }
        }
        const cutoff = now - 7 * DAY_MS;
        let latest = null;
        for (const [cls, series] of rated) {
          series.sort((a, b) => a[0] - b[0]);
          const before = series.filter(([t]) => t < cutoff).map(([, r]) => r);
          const baseline = before.length ? before.at(-1) : series[0][1];
          ratings[cls] = { rating: series.at(-1)[1], delta_7d: series.at(-1)[1] - baseline, games: series.length };
          if (latest === null || series.at(-1)[0] > latest[0]) latest = [series.at(-1)[0], cls];
        }
        if (latest) [rating, ratingDelta7d] = [ratings[latest[1]].rating, ratings[latest[1]].delta_7d];
      } catch {
        games = 0; analysed = 0; ratings = {}; rating = null; ratingDelta7d = null;
      }
    }
    const meta = await this.meta(p);
    return {
      id: p.id, source: p.source, username: p.username, games, analysed,
      created: meta.created ?? null, pinned: meta.pinned ?? null,
      rating, rating_delta_7d: ratingDelta7d, ratings,
      unseen: meta.unseen ?? [], older: !!meta.older,
      played: meta.played ? Math.max(meta.played, games) : null,
    };
  }
}
