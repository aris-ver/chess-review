// Route-level parity for the rest of serve.Handler: tests/parity/routes-rest.json (scripts/dump_routes_rest_parity.py
// ran the requests through serve.Handler) replayed on the JS router, every outside request answered from the step's
// own replies and checked against the request Python made. Compared: status, content type, the JSON (or text, or
// bytes), the account token, what was opened in the browser and, after each sync step, the data folder as sync sees it.
// Run twice: with the files in memory and the databases apart from them (the browser), and with both in one folder
// (the desktop).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CROSS_SITE, crossSite } from '../desktop/server.js';
import { load, same } from '../parity.js';
import { Account } from './account.js';
import { nodeSqlite } from './db-node.js';
import { Store } from './db.js';
import { nodeFiles } from './profiles-files-node.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';
import { serve } from './router.js';
import { Sync, locate } from './sync.js';
import { Updater } from './updater.js';

const dec = new TextDecoder();
const b64 = s => Uint8Array.from(Buffer.from(s ?? '', 'base64'));
const VOLATILE_BODY = new Set(['challenge', 'verifier']);
const VOLATILE = new Set(['path']);

const scrub = (v, keys) => {
  if (Array.isArray(v)) return v.map(x => scrub(x, keys));
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys.has(k) ? x !== null && x !== '' : scrub(x, keys)]));
};

/** The outside world: each request answered by the next reply in the list, and checked against the one Python made. */
function tape() {
  const t = {
    queue: [], errors: [],
    load(upstream) {
      t.queue = [...upstream];
      t.errors = [];
    },
    async fetch(url, init = {}) {
      const want = t.queue.shift();
      if (!want) {
        t.errors.push(`unexpected request ${url}`);
        throw new TypeError('no reply left');
      }
      const body = init.body == null ? null : typeof init.body === 'string' ? init.body : dec.decode(init.body);
      const got = { method: init.method ?? 'GET', url, headers: init.headers ?? {}, body };
      try {
        same(got.method, want.method, 'upstream method');
        same(got.url, want.url, 'upstream url');
        same(got.headers, want.headers, `upstream headers of ${url}`);
        if (want.body !== null && want.body.startsWith('{')) {
          same(scrub(JSON.parse(got.body), VOLATILE_BODY), scrub(JSON.parse(want.body), VOLATILE_BODY), `upstream body of ${url}`);
        } else {
          same(got.body, want.body, `upstream body of ${url}`);
        }
      } catch (e) {
        t.errors.push(e.message);
      }
      const rep = want.reply;
      if (rep.raise) throw new TypeError(rep.raise);
      const bytes = rep.zeros !== undefined ? new Uint8Array(rep.zeros) : b64(rep.b64);
      return new Response(bytes, { status: rep.status, statusText: rep.reason, headers: rep.headers });
    },
    done(what) {
      assert.deepEqual(t.errors, [], `${what}: upstream`);
      assert.equal(t.queue.length, 0, `${what}: replies left over`);
    },
  };
  return t;
}

/** dump_routes_rest_parity.view: per root, sync's files and the profile files (meta.json and the base word for word). */
async function view(sync, files) {
  const roots = [''];
  for (const e of await files.list('.accounts')) if (e.dir) roots.push(`.accounts/${e.name}`);
  const out = {};
  for (const r of roots) {
    const found = {};
    const walk = async rel => {
      for (const e of await files.list(r ? (rel ? `${r}/${rel}` : r) : rel)) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.dir) {
          if (p !== '.accounts') await walk(p);
        } else if (!/\.jsonl$|\.sqlite(-wal|-shm|-journal)?$/.test(p) && (p.startsWith('profiles/') || p === 'account_sync.json')) {
          found[p] = /(^|\/)(meta|account_sync)\.json$/.test(p) ? await files.readText(r ? `${r}/${p}` : p) : true;
        }
      }
    };
    await walk('');
    const local = await sync.local(r);
    if (r && !Object.keys(found).length && !Object.keys(local).length) continue;
    out[r] = { local, files: found };
  }
  return out;
}

