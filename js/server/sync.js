// Puzzle progress kept in step with a Blundr account, as chess_review/sync.py did (its docstring has the whole story:
// git show e8e547f:chess_review/sync.py).
// static/account.js runs the loop through /api/sync/*, on the website and in the desktop app alike.
//
// The account holds sets of lines per file, under Python's file names, and those names and lines are what goes back
// and forth: puzzle_attempts.jsonl, puzzle_attempts.reset-<when>.jsonl, puzzle_solved.jsonl, puzzle_daily.jsonl,
// profiles/<id>/puzzle_attempts[.reset-<when>].jsonl, and profiles.jsonl (made from profiles/*/meta.json). Here the
// puzzle files are SQLite tables (db.js), so each is a "virtual file": its rows written out as the line Python's
// json.dumps wrote for them (key order and spacing included) and read back by parsing the lines into rows.
//
//     puzzle_attempts[.<archive>].jsonl             progress.sqlite puzzle_attempts, archive NULL or <archive>
//     puzzle_solved.jsonl, puzzle_daily.jsonl       progress.sqlite puzzle_solved, puzzle_daily
//     profiles/<id>/puzzle_attempts[.<a>].jsonl     profiles/<id>/games.sqlite puzzle_attempts
//
// The sync is a three-way merge against the account's files as this browser last got them (account_sync.json, the
// base); switch() and release() move whose data is in DATA as a whole, into and out of .accounts/<owner>/, which has
// DATA's own layout: account_sync.json, progress.sqlite, profiles/<id>/... with their games.sqlite.
//
// Through what the constructor is given: `files` (profiles-files.js, at the data directory), `store` (db.js's Store
// over the same data directory), and `runner` (jobs.js: whether a job is on a profile, cancelling its build), and
// `onSwitch` (called once the profiles changed hands: own puzzles' cache).

import { EVALS, PROFILE_DDL, PROGRESS, PROGRESS_DDL, ATTEMPTS_SCHEMA, DAILY_SCHEMA, SOLVED_ROW, profileDb } from './db.js';
import { BadRequest, pyRepr, truthy } from './http.js';
import { profileId, pyDumps, validId } from './profiles.js';

export const BASE = 'account_sync.json';
export const PROFILES = 'profiles.jsonl';
export const SYNCED_SOURCES = ['chesscom', 'lichess'];
export const WORKSPACES = '.accounts';
export const GUEST = 'guest';

/** Python's str() of a JSON value. */
export function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return pyDumps(v).replace(/"/g, "'").replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None');
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = xs => [...xs].sort(cmp);
const unique = xs => [...new Set(xs)];
const at = (root, rel) => (root ? (rel ? `${root}/${rel}` : root) : rel);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const DB_FILE = /\.sqlite(-wal|-shm|-journal)?$/;

// ---------- lines ----------

/** The keys each table's line has, in the order Python wrote them. A NULL column is a key the line didn't have,
 * except `ms`, which Python always wrote (null when unknown). */
const KEYS = {
  puzzle_attempts: ['id', 'ts', 'solved', 'ms', 'hinted', 'rating'],
  puzzle_solved: ['id', 'ts', 'clean'],
  puzzle_daily: ['date', 'n', 'id', 'solved', 'clean', 'ms', 'marks'],
};
const ALWAYS = new Set(['ms']);
const SCHEMAS = { puzzle_attempts: ATTEMPTS_SCHEMA, puzzle_solved: SOLVED_ROW, puzzle_daily: DAILY_SCHEMA };

export function rowLine(table, row) {
  const o = {};
  for (const k of KEYS[table]) if (row[k] !== null && row[k] !== undefined || ALWAYS.has(k)) o[k] = row[k] ?? null;
  return pyDumps(o);
}

function lineRow(table, line, archive) {
  const v = JSON.parse(line);
  const row = table === 'puzzle_attempts' ? { archive } : {};
  for (const k of KEYS[table]) row[k] = v[k] ?? null;
  return row;
}

