// In-app updates, as chess_review/updater.py: check GitHub for a newer release, download it into DATA/update, hand it
// to the platform to swap in on restart. Same answers for GET /api/update and POST /api/update/download as Python's.
//
// Everything outside goes through what the constructor is given:
//     fetch        the Fetch API (GitHub's API and the release asset)
//     files        a profiles-files.js adapter at the data directory (the download lands in update/)
//     installed    {version, runtime}: the build's resources/build.json; nulls from a checkout (no updates there)
//     platform     process.platform on the desktop: updates are for the Windows build only
//     unpack       async (zipPath, stageDir, kind) → stage path; checks and unpacks the download (updater.unpack).
//                  Without it the downloaded file is the stage (an app.asar needs no unpacking).
//     apply        async ({stage, kind, installed, latest}) → void; replaces the running app and restarts it (the
//                  apply script and closing the window: js/desktop's job). Without it, apply answers an error.
//     now          seconds since the epoch
//
// The asset names are Python's by default; the Electron build passes its own (js/desktop/README.md's plan).

export const USER_AGENT = 'chess-review/0.1 (personal offline game analysis tool)';   // config.USER_AGENT
export const GITHUB_REPO = 'aris-ver/chess-review';
export const CHECK_TTL = 3600;    // a launch re-checks GitHub at most once an hour (unauthenticated API: 60 req/h)
export const UPDATE_DIR = 'update';

/** updater.py's asset names: the small zip per runtime, the full zip, and the full zip's name up to v0.6.0. */
export const PYTHON_ASSETS = {
  update: 'chess-review-update-{runtime}.zip', full: 'Blundr-windows.zip', legacyFull: 'chess-review-windows.zip',
};
/** The Electron build's (js/desktop/README.md): just app.asar for a small update, the whole folder zipped for a full one. */
export const ELECTRON_ASSETS = { update: 'blundr-app-{runtime}.asar', full: 'Blundr-windows.zip', legacyFull: null };

/** requests' HTTPError, with its message. */
export class HttpError extends Error {}

/** response.raise_for_status(): requests' wording, so the messages read as Python's do. */
export function raiseForStatus(resp, url) {
  const s = resp.status;
  const kind = s >= 400 && s < 500 ? 'Client' : s >= 500 && s < 600 ? 'Server' : null;
  if (kind) throw new HttpError(`${s} ${kind} Error: ${resp.statusText} for url: ${resp.url || url}`);
}

/** 'v0.1.5' → [0, 1, 5]; a git-describe string like 'v0.1.4-3-gabc123' → [0, 1, 4]. null if unparsable. */
export function parseVersion(tag) {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(tag ?? '');
  return m ? m[1].split('.').map(Number) : null;
}

/** Python's tuple comparison. */
export function cmpVersion(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

/** The small update built for this install's runtime if the release has one, else the full download. */
export function pickAsset(release, runtime, names = PYTHON_ASSETS) {
  const assets = new Map((release.assets ?? []).map(a => [a.name, a]));
  const small = runtime ? assets.get(names.update.replace('{runtime}', runtime)) : undefined;
  const a = small ?? assets.get(names.full) ?? (names.legacyFull ? assets.get(names.legacyFull) : undefined);
  if (!a) return null;
  return { name: a.name, url: a.browser_download_url, size: a.size ?? null, kind: small ? 'update' : 'full' };
}

const BREAK = '\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029';    // str.splitlines()'s line boundaries
const LINES = new RegExp(`\\r\\n|[${BREAK}]`);
const splitlines = s => {
  const out = s.split(LINES);
  if (new RegExp(`[${BREAK}]$`).test(s)) out.pop();     // "a\n".splitlines() is ['a']
  return out;
};
const strip = s => s.replace(/^\s+|\s+$/g, '');

/** The '## What's new' part of a release body as the workflow writes it; a body without that heading, whole. */
export function whatsNew(body) {
  const lines = splitlines(body ?? '');
  const start = lines.findIndex(l => /^#{1,3}\s+what'?s new/i.test(strip(l)));
  if (start < 0) return strip(body ?? '');
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(l) || strip(l).toLowerCase().startsWith('**full changelog**')) break;
    out.push(l);
  }
  return strip(out.join('\n'));
}

/** Every published release after the installed version up to the latest, newest first: what an update brings. */
export function changesSince(releases, mine, latest) {
  const out = [];
  for (const rel of releases) {
    const v = parseVersion(rel.tag_name);
    if (rel.draft || rel.prerelease || !v || !(cmpVersion(mine, v) < 0 && cmpVersion(v, latest) <= 0)) continue;
    out.push({ version: rel.tag_name, date: (rel.published_at || '').slice(0, 10), notes: whatsNew(rel.body) });
  }
  return out.sort((a, b) => cmpVersion(parseVersion(b.version), parseVersion(a.version)));
}