async function replay(name, { files, dbDir }) {
  const d = load('routes-rest.json');
  const store = new Store(nodeSqlite(dbDir));
  const t = tape();
  const opened = [];
  let saved = null;
  const env = { store, files, profiles: new Profiles(files, store), fetch: t.fetch, sleep: async () => {} };
  const pool = { size: 1, name: 'none', async load() {}, async search() { throw new Error('no engine here'); } };
  const applied = [];
  // Python's download thread runs at the dump's "drain" step; the JS download starts at once, so its request waits
  // for that step (the GitHub API's don't)
  let open, gate;
  const shut = () => { gate = new Promise(resolve => { open = resolve; }); };
  shut();
  const updaterFetch = async (url, init) => {
    if (!url.startsWith('https://api.github.com/')) await gate;
    return t.fetch(url, init);
  };
  try {
    const router = await serve({ env, pool, nodes: 1000, scan: false });
    env.account = new Account({
      fetch: t.fetch, files, port: () => d.port, openBrowser: url => opened.push(url),
      saveExport: async bytes => {
        saved = dec.decode(bytes);
        await files.writeBytes('blundr-account.json', bytes);
        return '/data/blundr-account.json';
      },
    });
    const sync = env.sync = new Sync({ files, store, runner: router.runner });
    for (const [i, s] of d.steps.entries()) {
      const what = `${name} #${i} ${s.method ?? Object.keys(s)[0]} ${s.path ?? ''}`;
      if (s.seed) {
        for (const [rel, text] of Object.entries(s.seed)) {
          if (locate(rel)) await sync.writeLines('', rel, text.split('\n').filter(Boolean));
          else await files.writeText(rel, text);
        }
        same(await view(sync, files), s.view, `${what} view`);
        continue;
      }
      if (s.file) {
        same(await files.readText(s.file), s.text, what);
        continue;
      }
      if (s.updater) {
        env.updater = new Updater({
          fetch: updaterFetch, files, installed: s.updater.installed, platform: s.updater.platform,
          unpack: async (zip, stage) => {
            assert.ok(await files.exists(zip), `${what}: the download is there to unpack`);
            return `${stage}/Blundr`;
          },
          apply: async info => applied.push(info),
        });
        continue;
      }
      if (s.drain) {
        t.load(s.upstream);
        open();
        await env.updater.task;
        shut();
        t.done(what);
        continue;
      }
      t.load(s.upstream);
      saved = null;
      const headers = Object.fromEntries(Object.entries({ Host: `127.0.0.1:${d.port}`, ...s.headers }).map(([k, v]) => [k.toLowerCase(), v]));
      const out = s.path.startsWith('/account/') && crossSite(headers, d.port)
        ? CROSS_SITE
        : await router.handle(s.method, s.path, s.body, s.body ? 'application/json' : null);
      t.done(what);
      same(out.status, s.status, `${what} status`);
      same((out.headers['Content-Type'] ?? '').split(';')[0], s.type, `${what} type`);
      const bytes = typeof out.body === 'string' ? new TextEncoder().encode(out.body) : out.body;
      if (s.lenient) assert.ok('error' in JSON.parse(dec.decode(bytes)), `${what}: an error`);
      else if (s.json !== undefined) same(scrub(JSON.parse(dec.decode(bytes)), VOLATILE), scrub(s.json, VOLATILE), what);
      else if (s.text !== undefined) same(dec.decode(bytes), s.text, what);
      else if (s.length !== undefined) same(bytes.length, s.length, `${what} length`);
      else same(Buffer.from(bytes).toString('base64'), s.b64, `${what} bytes`);
      same(await env.account.loadToken(), s.token, `${what} token`);
      same(opened.splice(0), s.opened, `${what} opened`);
      if (s.saved !== undefined) same(saved, s.saved, `${what} saved`);
      if (s.view) same(await view(sync, files), s.view, `${what} view`);
    }
    assert.equal(applied.length, 1, 'the ready update was handed to the platform once');
    assert.equal(applied[0].kind, 'update');
  } finally {
    await store.close();
  }
}