/** Where a file of the account lives here: {db, table, archive, dir}, or null for a name this app doesn't keep. */
export function locate(file) {
  let m = /^profiles\/([^/]+)\/puzzle_attempts(?:\.(.+))?\.jsonl$/.exec(file);
  if (m) return validId(m[1]) ? { db: profileDb(m[1]), table: 'puzzle_attempts', archive: m[2] ?? null, dir: `profiles/${m[1]}` } : null;
  m = /^puzzle_attempts(?:\.(.+))?\.jsonl$/.exec(file);
  if (m) return { db: PROGRESS, table: 'puzzle_attempts', archive: m[1] ?? null, dir: null };
  if (file === 'puzzle_solved.jsonl') return { db: PROGRESS, table: 'puzzle_solved', archive: null, dir: null };
  if (file === 'puzzle_daily.jsonl') return { db: PROGRESS, table: 'puzzle_daily', archive: null, dir: null };
  return null;
}

const attemptsFile = (archive, dir = null) => at(dir, `puzzle_attempts${archive === null ? '' : `.${archive}`}.jsonl`);

/** sync.profile_line: a profile as the account lists it. */
export function profileLine(m) {
  return pyDumps({ added: m.created ?? null, pinned: m.pinned ?? null, source: m.source, username: m.username });
}

/** The profile a line of profiles.jsonl stands for, or null when it isn't one this app can make. */
export function profileKey(line) {
  const v = JSON.parse(line);
  try {
    return profileId(pyStr(v.source), pyStr(truthy(v.username) ? v.username : ''));
  } catch {
    return null;
  }
}

/** (added, removed): per file, the lines in `here` but not in `base`, and the other way round. */
export function diff(base, here) {
  const add = {}, remove = {};
  for (const f of sorted(new Set([...Object.keys(base), ...Object.keys(here)]))) {
    const b = new Set(base[f] ?? []), h = new Set(here[f] ?? []);
    const a = unique((here[f] ?? []).filter(ln => !b.has(ln)));
    if (a.length) add[f] = a;
    const r = unique((base[f] ?? []).filter(ln => !h.has(ln)));
    if (r.length) remove[f] = r;
  }
  return [add, remove];
}

/** sync._when: the key a merged file is sorted by. */
function when(line) {
  const v = JSON.parse(line);
  return typeof v.ts === 'number' ? v.ts : pyStr('date' in v ? v.date : '');
}

const byWhen = (a, b) => {
  if (typeof a.k === 'number' && typeof b.k === 'number') return a.k - b.k;
  if (typeof a.k !== typeof b.k) return typeof a.k === 'number' ? -1 : 1;
  return cmp(a.k, b.k);
};

function oncePer(key, lines) {
  const seen = new Set(), out = [];
  for (const ln of lines) {
    const k = JSON.parse(ln)[key] ?? null;
    const id = k === null ? null : `${typeof k}:${typeof k === 'object' ? JSON.stringify(k) : k}`;
    if (id === null || !seen.has(id)) {
      seen.add(id);
      out.push(ln);
    }
  }
  return out;
}

/** oncePer('id'), where a puzzle solved clean on one browser and with a miss on another keeps the clean line (in
 * the place of the first): the best result wins, whichever came first. */
function bestSolved(lines) {
  const at = new Map(), out = [];
  for (const ln of lines) {
    const v = JSON.parse(ln), k = v.id ?? null;
    const id = k === null ? null : `${typeof k}:${typeof k === 'object' ? JSON.stringify(k) : k}`;
    if (id === null || !at.has(id)) {
      if (id !== null) at.set(id, out.length);
      out.push(ln);
    } else if (v.clean === true && JSON.parse(out[at.get(id)]).clean !== true) {
      out[at.get(id)] = ln;
    }
  }
  return out;
}

/** A merged file in the order and with the uniqueness its reader expects (sync.tidy). */
export function tidy(file, lines) {
  if (file === PROFILES) {
    const best = new Map();
    for (const ln of unique(lines)) {
      const k = profileKey(ln) || ln;
      const pin = l => pyStr(JSON.parse(l).pinned || '');
      if (!best.has(k) || pin(ln) > pin(best.get(k))) best.set(k, ln);
    }
    return sorted(best.keys()).map(k => best.get(k));
  }
  let out = unique(lines).map(ln => ({ ln, k: when(ln) })).sort(byWhen).map(x => x.ln);
  const name = file.split('/').at(-1);
  if (!file.includes('/') && name.startsWith('puzzle_attempts')) out = oncePer('id', out);
  else if (name === 'puzzle_solved.jsonl') out = bestSolved(out);
  else if (name === 'puzzle_daily.jsonl') out = oncePer('date', out);
  return out;
}