export class Updater {
  constructor({ fetch = globalThis.fetch, files = null, installed = null, platform = null, unpack = null, apply = null,
                now = () => Date.now() / 1000, assets = PYTHON_ASSETS, repo = GITHUB_REPO, log = null } = {}) {
    Object.assign(this, { fetch, files, unpack, applyHook: apply, now, assets, repo, log, platform });
    this.installed = { version: installed?.version ?? null, runtime: installed?.runtime ?? null };
    this.latest = null;         // {version, url, notes, asset, changes} once checked
    this.checkedAt = 0;
    this.checkError = null;
    this.state = 'idle';        // idle | downloading | ready | error
    this.done = 0;
    this.total = 0;
    this.error = null;
    this.stage = null;          // what apply() swaps in
    this.task = null;           // the download under way (a promise)
  }

  get enabled() {
    return this.installed.version !== null && this.platform === 'win32';
  }

  async get(url, params = null) {
    const full = params ? `${url}?${new URLSearchParams(params)}` : url;
    const r = await this.fetch(full, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
                                       signal: AbortSignal.timeout(10_000) });
    raiseForStatus(r, full);
    return r.json();
  }

  async check(force = false) {
    if (!this.enabled || (!force && this.now() - this.checkedAt < CHECK_TTL)) return;
    const api = `https://api.github.com/repos/${this.repo}/releases`;
    try {
      const rel = await this.get(`${api}/latest`);
      this.latest = { version: rel.tag_name ?? null, url: rel.html_url ?? null, notes: rel.body || '',
                      asset: pickAsset(rel, this.installed.runtime, this.assets), changes: [] };
      this.checkError = null;
      if (this.newer) {     // one more request, only when there is an update: the notes of every skipped release
        try {
          this.latest.changes = changesSince(await this.get(api, { per_page: 100 }), parseVersion(this.installed.version),
                                             parseVersion(this.latest.version));
        } catch (e) {
          this.log?.warn?.(`could not list releases: ${e.message}`);    // the latest release's notes still show
        }
      }
    } catch (e) {
      this.log?.warn?.(`update check failed: ${e.message}`);
      this.checkError = String(e.message ?? e);
    }
    this.checkedAt = this.now();
  }

  get newer() {
    const mine = parseVersion(this.installed.version), theirs = parseVersion(this.latest?.version);
    return !!(mine && theirs && cmpVersion(theirs, mine) > 0 && this.latest.asset);
  }

  status() {
    const out = { enabled: this.enabled, installed: this.installed.version, state: this.state, done: this.done,
                  total: this.total, error: this.error, check_error: this.checkError };
    if (this.latest) {
      const a = this.latest.asset;
      Object.assign(out, { latest: this.latest.version, url: this.latest.url, notes: this.latest.notes, newer: this.newer,
                           changes: this.latest.changes ?? [], kind: a ? a.kind : null, size: a ? a.size : null });
    }
    return out;
  }

  /** Start fetching the latest release's download in the background. False if nothing to do or already busy. */
  download() {
    if (!this.newer || this.state === 'downloading' || this.state === 'ready') return false;
    [this.state, this.done, this.total, this.error] = ['downloading', 0, this.latest.asset.size || 0, null];
    this.task = this._download(this.latest.asset);
    return true;
  }

  async _download(asset) {
    try {
      await this.files.remove(UPDATE_DIR);
      await this.files.mkdir(UPDATE_DIR);
      const path = `${UPDATE_DIR}/${asset.name}`;
      const r = await this.fetch(asset.url, { headers: { 'User-Agent': USER_AGENT } });
      raiseForStatus(r, asset.url);
      this.total = parseInt(r.headers.get('Content-Length') || '', 10) || this.total;
      const chunks = [];
      const reader = r.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        this.done += value.length;
      }
      const bytes = new Uint8Array(this.done);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.length;
      }
      await this.files.writeBytes(path, bytes);
      if (this.unpack) {
        this.stage = await this.unpack(path, `${UPDATE_DIR}/stage`, asset.kind);
        await this.files.remove(path);
      } else {
        this.stage = path;
      }
      this.state = 'ready';
    } catch (e) {     // whatever went wrong, the page shows it and the install is untouched
      this.log?.error?.(`update download failed: ${e.message}`);
      [this.state, this.error] = ['error', String(e.message ?? e)];
    }
  }

  /** Hand over to the platform, which replaces the app and restarts it. Only once state is 'ready'. */
  async apply() {
    if (this.state !== 'ready' || !this.stage) throw new Error('no update ready');
    if (!this.applyHook) throw new Error('this build cannot apply updates');
    const kind = this.latest.asset.kind === 'update' ? 'update' : 'full';
    await this.applyHook({ stage: this.stage, kind, installed: this.installed, latest: this.latest });
    this.log?.info?.(`update ${this.installed.version} -> ${this.latest.version}: handed to the platform`);
  }
}
