// The service worker (web/shim.js registers it, on the web only): Blundr opens and works with no network once it has
// been opened online, as an app on a phone's home screen most of all. scripts/build_web.js writes it to the site's
// root as offline.js, with the line before this one: self.OFFLINE = { version, files: { path: sha256 } }, every file
// the app needs offline with the hash of its bytes ('' is the page, index.html), and version, a hash of them all.
//
// One build, one cache: blundr-offline-<version>. Installing fetches every file of the list (or copies it from the
// cache of the build before, when its hash is the same), checks each against its hash, and fails as a whole if one
// doesn't match or doesn't come: a half-updated mix of two builds is never kept. A new build waits until the page's
// "Reload" (or until no tab is open) and then deletes every other build's cache (one still installing then fails its
// last check and is tried again later). A page is answered by one build from start to end: its own files from its
// cache, and what isn't in the list from the network.
//
// An install that fails for good (lasting(): a file not as listed, an HTTP error, storage full, its cache deleted)
// says so to the open pages (a message) and to the next ones (FAILED, a cache of one entry): a page of an older
// build then offers "Couldn't update Blundr. Reload", which drops the service worker and its caches
// and loads the site from the network (web/shim.js), so a phone is never stuck on an old build in silence. A failure
// that may pass (the network dropped, a deploy still going out) is not noted: the next launch simply tries again.
//
// Not here: the engines' .wasm files, which web/engines.js keeps in Cache Storage itself (chess-review-engines), the
// answers web/shim.js keeps (blundr-kept), and anything of another site (chess.com, lichess, unpkg) or under
// /account/, which go to the network as without this.

const { version: VERSION, files: FILES } = self.OFFLINE;
const PREFIX = 'blundr-offline-';
const CACHE = PREFIX + VERSION;
const SCOPE = new URL(self.registration.scope);
const HASH = 'X-Blundr-Sha256';       // what each kept file was checked against, so the next build can reuse it
const PAGE_WAIT_MS = 3000;            // the network's chance at the page before the kept one is shown
const PARALLEL = 6;
const FAILED = PREFIX + 'failed';     // {version, reason} of the last install that failed; gone with the next that works

const urlOf = rel => new URL(rel, SCOPE).href;
const relOf = url => {
  const u = new URL(url);
  return u.origin === SCOPE.origin && u.pathname.startsWith(SCOPE.pathname) ? u.pathname.slice(SCOPE.pathname.length) : null;
};
// the build a page is (scripts/build_web.js puts it in the page's head)
const pageVersion = html => (/<meta name="blundr-offline" content="([0-9a-f]+)">/.exec(html) || [])[1] || null;

/** e, marked as a failure that trying again won't mend. */
const lastingError = message => Object.assign(new Error(message), { lasting: true });
const lasting = e => !!(e && (e.lasting || e.name === 'QuotaExceededError'));