/** The account's files with this browser's own changes since the base put back on top. */
export function merge(base, here, theirs) {
  const [add, remove] = diff(base, here);
  const out = {};
  for (const f of sorted(new Set([...Object.keys(theirs), ...Object.keys(add)]))) {
    const gone = new Set(remove[f] ?? []);
    const lines = [...(theirs[f] ?? []), ...(add[f] ?? [])].filter(ln => !gone.has(ln));
    if (lines.length) out[f] = tidy(f, lines);
  }
  return out;
}

/** here.get(f) == merged.get(f): both missing, or the same lines. */
const sameList = (a, b) => (a === undefined || b === undefined ? a === b : a.length === b.length && a.every((x, i) => x === b[i]));

// ---------- the data folder ----------

export class Sync {
  constructor({ files, store, runner = null, onSwitch = null, log = null }) {
    Object.assign(this, { files, store, runner, onSwitch, log });
  }

  // --- databases by name (DATA's own, or a workspace's: '.accounts/<who>/progress.sqlite')

  async dbExists(name) {
    return this.store.open.has(name) || await this.store.driver.exists(name);
  }

  async db(name, create = false) {
    if (!create && !(await this.dbExists(name))) return null;
    return name.split('/').at(-1) === PROGRESS
      ? this.store.connect(name, PROGRESS_DDL)
      : this.store.connect(name, PROFILE_DDL, [[EVALS, 'ev']]);
  }

  async dropDb(name) {
    if (!(await this.dbExists(name))) return;
    await this.store.close(name);
    await this.store.driver.remove(name);
  }

  // --- virtual files

  async readLines(root, file) {
    const loc = locate(file);
    const db = loc && await this.db(at(root, loc.db));
    if (!db) return [];
    const where = loc.table === 'puzzle_attempts' ? ' WHERE archive IS ?' : '';
    const rows = db.all(`SELECT * FROM ${loc.table}${where} ORDER BY seq`, where ? [loc.archive] : []);
    return rows.map(r => rowLine(loc.table, r));
  }

  async writeLines(root, file, lines) {
    const loc = locate(file);
    if (!loc) {
      this.log?.warn?.(`sync: not keeping ${file}`);
      return;
    }
    const rows = lines.map(ln => lineRow(loc.table, ln, loc.archive));
    if (root) await this.files.mkdir(root);     // a workspace is there to be found again
    if (loc.dir) await this.files.mkdir(at(root, loc.dir));
    const db = await this.db(at(root, loc.db), true);
    db.tx(() => {
      if (loc.table === 'puzzle_attempts') db.run('DELETE FROM puzzle_attempts WHERE archive IS ?', [loc.archive]);
      else db.run(`DELETE FROM ${loc.table}`);
      db.insert(loc.table, SCHEMAS[loc.table], rows);
    });
  }

  async deleteLines(root, file) {
    const loc = locate(file);
    const db = loc && await this.db(at(root, loc.db));
    if (!db) return;
    if (loc.table === 'puzzle_attempts') db.run('DELETE FROM puzzle_attempts WHERE archive IS ?', [loc.archive]);
    else db.run(`DELETE FROM ${loc.table}`);
  }

  /** The attempts files of one database (DATA's progress, or a profile's), sorted as Python's glob sorted. */
  async attemptFiles(dbName, dir = null) {
    const db = await this.db(dbName);
    if (!db) return [];
    const archives = db.column('SELECT DISTINCT archive FROM puzzle_attempts');
    return sorted(archives.map(a => attemptsFile(a, dir)));
  }

  /** The library's files under root: puzzle_attempts*.jsonl, then puzzle_solved and puzzle_daily if they have lines. */
  async libraryFiles(root) {
    const name = at(root, PROGRESS);
    const out = await this.attemptFiles(name);
    const db = await this.db(name);
    if (db) {
      for (const t of ['puzzle_solved', 'puzzle_daily']) if (db.value(`SELECT count(*) FROM ${t}`)) out.push(`${t}.jsonl`);
    }
    return out;
  }

