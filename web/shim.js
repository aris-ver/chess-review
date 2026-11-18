// Loaded first by the web build of index.html (scripts/build_web.js adds the tag). The page asks for api/... and
// p/<id>/... as it does from the desktop server; here those go to the app worker (js/web/worker.js), which answers
// them with the same JS server the desktop runs. Everything else (themes, sounds) is a static file and goes to the network.
(() => {
  const base = new URL('.', location.href).pathname;
  // Phones and tablets get the lite engine (js/web/worker.js says why). Every iOS browser is WebKit, the home-screen
  // app too, so this is the device, not the browser; iPadOS says it is a Mac, its touch screen gives it away.
  const nav = window.navigator || {};
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const lite = ios || /Android|Mobi/.test(nav.userAgent || '');
  // Opened from the home screen: already the app, nothing to offer
  const standalone = nav.standalone === true || !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const realFetch = window.fetch.bind(window);
  // Totals for the owner: how many visits, reviews and puzzles a day, and no more (worker/src/store.js, docs/accounts.md).
  // Only the event's name is sent, with no id, and nothing is stored here. A blocked or failed send changes nothing.
  // At most so many of a kind per page load: a long puzzle session shouldn't spend the Worker's free daily requests.
  const tallied = {};
  const tally = name => {
    tallied[name] = (tallied[name] || 0) + 1;
    if (tallied[name] > (name === 'error' ? 3 : 30)) return;
    realFetch(base + 'account/tally', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: name }) }).catch(() => {});
  };
  addEventListener('blundrusage', e => tally(e.detail));
  addEventListener('error', () => tally('error'));
  addEventListener('unhandledrejection', () => tally('error'));
  tally('visit');
  // The code's folder: v/<version>/ (scripts/build_web.js), where this file is web/shim.js. Kept by the browser for good,
  // as a version's files never change. Run some other way (no script tag: the tests), the site's own js/ and web/.
  const src = document.currentScript && document.currentScript.src;
  const code = src ? new URL('../', src).href : new URL('.', location.href).href;
  const entry = code + 'js/web/worker.js';
  // One worker per tab; the tabs' workers share one database between them (js/web/tabs.js). Its name says which engine:
  // a query would make it another URL than the one the page has already asked for (scripts/build_web.js WARM_UP).
  const worker = new Worker(entry, { type: 'module', name: lite ? 'lite' : 'full' });
  const pending = new Map();
  const streams = new Map();      // id → { ctl } of an answer still streaming
  let seq = 0;

  // The notice bar: the app loading, if the page shows before it's done (or that it failed to start), and once per
  // browser, as the engine first loads, a quiet note: that the Windows app analyses faster (on a phone, that the site
  // goes on the home screen). The engine's own download says nothing: until it's done the page's Start review is
  // greyed (html.engine-loading), and an "engineready" event lets it go.
  const bar = document.createElement('div');
  bar.id = 'web-loading';
  bar.style.cssText = 'position:fixed;z-index:9999;max-width:min(420px,calc(100vw - 24px));padding:8px 30px 8px 12px;' +
    'border-radius:8px;border-left:3px solid var(--accent);background:rgba(20,20,20,.88);color:#eee;font:13px/1.4 system-ui,sans-serif;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.4)';
  // "Download the app" in the header, lit in the notice's accent colour (no flashing) for as long as the note is
  // up, so the two read as one: the note says the browser is slower, the button is where the faster app is.
  // It downloads the zip itself: GitHub's latest-asset link follows each release, so it never needs changing.
  const DOWNLOAD = 'https://github.com/aris-ver/chess-review/releases/latest/download/Blundr-windows.zip';
  const style = document.createElement('style');
  style.textContent =
    'header .right a#web-dl{color:var(--text);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 10px;' +
    'white-space:nowrap;transition:border-color .6s,color .6s,box-shadow .6s}' +
    '@media (hover:hover){header .right a#web-dl:hover{background:#46423d;border-color:var(--accent)}}' +
    'header .right a#web-dl.lit{border-color:var(--accent);color:var(--accent);box-shadow:0 0 8px 1px color-mix(in srgb,var(--accent) 40%,transparent)}' +
    '#web-loading .x,#web-a2hs .x{position:absolute;top:4px;right:4px;width:22px;height:22px;padding:0;border:0;border-radius:4px;background:none;' +
    'color:#aaa;font:16px/22px system-ui,sans-serif;cursor:pointer}@media (hover:hover){#web-loading .x:hover,#web-a2hs .x:hover{background:rgba(255,255,255,.1);color:#fff}}' +
    'header .right a#web-dl svg,#web-a2hs svg{width:16px;height:16px;vertical-align:-3px;fill:none;stroke:currentColor;stroke-width:2;' +
    'stroke-linecap:round;stroke-linejoin:round}' +
    '#web-a2hs{position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-end;justify-content:center;padding:16px;' +
    'padding-bottom:calc(16px + env(safe-area-inset-bottom));background:rgba(0,0,0,.5)}' +
    '#web-a2hs>div{position:relative;width:min(420px,100%);padding:16px 36px 16px 16px;border-radius:10px;border-left:3px solid var(--accent);' +
    'background:var(--panel2);color:var(--text);font:15px/1.5 system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.5)}' +
    '#web-a2hs b{color:var(--accent)}#web-a2hs ol{margin:8px 0 0;padding-left:20px}#web-a2hs .x{top:8px;right:8px;color:var(--text)}' +
    // Clear of the iPhone's home indicator; on a phone also of the board screens' nav pinned to the bottom (and of the
    // puzzle build's bar under it). A phone on its side has that nav in the panel, so there the bar goes under the header.
    '#web-loading{left:max(12px,env(safe-area-inset-left));bottom:calc(12px + env(safe-area-inset-bottom))}' +
    '@media (max-width:900px){#web-loading .x{width:36px;height:36px;top:0;right:0}#web-a2hs .x{width:36px;height:36px;top:2px;right:2px}#web-loading{padding-right:40px!important}' +
    'body.hasbar #web-loading{bottom:calc(72px + env(safe-area-inset-bottom))}' +
    'body:has(#review:not(.hidden)) #web-loading{bottom:calc(76px + env(safe-area-inset-bottom))}' +
    'body.hasbar:has(#review:not(.hidden)) #web-loading{bottom:calc(138px + env(safe-area-inset-bottom))}' +
    // over the page's Start review, pinned above that nav
    'body:has(#review:not(.hidden) .panel[data-tab="overview"] .ovfoot:not(.used)) #web-loading{bottom:calc(136px + env(safe-area-inset-bottom))}' +
    'body.hasbar:has(#review:not(.hidden) .panel[data-tab="overview"] .ovfoot:not(.used)) #web-loading{bottom:calc(198px + env(safe-area-inset-bottom))}' +
    // ...one row higher with Fast | Full (or the full re-analysis offer) under it
    'body:has(#review:not(.hidden) .panel[data-tab="overview"] .ovfoot:not(.used) :is(.ovmode,.ovdeeper)) #web-loading{bottom:calc(170px + env(safe-area-inset-bottom))}' +
    'body.hasbar:has(#review:not(.hidden) .panel[data-tab="overview"] .ovfoot:not(.used) :is(.ovmode,.ovdeeper)) #web-loading{bottom:calc(232px + env(safe-area-inset-bottom))}}' +
    '@media (max-width:900px) and (orientation:landscape) and (max-height:500px){body:has(#review:not(.hidden)) #web-loading' +
    '{top:calc(64px + env(safe-area-inset-top));bottom:auto!important;left:auto;right:max(12px,env(safe-area-inset-right));max-width:min(420px,45vw)}}';
  document.head.appendChild(style);
  // Drawn, not ⬇: iOS shows that as a colour emoji. An arrow into a tray, on phones too (white there: the app to get).
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON_DL = svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>');
  const ICON_SHARE = svg('<path d="M12 3v12M8 7l4-4 4 4M7 11H5v10h14V11h-2"/>');
  const dl = document.createElement('a');
  // Phones and tablets: the Windows app is no use there; the button puts the site on the home screen instead, where
  // it opens full screen like an app. Android's browsers can do that themselves (beforeinstallprompt); iOS's can't
  // be asked to, so the button says where the Share menu's "Add to Home Screen" is.
  if (lite) {
    Object.assign(dl, { id: 'web-dl', href: '#', title: 'Add Blundr to your home screen' });
    dl.innerHTML = `<span class="i" style="color:#fff">${ICON_DL}</span><span class="t"> Get the app</span>`;
  } else {
    Object.assign(dl, { id: 'web-dl', href: DOWNLOAD, title: 'Download the Windows app: it analyses about 2× faster' });
    dl.innerHTML = `<span class="i">${ICON_DL}</span><span class="t"> Download the app</span>`;
  }
  let installPrompt = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
  addEventListener('appinstalled', () => { installPrompt = null; dl.remove(); });
  const howTo = () => {
    const ua = nav.userAgent || '';
    const share = `<b>Share</b> ${ICON_SHARE}`;
    const where = !ios ? null
      : /CriOS/.test(ua) ? `Tap ${share} at the right of the address bar.`
      : /FxiOS|EdgiOS|OPiOS/.test(ua) ? `Open the menu and tap ${share}.`
      : `Tap ${share} in the toolbar (at the bottom, or at the top on iPad).`;
    const steps = where ? [where, 'Scroll down and tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>.']
      : ['Open the browser menu <b>⋮</b>.', 'Tap <b>Add to Home screen</b> or <b>Install app</b>.'];
    const sheet = document.createElement('div');
    sheet.id = 'web-a2hs';
    sheet.innerHTML = '<div><button class="x" title="Close" aria-label="Close">×</button>' +
      '<div>Put Blundr on your home screen: it opens full screen, like an app, and keeps your reviews.</div>' +
      `<ol>${steps.map(t => `<li>${t}</li>`).join('')}</ol></div>`;
    sheet.onclick = e => { if (e.target === sheet || e.target.closest('.x')) sheet.remove(); };
    document.body.appendChild(sheet);
  };
  const addToHome = async e => {
    if (e) e.preventDefault();
    if (installPrompt) {
      const p = installPrompt;
      installPrompt = null;
      await p.prompt();
      return;
    }
    howTo();
  };
  if (lite) dl.onclick = addToHome;
  // A download leaves the page as it is, so say what just happened and what to do with the zip
  const downloading = () => { if (window.toast) toast('Downloading Blundr for Windows… unzip it and run Blundr.exe', 8000); };
  if (!lite) dl.onclick = downloading;
  // The note, once per browser (the keys of earlier builds, whose notes came every visit until dismissed, count too)
  const NOTE_OFF = lite ? 'webHomeScreenNoteShown' : 'webSpeedNoteDismissed';
  const NOTE_S = 12;
  let noteOff = lite && standalone, noteUp = false, noteT = null, closed = false;
  try { noteOff = noteOff || localStorage.getItem(NOTE_OFF) === '1'; } catch (e) {}
  const state = { app: 'Loading Blundr' };
  let appReady = false, engineReady = false;
  // offline.js, below: 'ready' (a new build kept and waiting) or 'failed' (a newer build couldn't be kept), and what
  // the bar's Reload does then
  let updateUp = '', reloadNow = () => location.reload();
  document.documentElement.classList.add('engine-loading');
  const render = () => {
    const loading = appReady ? '' : `<div>${state.app}</div>`;
    const note = !noteUp ? '' : lite
      ? `<div style="opacity:.85${loading ? ';margin-top:4px' : ''}">Blundr works as an app: ` +
        `<a class="a2hs" style="color:var(--accent)" href="#">add it to your home screen</a>.</div>`
      : `<div style="opacity:.75${loading ? ';margin-top:4px' : ''}">Analysis runs faster in the ` +
        `<a class="dl" style="color:var(--accent)" href="${DOWNLOAD}">Windows app</a>.</div>`;
    const upd = !updateUp ? '' : `<div${loading || note ? ' style="margin-top:4px"' : ''}>` +
      (updateUp === 'ready' ? 'A new version of Blundr is ready. ' : "Couldn't update Blundr. ") +
      `<a class="upd${updateUp === 'failed' ? ' fix' : ''}" style="color:var(--accent)" href="#">Reload</a></div>`;
    bar.innerHTML = '<button class="x" title="Dismiss" aria-label="Dismiss">×</button>' + loading + note + upd;
    const a2hs = bar.querySelector('.a2hs');
    if (a2hs) a2hs.onclick = addToHome;
    const get = bar.querySelector('.dl');
    if (get) get.onclick = downloading;
    const reload = bar.querySelector('.upd');
    if (reload) reload.onclick = e => { e.preventDefault(); reloadNow(); };
    bar.querySelector('.x').onclick = () => {
      closed = true;
      noteUp = false;
      clearTimeout(noteT);
      bar.remove();
      dl.classList.remove('lit');
    };
    return loading || note || upd;
  };
  // The engine loaded for the first time in this browser: the note, for NOTE_S seconds once the page shows, then never again
  const showNote = () => {
    if (noteOff) return;
    noteOff = noteUp = true;
    try { localStorage.setItem(NOTE_OFF, '1'); } catch (e) {}
  };
  // Up while the app loads (or failed to) and while the note is; gone otherwise.
  const update = () => {
    if (!document.body) return;
    const right = document.querySelector('header .right');
    if (right && !dl.isConnected && !(lite && standalone)) right.prepend(dl);
    dl.classList.toggle('lit', noteUp);
    // While the page's splash (#boot) is up, the loading line is on it; the bar comes in as the page shows, not before
    const boot = document.getElementById('boot');
    if (boot && !document.documentElement.classList.contains('booted')) {
      boot.querySelector('.st').innerHTML = appReady ? '' : state.app;
      return;
    }
    if (noteUp && !noteT) noteT = setTimeout(() => { noteUp = false; update(); }, NOTE_S * 1000);
    if (closed || !render()) { bar.remove(); return; }
    if (!bar.isConnected) document.body.appendChild(bar);
  };
  addEventListener('blundrshown', update);

  // Answers from the last visit, handed back at once while the app loads: the home screen's
  // (profiles, puzzle tiles, the updater's "nothing to update here", which the page waits on before it shows) and a profile's: its games.json, which of them are new, and each game's review, so those
  // open straight away too. The request still goes to the worker; when its answer differs from the one
  // shown, or is gone (a deleted profile), the screen is drawn again. Only answers the server gave are kept: no logic is
  // copied here. Not the puzzles themselves, which change with the date or at random. In Cache Storage, as games.json
  // is 150 KB a profile.
  const KEEP = /^(api\/(update|profiles(\/[^/]+\/unseen)?|puzzles\/(packs|themes|sources))|p\/[^/]+\/games(\.json|\/[^/]+\.json))$/;
  const store = (self.caches ? caches.open('blundr-kept') : Promise.reject()).catch(() => null);   // none: every visit waits
  const keyOf = rel => location.origin + base + rel;
  try {     // where earlier builds kept the home screen's
    for (const k of Object.keys(localStorage)) if (k.startsWith('webKept:')) localStorage.removeItem(k);
  } catch (e) {}
  const kept = async rel => {
    try {
      const r = await (await store).match(keyOf(rel));
      return r ? { text: await r.text(), type: r.headers.get('Content-Type') } : null;
    } catch (e) { return null; }
  };
  // The browser holds someone else's data now (a log in, a log out, a deleted account: js/server/sync.js switch()
  // and release()): what was kept is the last owner's, so it goes, and answers asked for before that aren't kept.
  let owners = 0;
  const forget = async body => {
    let r;
    try { r = JSON.parse(new TextDecoder().decode(body)); } catch (e) { return; }
    if (!r || !(r.switched || r.released)) return;
    owners++;
    try {
      const c = await store;
      for (const k of await c.keys()) await c.delete(k);
    } catch (e) { /* blocked: nothing was kept */ }
  };
  // What's kept stays small: the reviews of the last KEPT_REVIEWS games opened (Cache Storage lists its entries in the
  // order they were put, and each answer is put again, so the first listed are the longest unopened), and nothing of
  // a profile the home screen no longer lists. Without this, every game ever opened would stay on the device.
  const KEPT_REVIEWS = 30;
  const REVIEW = /^p\/[^/]+\/games\/[^/]+\.json$/;
  const trim = async (c, rel, text) => {
    const rels = (await c.keys()).map(k => (typeof k === 'string' ? k : k.url).slice(keyOf('').length));
    let gone = [];
    if (REVIEW.test(rel)) gone = rels.filter(r => REVIEW.test(r)).slice(0, -KEPT_REVIEWS);
    else if (rel === 'api/profiles') {
      let list;
      try { list = JSON.parse(text); } catch (e) { return; }
      list = Array.isArray(list) ? list : list && list.profiles;
      if (!Array.isArray(list)) return;
      const ids = new Set(list.map(p => p && p.id));
      gone = rels.filter(r => /^p\/([^/]+)\//.test(r) && !ids.has(decodeURIComponent(/^p\/([^/]+)\//.exec(r)[1])));
    }
    for (const r of gone) await c.delete(keyOf(r));
  };
  let redrawT = null;
  const keep = async (rel, m, shown, hash, owner) => {
    const text = m.status === 200 ? new TextDecoder().decode(m.body) : null;
    try {
      const c = await store;
      if (owner !== owners) return;
      if (text == null) await c.delete(keyOf(rel));
      else await c.put(keyOf(rel), new Response(text, { headers: m.headers.filter(([k]) => /^content-type$/i.test(k)) }));
      if (text != null) await trim(c, rel, text);
    } catch (e) { /* full or blocked: next visit waits */ }
    if (shown == null || shown.text === text || location.hash !== hash) return;
    clearTimeout(redrawT);      // the home screen asks for several at once: draw it again once
    redrawT = setTimeout(() => { if (location.hash === hash) dispatchEvent(new HashChangeEvent('hashchange')); }, 100);
  };

  // A worker that doesn't start (its code failed to load, or the browser can't run it) sends nothing at all: say so
  // instead of "Loading" for good.
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let heard = false;
  const failed = why => {
    if (appReady) return;
    state.app = `Blundr failed to start: ${esc(why)}. Reload the page; if it keeps happening, update the browser.`;
    update();
  };
  // The browser gives no reason when a module worker's code doesn't load: find the file that didn't (blocked by an
  // extension or an antivirus' web shield, say) by walking the worker's imports, and name the browser.
  const browser = () => {
    const b = (nav.userAgentData && nav.userAgentData.brands || []).find(x => !/not.?a.?brand|chromium/i.test(x.brand));
    if (b) return `${b.brand} ${b.version}`;
    const m = /(Firefox|Edg|Chrome|Version)\/(\d+)/.exec(nav.userAgent || '');
    return m ? `${m[1] === 'Version' ? 'Safari' : m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}` : 'this browser';
  };
  const unloadable = async () => {
    const seen = new Set(), todo = [code + 'js/web/worker.js'];
    while (todo.length && seen.size < 80) {
      const url = todo.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      let text;
      try {
        const r = await realFetch(url, { cache: 'no-store' });
        if (!r.ok) return `${url.slice(location.origin.length)}: HTTP ${r.status}`;
        text = await r.text();
      } catch (err) {
        return `${url.slice(location.origin.length)} was blocked`;
      }
      for (const m of text.matchAll(/^\s*(?:import|export)\b[^'"]*?['"](\.{1,2}\/[^'"]+)['"]/gm)) todo.push(new URL(m[1], url).href);
    }
    return null;
  };
  // A page from before a deploy, whose version the site no longer has (it keeps only the latest): loaded again, once,
  // it comes with the version there is now. Whether that's why it failed: the worker's own file is gone.
  const stale = async () => {
    try {
      if ((await realFetch(entry, { cache: 'no-store' })).status !== 404) return false;
      if (sessionStorage.getItem('blundrReloaded') === code) return false;      // already tried: say it failed instead
      sessionStorage.setItem('blundrReloaded', code);
    } catch (e) {
      return false;
    }
    location.reload();
    return true;
  };
  worker.onerror = async e => {
    e.preventDefault && e.preventDefault();
    if (await stale()) return;
    if (e.message) return failed(e.message);
    failed('checking why…');
    const why = await unloadable().catch(() => null);
    failed(`${why || 'its code did not run'} (${browser()})`);
  };
  setTimeout(() => { if (!heard) failed("the app hasn't answered in 20 s"); }, 20000);

  worker.onmessage = e => {
    const m = e.data;
    heard = true;
    if (m.type === 'response') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (p.keep) keep(p.rel, m, p.shown, p.hash, p.owner);
      if (/^\/api\/sync\/(switch|release)$/.test(p.path) && m.status === 200) forget(m.body);
      if (m.stream) {     // /api/eval_stream: NDJSON lines as the engine deepens, until the page lets go
        let ctl;
        const body = new ReadableStream({
          start: c => { ctl = c; },
          cancel: () => { streams.delete(m.id); worker.postMessage({ type: 'abort', id: m.id }); },
        });
        streams.set(m.id, { ctl });
        p.resolve(new Response(body, { status: m.status, headers: m.headers }));
        return;
      }
      const empty = m.status === 204 || m.status === 304;
      p.resolve(new Response(empty ? null : m.body, { status: m.status, headers: m.headers }));
    } else if (m.type === 'chunk' || m.type === 'end') {
      const s = streams.get(m.id);
      if (!s) return;
      if (m.type === 'chunk') s.ctl.enqueue(m.body);
      else {
        streams.delete(m.id);
        s.ctl.close();
      }
    } else if (m.type === 'progress') {
      if (m.what === 'app') {
        if (m.total === 0) stale();      // failed to load: a module imported late (SQLite's) may be what is gone
        state.app = m.text;
        appReady = m.total > 0 && m.done === m.total;
      } else if (!engineReady && (m.failed || (m.total > 0 && m.done >= m.total))) {
        // loaded (or failed to: Start review then says why rather than staying grey)
        engineReady = true;
        document.documentElement.classList.remove('engine-loading');
        dispatchEvent(new Event('engineready'));
        if (!m.failed) showNote();
      }
      update();
    }
  };

  window.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), location.href);
    const rel = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
    if (url.origin !== location.origin || rel === null || !/^(api|p)\//.test(rel)) return realFetch(input, init);
    const method = (init.method || (req && req.method) || 'GET').toUpperCase();
    let body = init.body != null ? init.body : null;
    if (body != null && !(body instanceof Uint8Array)) body = new Uint8Array(await new Response(body).arrayBuffer());
    if (init.signal && init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const id = ++seq;
    const keepIt = method === 'GET' && !url.search && KEEP.test(rel);
    const hash = location.hash;
    const shown = keepIt && !appReady ? await kept(rel) : null;
    return new Promise((resolve, reject) => {
      const path = '/' + rel + url.search;     // the desktop server's paths are absolute (/api/..., /p/...)
      if (shown != null) {     // last visit's answer now; the server's, when it comes, only updates what's kept
        resolve(new Response(shown.text, { status: 200, headers: { 'Content-Type': shown.type || 'application/json' } }));
        resolve = () => {};
      }
      pending.set(id, { resolve, reject, path: '/' + rel, rel, keep: keepIt, shown, hash, owner: owners });
      if (init.signal) init.signal.addEventListener('abort', () => {
        const aborted = new DOMException('Aborted', 'AbortError');
        pending.delete(id);
        reject(aborted);
        const s = streams.get(id);
        if (s) {
          streams.delete(id);
          try { s.ctl.error(aborted); } catch (e) { /* already closed */ }
        }
        worker.postMessage({ type: 'abort', id });     // the worker stops what it was doing (an engine's search)
      });
      worker.postMessage({ id, method, path, body, contentType: 'application/json' }, body ? [body.buffer] : []);
    });
  };
  // The page reads the server's copy of its settings with a synchronous XMLHttpRequest, which the worker can't answer.
  // That copy is for the desktop, whose port (so its localStorage) may change; here localStorage is the one store, so
  // the answer is "no server copy" without asking the network (which would only say 404). Answered here, a 404 that
  // sends nothing: a data: URL would be a fetch the Content-Security-Policy stops (connect-src).
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const u = new URL(String(url), location.href);
    if (u.origin === location.origin && u.pathname === base + 'api/settings') {
      Object.defineProperties(this, { send: { value: () => {} }, status: { value: 404 }, responseText: { value: '' } });
    }
    return xhrOpen.call(this, method, url, ...rest);
  };
  // Offline: the service worker (web/offline.js, written to the site's root by scripts/build_web.js) keeps this build's
  // files, so the app opens and works with no network once it has been opened online. A build only (this file under
  // v/<version>/): the desktop app's page has no shim, and a checkout's has no offline.js. A deploy installs whole in
  // the background; the bar then offers a reload, which the page also takes by itself at its first safe moment
  // (index.html, blundrUpdateReady) when every other open tab is at one too. Every tab reloads as the new build takes
  // over, so no page runs on two builds' files.
  const sw = nav.serviceWorker;
  if (sw && window.isSecureContext && src && /\/v\/[0-9a-f]+\/web\/shim\.js$/.test(new URL(src).pathname)) {
    const had = !!sw.controller;      // this page came from a kept build: a new controller is a newer one
    let reloading = false, changed = false;
    sw.addEventListener('controllerchange', () => {
      changed = true;
      if (!had || reloading) return;
      // another tab put the new build in charge after asking this one; should this one have moved on to a drill or a
      // puzzle since, it reloads at its next safe moment instead (index.html)
      if (window.blundrSafe && !window.blundrSafe() && window.blundrUpdateReady) { window.blundrUpdateReady(); return; }
      reloading = true;
      try { sessionStorage.setItem('blundrUpdated', '1'); } catch (e) {}     // index.html says so once it's back
      location.reload();
    });
    const settled = (w, done) => new Promise(resolve => {
      const f = () => { if (done.includes(w.state)) { w.removeEventListener('statechange', f); resolve(); } };
      w.addEventListener('statechange', f);
      f();
    });
    // The other tabs, asked whether they are at a safe moment too (index.html's blundrSafe): the new build taking over
    // reloads them all, and one mid-drill can't stay on this build's files (its worker's next import may be gone). An
    // answer not in within ASK_MS (a tab frozen in the background) doesn't hold the update back.
    const CHANNEL = 'blundr-update', ASK_MS = 500;
    const others = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
    if (others) others.onmessage = async e => {
      if (e.data && e.data.ask) others.postMessage({ id: e.data.ask, safe: window.blundrSafe ? window.blundrSafe() : true });
    };
    const othersSafe = () => new Promise(resolve => {
      if (!others) return resolve(true);
      const ask = new BroadcastChannel(CHANNEL), id = Math.random().toString(36).slice(2);
      let safe = true;
      ask.onmessage = e => { if (e.data && e.data.id === id && e.data.safe === false) safe = false; };
      ask.postMessage({ ask: id });
      setTimeout(() => { ask.close(); resolve(safe); }, ASK_MS);
    });
    // Into the newer build: a plain reload would get this one's kept page again while its service worker is in charge
    // (offline.js's page()), so a newer one waiting is put in charge first. False when there is none to go to yet (none
    // on the server, offline, still installing: offer() comes once it is in) or, unless asked for (the bar's Reload),
    // another tab isn't at a safe moment: the page carries on as it is. Never waits on an install, which may take a
    // while: by then the page may be mid-drill. still(): whether it is still a safe moment (index.html), asked again
    // right before the new build takes over and right before the reload, as the steps between take a second or two.
    window.blundrReload = async (asked = false, still = () => true) => {
      let reg = null;
      try { reg = await sw.getRegistration(base); } catch (e) {}
      const plain = () => { if (!still()) return false; reloading = true; location.reload(); return true; };
      if (!reg || !reg.active || changed) return plain();
      if (!reg.installing && !reg.waiting) { try { await reg.update(); } catch (e) { return false; } }
      // asked for (a click): an install under way is waited for, then taken
      if (asked && !reg.waiting && reg.installing) await settled(reg.installing, ['installed', 'activating', 'activated', 'redundant']);
      if (changed) return plain();
      const w = reg.waiting;
      // no controller: the page came from the network, and the one active now answers the next load
      if (!w) return reg.installing || sw.controller ? false : plain();
      if (!asked && !(await othersSafe())) return false;
      if (!still()) return false;
      reloading = true;
      w.postMessage('skipWaiting');
      await settled(w, ['activated', 'redundant']);
      // the new build is in charge now (changed): the page stays stale, and its next safe moment reloads it plainly
      if (w.state === 'redundant' && !changed || !still()) { reloading = false; return false; }
      location.reload();
      return true;
    };
    const offer = reg => {
      if (!reg.waiting || !sw.controller) return;     // the first build kept replaces nothing
      reloadNow = async () => { if ((await window.blundrReload(true)) === false) location.reload(); };
      updateUp = 'ready';
      closed = false;
      update();
      if (window.blundrUpdateReady) window.blundrUpdateReady();
    };
    // A newer build couldn't be kept (storage full, a file the host doesn't serve as listed): this page's build would
    // stay, deploy after deploy, with only the console saying so. Reload then starts afresh: no service worker, none
    // of the builds' caches (the engines' and the kept answers stay), the site from the network, which keeps itself
    // again as it loads. Only with the site answering: offline, the kept build is all there is to open.
    // the site answers (the service worker lets this through to the network): navigator.onLine alone can't tell, as a
    // phone on a Wi-Fi with no internet is "online"
    const siteUp = async () => {
      if (nav.onLine === false) return false;
      try { return (await realFetch(base, { method: 'HEAD', cache: 'no-store' })).ok; } catch (e) { return false; }
    };
    const fresh = async () => {
      if (!(await siteUp())) {
        if (window.toast) toast("Updating Blundr needs the internet. It still works offline as it is.", 6000);
        return;
      }
      try { for (const r of await sw.getRegistrations()) await r.unregister(); } catch (e) {}
      try { for (const k of await caches.keys()) if (k.startsWith('blundr-offline-')) await caches.delete(k); } catch (e) {}
      location.reload();
    };
    const failedOffer = async note => {
      const mine = (document.querySelector('meta[name=blundr-offline]') || {}).content;
      if (!note || note.type !== 'blundr-update-failed' || !sw.controller || note.version === mine || updateUp) return;
      if (!(await siteUp())) return;      // offline there's nothing to update to: the kept build opens as it is
      if (updateUp) return;
      console.warn(`Blundr ${note.version} couldn't be kept for offline use: ${note.reason}`);
      reloadNow = fresh;
      updateUp = 'failed';
      closed = false;
      update();
    };
    sw.addEventListener('message', e => failedOffer(e.data));
    if (sw.startMessages) sw.startMessages();
    const tracked = new WeakSet();
    const track = (reg, w) => {
      if (!w || tracked.has(w)) return;
      tracked.add(w);
      w.addEventListener('statechange', () => {
        if (w.state === 'installed') offer(reg);
        // the home-screen app's first launch: from now on it opens with no network
        else if (w.state === 'activated' && !had && standalone && window.toast) toast('Blundr now works offline too', 5000);
      });
    };
    addEventListener('load', () => {
      sw.register(base + 'offline.js', { scope: base, updateViaCache: 'none' }).then(async reg => {
        try {     // an install that failed before this page was there to hear it
          const r = (await caches.has('blundr-offline-failed'))     // (open() would make an empty one)
            && await (await caches.open('blundr-offline-failed')).match(new URL('update-failed', reg.scope).href);
          if (r && !reg.waiting && !reg.installing) failedOffer(await r.json());
        } catch (e) {}
        offer(reg);
        track(reg, reg.installing);
        reg.addEventListener('updatefound', () => track(reg, reg.installing));
        // an app on a phone's home screen comes back from the background without a navigation: ask then too
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      }).catch(e => console.warn('Blundr is not kept for offline use:', e));
    });
  }
  document.addEventListener('DOMContentLoaded', update);
  addEventListener('blundrshown', update);
})();