async function sha256(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The response to keep for rel: its bytes, its type (and the page's security headers), and the hash it was checked against. */
function kept(res, buf, hash) {
  const headers = new Headers();
  for (const [k, v] of res.headers) if (!/^(content-encoding|content-length|transfer-encoding|etag|last-modified|date|age)$/i.test(k)) headers.set(k, v);
  headers.set(HASH, hash);
  return new Response(buf, { status: 200, headers });
}

/** rel fetched and checked: its bytes must hash to what the list says (the page: must be this build's, as a zone
 * feature of the host may rewrite HTML). */
async function fetchChecked(rel, hash) {
  // asked again past the browser's HTTP cache, which may hold an older copy (themes/ is kept a day) or, from an
  // install that failed, a bad one
  const res = await fetch(urlOf(rel), { cache: 'no-cache', credentials: 'same-origin' });
  if (!res.ok) throw lastingError(`${rel || 'the page'}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (rel === '') {
    const v = pageVersion(new TextDecoder().decode(buf.slice(0, 64 * 1024)));
    if (v !== VERSION) throw new Error(`the page is build ${v}, not ${VERSION}: a deploy is under way`);
  } else {
    const got = await sha256(buf);
    if (got !== hash) throw lastingError(`${rel} is not this build's (SHA-256 ${got.slice(0, 12)}, not ${hash.slice(0, 12)})`);
  }
  return kept(res, buf, hash);
}

/** The same file kept by an earlier build (the same hash), if there is one: nothing to download again. */
async function reusable(rel, hash, older) {
  if (rel === '') return null;
  for (const c of older) {
    const r = await c.match(urlOf(rel));
    if (r && r.headers.get(HASH) === hash) return r;
  }
  return null;
}

async function install() {
  const names = (await caches.keys()).filter(n => n.startsWith(PREFIX) && n !== CACHE && n !== FAILED);
  const older = await Promise.all(names.map(n => caches.open(n)));
  await caches.delete(CACHE);       // what an install that failed half-way left: start whole
  const cache = await caches.open(CACHE);
  const todo = Object.entries(FILES);
  let failed = null;
  const next = async () => {
    while (todo.length && !failed) {
      const [rel, hash] = todo.shift();
      try {
        await cache.put(urlOf(rel), (await reusable(rel, hash, older)) || (await fetchChecked(rel, hash)));
      } catch (e) {
        failed = failed || e;
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, next));
  // another build's activation deletes every cache but its own, this one's too while it fills
  if (!failed && !(await caches.has(CACHE))) failed = lastingError('its cache was deleted while it installed');
  if (failed) {
    await caches.delete(CACHE);
    console.error(`Blundr ${VERSION} not kept for offline use:`, failed.message || failed);
    if (lasting(failed)) await told(failed);
    throw failed;
  }
  await caches.delete(FAILED);
}

/** The pages told that this build couldn't be kept (web/shim.js offers a fresh start when theirs is older). */
async function told(e) {
  const note = { type: 'blundr-update-failed', version: VERSION, reason: String(e.message || e) };
  try {
    await (await caches.open(FAILED)).put(urlOf('update-failed'), new Response(JSON.stringify(note)));
  } catch (err) { /* storage full: the open pages still hear of it */ }
  for (const c of await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })) c.postMessage(note);
}

self.addEventListener('install', e => e.waitUntil(install()));

// The page's "Reload": this build takes over now (every open tab then reloads: web/shim.js)
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const n of await caches.keys()) if (n.startsWith(PREFIX) && n !== CACHE) await caches.delete(n);
})()));

/** The page: from the network if it answers within PAGE_WAIT_MS with this build's, else this build's kept one. A newer
 * build on the network isn't shown with this one's files: it installs (registration.update) and the page offers to
 * reload into it. */
async function page(req) {
  const cache = await caches.open(CACHE);
  const own = await cache.match(urlOf(''));
  if (!own) return fetch(req);      // nothing kept (storage cleared): the network as without this
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PAGE_WAIT_MS);
  try {
    const res = await fetch(req, { signal: ctl.signal });
    const text = res.ok && !res.redirected ? await res.clone().text() : null;
    clearTimeout(timer);
    if (text !== null && pageVersion(text) === VERSION) return res;
    if (text !== null) self.registration.update().catch(() => {});
  } catch (e) {
    clearTimeout(timer);    // offline, or too slow
  }
  return own;
}

/** A kept file, as a range of it when one is asked for (an <audio> element asks for ranges). */
async function file(req, rel) {
  const r = await (await caches.open(CACHE)).match(urlOf(rel));
  if (!r) return fetch(req);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') || '');
  if (!range) return r;
  const buf = await r.arrayBuffer(), size = buf.byteLength;
  let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  let end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const headers = new Headers(r.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(buf.slice(start, end + 1), { status: 206, headers });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const rel = relOf(req.url);
  if (rel === null) return;
  if (req.mode === 'navigate') {
    if (rel === '' || rel === 'index.html') e.respondWith(page(req));
    return;
  }
  if (rel !== '' && rel in FILES) e.respondWith(file(req, rel));
});