  /** profiles/<id>/puzzle_attempts*.jsonl under root, for every profile folder there. */
  async profileFiles(root) {
    const out = [];
    for (const e of await this.files.list(at(root, 'profiles'))) {
      if (!e.dir || !validId(e.name)) continue;
      out.push(...await this.attemptFiles(at(root, profileDb(e.name)), `profiles/${e.name}`));
    }
    return out;
  }

  /** profile id → meta.json, for the profiles that are synced. */
  async metas(root = '') {
    const out = {};
    for (const e of await this.files.list(at(root, 'profiles'))) {
      if (!e.dir) continue;
      const text = await this.files.readText(at(root, `profiles/${e.name}/meta.json`));
      if (text === null) continue;
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        continue;
      }
      if (isObject(m) && SYNCED_SOURCES.includes(m.source) && truthy(m.username)) out[e.name] = m;
    }
    return out;
  }

  /** {file: [line, ...]} for every puzzle-progress file there is under root, and the profile list. */
  async local(root = '') {
    const out = {};
    for (const f of [...await this.libraryFiles(root), ...await this.profileFiles(root)]) out[f] = await this.readLines(root, f);
    const metas = await this.metas(root);
    if (Object.keys(metas).length) out[PROFILES] = sorted(Object.keys(metas)).map(pid => profileLine(metas[pid]));
    return out;
  }

  async loadBase(user) {
    try {
      const b = JSON.parse(await this.files.readText(BASE));
      return b.user === user ? b.files ?? {} : {};
    } catch {
      return {};
    }
  }

  async saveBase(user, files) {
    await this.files.writeText(`${BASE}.tmp`, pyDumps({ user, files }));
    await this.files.rename(`${BASE}.tmp`, BASE);
  }

  busy(pid) {
    const r = this.runner;
    return !!(r && r.busy() && r.job?.profile?.id === pid);
  }

  async removeProfile(root, pid) {
    await this.dropDb(at(root, profileDb(pid)));
    await this.files.remove(at(root, `profiles/${pid}`));
  }

  /** Make the profiles here match the account's list (sync.apply_profiles). Returns the ones created. */
  async applyProfiles(here, merged) {
    const want = new Map();
    for (const ln of merged) {
      const k = profileKey(ln);
      if (k) want.set(k, JSON.parse(ln));
    }
    const have = await this.metas();
    const added = [];
    for (const [pid, v] of want) {
      let m = pid in have ? { ...have[pid] } : null;
      if (m === null) {
        m = { source: v.source, username: v.username, created: v.added ?? null };
        added.push({ source: v.source, username: v.username });
      }
      if (truthy(v.pinned)) m.pinned = v.pinned;
      else delete m.pinned;
      if (!(pid in have) || profileLine(m) !== profileLine(have[pid])) {
        await this.files.writeText(`profiles/${pid}/meta.json`, pyDumps(m));
      }
    }
    for (const pid of Object.keys(have)) {
      if (want.has(pid)) continue;
      if (this.busy(pid)) {
        this.log?.info?.(`not removing ${pid}: busy`);     // stays here, and goes back up with the next sync
        continue;
      }
      await this.runner?.cancelBuild(pid);
      await this.removeProfile('', pid);
    }
    return added;
  }

  async delta(user) {
    const [add, remove] = diff(await this.loadBase(user), await this.local());
    return { add, remove };
  }

  /** Write the merged files here and remember the account's answer as the base. Returns what changed here. */
  async commit(user, theirs) {
    const here = await this.local();
    const merged = merge(await this.loadBase(user), here, theirs);
    const changed = [];
    let added = [];
    for (const f of sorted(new Set([...Object.keys(here), ...Object.keys(merged)]))) {
      if (sameList(here[f], merged[f]) || f === PROFILES) continue;
      changed.push(f);
      if (f in merged) await this.writeLines('', f, merged[f]);
      else await this.deleteLines('', f);      // its lines all moved elsewhere: a reset on another browser
    }
    if (!sameList(here[PROFILES], merged[PROFILES])) {
      changed.push(PROFILES);       // after the files: a profile removed takes its schedule along
      added = await this.applyProfiles(here[PROFILES] ?? [], merged[PROFILES] ?? []);
    }
    await this.saveBase(user, theirs);
    const [a, r] = diff(theirs, await this.local());
    return { changed, pending: Object.keys(a).length > 0 || Object.keys(r).length > 0, profiles_added: added };
  }

  // ---------- whose data is in DATA ----------

  /** The account whose data is in DATA, or null for the guest. */
  async owner() {
    try {
      return JSON.parse(await this.files.readText(BASE)).user || null;
    } catch {
      return null;
    }
  }

  /** What belongs to the owner: the synced profiles' folders (reviews and all), the puzzle files outside them, and
   * the base. [{kind: 'dir' | 'lines' | 'file', path}] */
  async items() {
    const dirs = new Set(Object.keys(await this.metas()).map(pid => `profiles/${pid}`));
    const out = [...dirs].map(path => ({ kind: 'dir', path }));
    for (const f of [...await this.libraryFiles(''), ...await this.profileFiles('')]) {
      const parts = f.split('/');
      if (!(parts.length > 2 && dirs.has(parts.slice(0, 2).join('/')))) out.push({ kind: 'lines', path: f });
    }
    if (await this.files.exists(BASE)) out.push({ kind: 'file', path: BASE });
    return out.sort((a, b) => cmp(a.path, b.path));
  }

  /** A virtual file from one root into another (sync._move of a puzzle file). */
  async moveLines(src, dst, file, merge) {
    const lines = await this.readLines(src, file);
    if (!lines.length) return;
    const there = await this.readLines(dst, file);
    if (!there.length) await this.writeLines(dst, file, lines);
    else if (merge) await this.writeLines(dst, file, tidy(file, [...there, ...lines]));
    await this.deleteLines(src, file);
  }

  /** A profile's database along with its folder: where the other side has none, the whole of it; else the other
   * side's games stay, and the puzzle files go one by one. */
  async moveProfileDb(src, dst, pid, merge) {
    const s = at(src, profileDb(pid)), d = at(dst, profileDb(pid));
    if (!(await this.dbExists(s))) return;
    if (!(await this.dbExists(d))) {
      await this.store.close(s);
      if (await this.files.exists(s)) {
        await this.files.rename(s, d);      // the files and the databases share a folder (the desktop)
      } else {
        await this.copyDb(s, d);
        await this.store.driver.remove(s);
      }
      return;
    }
    for (const f of await this.attemptFiles(s, `profiles/${pid}`)) await this.moveLines(src, dst, f, merge);
    await this.dropDb(s);
  }

  /** Every table of a profile's database into a new one (where the databases aren't files: the browser). */
  async copyDb(from, to) {
    const a = await this.store.connect(from, PROFILE_DDL, [[EVALS, 'ev']]);
    const b = await this.store.connect(to, PROFILE_DDL, [[EVALS, 'ev']]);
    const tables = a.column("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    b.tx(() => {
      for (const t of tables) {
        const cols = a.all(`PRAGMA main.table_info(${t})`).map(c => c.name);
        const order = cols.includes('seq') ? ' ORDER BY seq' : '';
        b.insert(t, cols, a.all(`SELECT * FROM main.${t}${order}`));
      }
    });
    await this.store.close(from);
    await this.store.close(to);
  }

  /** sync._move of a folder: into one already there, its contents go one by one and what's there stays. */
  async moveDir(src, dst, rel, merge) {
    const m = /^profiles\/([^/]+)$/.exec(rel);
    if (m) await this.moveProfileDb(src, dst, m[1], merge);
    await this.files.mkdir(at(dst, rel));
    for (const e of await this.files.list(at(src, rel))) {
      if (DB_FILE.test(e.name)) continue;     // the databases go their own way (moveProfileDb, moveLines)
      if (e.dir) await this.moveDir(src, dst, `${rel}/${e.name}`, merge);
      else await this.moveFile(src, dst, `${rel}/${e.name}`);
    }
    await this.files.remove(at(src, rel));
  }

  /** sync._move of a file: one already there stays. */
  async moveFile(src, dst, rel) {
    if (await this.files.exists(at(dst, rel))) await this.files.remove(at(src, rel));
    else await this.files.rename(at(src, rel), at(dst, rel));
  }

  /** A workspace's contents back into DATA, and the workspace gone. */
  async moveBack(ws, merge) {
    for (const f of await this.libraryFiles(ws)) await this.moveLines(ws, '', f, merge);
    await this.dropDb(at(ws, PROGRESS));
    for (const e of await this.files.list(ws)) {
      if (DB_FILE.test(e.name)) continue;
      if (e.dir) await this.moveDir(ws, '', e.name, merge);
      else await this.moveFile(ws, '', e.name);
    }
    await this.removeTree(ws);
  }

  /** A workspace deleted, its databases with it. */
  async removeTree(root) {
    await this.dropDb(at(root, PROGRESS));
    for (const e of await this.files.list(at(root, 'profiles'))) if (e.dir) await this.dropDb(at(root, profileDb(e.name)));
    await this.files.remove(root);
  }

  async deleteItem(item) {
    if (item.kind === 'dir') await this.removeProfile('', item.path.split('/')[1]);
    else if (item.kind === 'lines') await this.deleteLines('', item.path);
    else await this.files.remove(item.path);
  }

  workspace(who) {
    const name = who || GUEST;
    if (!/^[\p{L}\p{N}_-]*$/u.test(name)) throw new BadRequest(`bad account id ${pyRepr(name)}`);
    return `${WORKSPACES}/${name}`;
  }

  async busyAny() {
    return Object.keys(await this.metas()).some(pid => this.busy(pid));
  }

  /** What a guest has here that a new account could take: puzzle records and profiles. */
  async guestData() {
    const here = await this.local();
    let records = 0;
    for (const [f, v] of Object.entries(here)) if (f !== PROFILES) records += v.length;
    return { puzzle_records: records, profiles: (here[PROFILES] ?? []).length };
  }

  async invalidate() {
    await this.onSwitch?.();
  }

  /** Make DATA hold `user`'s data (null: the guest's), as sync.switch. */
  async switch(user, { keep = false, wipe = false } = {}) {
    const cur = await this.owner();
    if (cur === user) return { switched: false };
    if (await this.busyAny()) return { busy: true };
    if (cur === null && user && keep) return { switched: false, kept: true };     // the first sync uploads it all
    const away = this.workspace(cur);
    for (const item of await this.items()) {
      if (wipe) await this.deleteItem(item);
      else if (item.kind === 'dir') await this.moveDir('', away, item.path, false);
      else if (item.kind === 'lines') await this.moveLines('', away, item.path, false);
      else await this.moveFile('', away, item.path);
    }
    const back = this.workspace(user);
    if (await this.files.exists(back)) await this.moveBack(back, false);
    await this.invalidate();
    return { switched: true };
  }

  /** The account was deleted: its copy here becomes the guest's (or with `wipe` goes), and what the guest had set
   * aside comes back alongside it. */
  async release(wipe = false) {
    if (await this.busyAny()) return { busy: true };
    const cur = await this.owner();
    await this.files.remove(BASE);
    if (wipe) for (const item of await this.items()) await this.deleteItem(item);
    const back = this.workspace(null);
    if (await this.files.exists(back)) await this.moveBack(back, true);
    if (cur) await this.removeTree(this.workspace(cur));
    await this.invalidate();
    return { released: true };
  }

  /** serve.py's /api/sync/* routes, for static/account.js: the answer, or null for a bad request. */
  async handle(path, body) {
    if (!isObject(body)) throw new TypeError(`'${Array.isArray(body) ? 'list' : typeof body}' object has no attribute 'get'`);
    const user = truthy(body.user) ? pyStr(body.user) || null : null;
    if (path === '/api/sync/state') {
      const owner = await this.owner();
      return { owner, guest_data: owner === null ? await this.guestData() : null };
    }
    if (path === '/api/sync/delta' && user) return this.delta(user);
    if (path === '/api/sync/commit' && user && isObject(body.files)) {
      const theirs = {};
      for (const [k, v] of Object.entries(body.files)) if (Array.isArray(v)) theirs[k] = v.map(pyStr);
      return this.commit(user, theirs);
    }
    if (path === '/api/sync/switch') return this.switch(user, { keep: truthy(body.keep), wipe: truthy(body.wipe) });
    if (path === '/api/sync/release') return this.release(truthy(body.wipe));
    return null;
  }
}