test('the JS routes answer as serve.Handler does: files in memory, databases apart (the browser)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-rest-'));
  try {
    await replay('web', { files: memoryFiles(), dbDir: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the JS routes answer as serve.Handler does: files and databases in one folder (the desktop)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-rest-'));
  try {
    await replay('desktop', { files: nodeFiles(dir), dbDir: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- what the dump can't reach ----------

async function bare(fetch = async () => { throw new TypeError('offline'); }) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-rest-'));
  const store = new Store(nodeSqlite(dir)), files = memoryFiles();
  const env = { store, files, profiles: new Profiles(files, store), fetch };
  const pool = { size: 1, name: 'none', async load() {}, async search() { throw new Error('no engine here'); } };
  const router = await serve({ env, pool, nodes: 1000, scan: false });
  const done = async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { router, env, files, done };
}

test('routes-rest: apply waits for a job the user asked for, not for a background one', async () => {
  const { router, env, done } = await bare();
  try {
    const u = env.updater = new Updater({ installed: { version: 'v1' }, platform: 'win32', apply: async () => {} });
    Object.assign(u, { state: 'ready', stage: 'update/x', latest: { version: 'v2', asset: { kind: 'update' } } });
    router.runner.job = { kind: 'analyse', status: 'running', profile: { id: 'p' }, toDict: () => ({ kind: 'analyse' }) };
    const busy = await router.handle('POST', '/api/update/apply');
    assert.deepEqual([busy.status, JSON.parse(busy.body)], [409, { error: 'busy', job: { kind: 'analyse' } }]);
    router.runner.job.kind = 'build';
    assert.equal((await router.handle('POST', '/api/update/apply')).status, 200);
    router.runner.job = null;
    u.applyHook = null;
    const no = await router.handle('POST', '/api/update/apply');
    assert.deepEqual([no.status, JSON.parse(no.body)], [400, { error: 'this build cannot apply updates' }]);
  } finally {
    await done();
  }
});

test('routes-rest: an image with no length is cut off past 10 MB; settings saved at once all land', async () => {
  const chunk = new Uint8Array(1 << 20);
  let pulled = 0;
  const fetch = async () => new Response(new ReadableStream({
    pull(c) {
      pulled++;
      c.enqueue(chunk);
    },
  }), { headers: { 'Content-Type': 'image/png' } });
  const { router, files, done } = await bare(fetch);
  try {
    const out = await router.handle('GET', '/api/fetch_image?url=https://x/y.png');
    assert.deepEqual([out.status, JSON.parse(out.body)], [413, { error: 'image larger than 10 MB' }]);
    assert.ok(pulled <= 13, 'stopped reading');
    await Promise.all(['a', 'b', 'c'].map(k => router.handle('POST', '/api/settings', JSON.stringify({ [k]: k }))));
    assert.equal(await files.readText('settings.json'), '{\n "a": "a",\n "b": "b",\n "c": "c"\n}');
  } finally {
    await done();
  }
});

test('routes-rest: the desktop server answers account/* from another site with a 403', async () => {
  const { request } = await import('node:http');
  const { STATIC_DIR } = await import('../desktop/paths.js');
  const { listen, makeServer } = await import('../desktop/server.js');
  const server = makeServer({ staticDir: STATIC_DIR, api: async () => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok": 1}' }) });
  const port = await listen(server, '127.0.0.1', 0);
  const get = (path, headers) => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, res => {
      let body = '';
      res.on('data', c => { body += c; }).on('end', () => resolve([res.statusCode, body]));
    }).on('error', reject).end();
  });
  try {
    assert.deepEqual(await get('/account/me', {}), [200, '{"ok": 1}']);
    assert.deepEqual(await get('/account/me', { Host: `localhost:${port}`, Origin: `http://localhost:${port}` }), [200, '{"ok": 1}']);
    assert.deepEqual(await get('/account/me', { Host: `blundr.example:${port}` }), [403, '{"error":"cross-site request"}']);
    assert.deepEqual(await get('/account/me', { Origin: 'https://evil.example' }), [403, '{"error":"cross-site request"}']);
    assert.deepEqual(await get('/api/status', { Host: `blundr.example:${port}` }), [200, '{"ok": 1}']);
  } finally {
    server.close();
  }
});
