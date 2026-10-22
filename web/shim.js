// Loaded first by the web build of index.html (scripts/build_web.py adds the tag). The page asks for api/... and
// p/<id>/... as it does from the desktop server; here those go to the Python worker, which answers them with the
// desktop's own serve.Handler. Everything else (themes, sounds) is a static file and goes to the network.
(() => {
  const base = new URL('.', location.href).pathname;
  // Phones and tablets get the lite engine (web/py-worker.js says why). Every iOS browser is WebKit, the home-screen
  // app too, so this is the device, not the browser; iPadOS says it is a Mac, its touch screen gives it away.
  const nav = window.navigator || {};
  const lite = /iPhone|iPad|iPod|Android|Mobi/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const worker = new Worker('web/py-worker.js' + (lite ? '?lite' : ''), { type: 'module' });
  const pending = new Map();
  let seq = 0;
  const realFetch = window.fetch.bind(window);

  // The notice bar: Python loading first (the page waits for it), then the engine (95 MB, 2 MB on phones) with a progress bar, and the
  // note that the desktop app analyses faster. The note stays up while a game is being analysed or waits to be.
  // Its × closes the bar for this visit and drops the note (and the lit button) for good: later visits still show
  // the loading lines, as those say why the page isn't answering yet.
  const bar = document.createElement('div');
  bar.id = 'web-loading';
  bar.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;max-width:min(420px,calc(100vw - 24px));padding:8px 30px 8px 12px;' +
    'border-radius:8px;border-left:3px solid var(--accent);background:rgba(20,20,20,.88);color:#eee;font:13px/1.4 system-ui,sans-serif;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.4)';
  // "Download the app" in the header, lit in the notice's accent colour (no flashing) for as long as the note is
  // up, so the two read as one: the note says the browser is slower, the button is where the faster app is.
  const DOWNLOAD = 'https://github.com/aris-ver/chess-review/releases/latest';
  const style = document.createElement('style');
  style.textContent =
    'header .right a#web-dl{color:var(--text);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 10px;' +
    'white-space:nowrap;transition:border-color .6s,color .6s,box-shadow .6s}' +
    'header .right a#web-dl:hover{background:#46423d;border-color:var(--accent)}' +
    'header .right a#web-dl.lit{border-color:var(--accent);color:var(--accent);box-shadow:0 0 8px 1px color-mix(in srgb,var(--accent) 40%,transparent)}' +
    '#web-loading .x{position:absolute;top:4px;right:4px;width:22px;height:22px;padding:0;border:0;border-radius:4px;background:none;' +
    'color:#aaa;font:16px/22px system-ui,sans-serif;cursor:pointer}#web-loading .x:hover{background:rgba(255,255,255,.1);color:#fff}' +
    '#web-loading .pb{height:4px;margin:4px 0 2px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden}' +
    '#web-loading .pb>i{display:block;height:100%;background:var(--accent);transition:width .3s}';
  document.head.appendChild(style);
  const dl = document.createElement('a');
  Object.assign(dl, { id: 'web-dl', href: DOWNLOAD, target: '_blank', rel: 'noopener', title: 'The Windows app analyses about 2× faster' });
  dl.innerHTML = '<span class="i">⬇</span><span class="t"> Download the app</span>';
  const NOTE_OFF = 'webSpeedNoteDismissed';
  let noteOff = false, closed = false;
  try { noteOff = localStorage.getItem(NOTE_OFF) === '1'; } catch (e) {}
  const state = { python: 'Loading Python', engine: null };    // engine: { done, total, name } once it starts
  const mb = b => (b / 1048576).toFixed(0);
  let pythonReady = false, engineReady = false, analysing = false, hideT = null;
  const render = () => {
    let loading = pythonReady ? '' : `<div>${state.python}</div>`;
    // the engine by name and version ("Stockfish 19"), so a 95 MB download says what it is
    if (engineReady) { if (!analysing) loading += `<div>${state.engine.name} ready</div>`; }   // old news by then
    else if (state.engine) {
      const { done, total, name } = state.engine;
      loading += `<div>Downloading ${name}, the chess engine: ${mb(done)}${total ? ' / ' + mb(total) : ''} MB</div>` +
        (total ? `<div class="pb"><i style="width:${Math.min(100, done / total * 100).toFixed(1)}%"></i></div>` : '');
    }
    const note = noteOff ? '' : `<div style="opacity:.7${loading ? ';margin-top:4px' : ''}">Analysis in the browser is about 2× slower than the ` +
      `<a style="color:var(--accent)" href="${DOWNLOAD}" target="_blank" rel="noopener">Windows app</a>.</div>`;
    bar.innerHTML = '<button class="x" title="Dismiss" aria-label="Dismiss">×</button>' + loading + note;
    bar.querySelector('.x').onclick = () => {
      closed = noteOff = true;
      try { localStorage.setItem(NOTE_OFF, '1'); } catch (e) {}
      clearTimeout(hideT);
      bar.remove();
      dl.classList.remove('lit');
    };
    return loading || note;
  };
  // Up while loading or analysing; gone 4 s after both are over. Nothing left to say (the note dismissed): gone now.
  const update = () => {
    clearTimeout(hideT);
    if (!document.body) return;
    const right = document.querySelector('header .right');
    if (right && !dl.isConnected) right.prepend(dl);
    dl.classList.toggle('lit', !noteOff);
    if (closed || !render()) { bar.remove(); return; }
    if (!bar.isConnected) document.body.appendChild(bar);
    if (pythonReady && engineReady && !analysing) hideT = setTimeout(() => { bar.remove(); dl.classList.remove('lit'); }, 4000);
  };
  // The page polls api/status while a game is analysed (or queued): read the answer on its way back.
  const ANALYSING = ['analyse', 'analyse_all', 'build'];
  const watchStatus = body => {
    let s;
    try { s = JSON.parse(new TextDecoder().decode(body)); } catch (e) { return; }
    const busy = j => j && ANALYSING.includes(j.kind) && ['queued', 'running', 'finishing'].includes(j.status);
    const now = busy(s.job) || (s.queue || []).some(busy);
    if (now !== analysing) { analysing = now; update(); }
  };

  // Answers from the last visit, handed back at once while Python loads (about 4 s on a reload): the home screen's
  // (profiles, puzzle tiles) and a profile's: its games.json, which of them are new, and each game's review, so those
  // open straight away too. The request still goes to Python; when its answer differs from the one
  // shown, or is gone (a deleted profile), the screen is drawn again. Only answers Python gave are kept: no logic is
  // copied here. Not the puzzles themselves, which change with the date or at random. In Cache Storage, as games.json
  // is 150 KB a profile.
  const KEEP = /^(api\/(profiles(\/[^/]+\/unseen)?|puzzles\/(packs|themes|sources))|p\/[^/]+\/games(\.json|\/[^/]+\.json))$/;
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
  // The browser holds someone else's data now (a log in, a log out, a deleted account: chess_review/sync.py switch()
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
  let redrawT = null;
  const keep = async (rel, m, shown, hash, owner) => {
    const text = m.status === 200 ? new TextDecoder().decode(m.body) : null;
    try {
      const c = await store;
      if (owner !== owners) return;
      if (text == null) await c.delete(keyOf(rel));
      else await c.put(keyOf(rel), new Response(text, { headers: m.headers.filter(([k]) => /^content-type$/i.test(k)) }));
    } catch (e) { /* full or blocked: next visit waits */ }
    if (shown == null || shown.text === text || location.hash !== hash) return;
    clearTimeout(redrawT);      // the home screen asks for several at once: draw it again once
    redrawT = setTimeout(() => { if (location.hash === hash) dispatchEvent(new HashChangeEvent('hashchange')); }, 100);
  };

  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'response') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (p.path === '/api/status' && m.status === 200) watchStatus(m.body);
      if (p.keep) keep(p.rel, m, p.shown, p.hash, p.owner);
      if (/^\/api\/sync\/(switch|release)$/.test(p.path) && m.status === 200) forget(m.body);
      const empty = m.status === 204 || m.status === 304;
      p.resolve(new Response(empty ? null : m.body, { status: m.status, headers: m.headers }));
    } else if (m.type === 'progress') {
      if (m.what === 'python') {
        state.python = m.text;
        pythonReady = m.total > 0 && m.done === m.total;
      } else {
        engineReady = m.total > 0 && m.done >= m.total;
        state.engine = { done: m.done, total: m.total, name: m.text };
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
    const shown = keepIt && !pythonReady ? await kept(rel) : null;
    return new Promise((resolve, reject) => {
      const path = '/' + rel + url.search;     // the desktop server's paths are absolute (/api/..., /p/...)
      if (shown != null) {     // last visit's answer now; Python's, when it comes, only updates what's kept
        resolve(new Response(shown.text, { status: 200, headers: { 'Content-Type': shown.type || 'application/json' } }));
        resolve = () => {};
      }
      pending.set(id, { resolve, reject, path: '/' + rel, rel, keep: keepIt, shown, hash, owner: owners });
      if (init.signal) init.signal.addEventListener('abort', () => { pending.delete(id); reject(new DOMException('Aborted', 'AbortError')); });
      worker.postMessage({ id, method, path, body, contentType: 'application/json' }, body ? [body.buffer] : []);
    });
  };
  // The page reads the server's copy of its settings with a synchronous XMLHttpRequest, which the worker can't answer.
  // That copy is for the desktop, whose port (so its localStorage) may change; here localStorage is the one store, so
  // the answer is "no server copy" without asking the network (which would only say 404).
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const u = new URL(String(url), location.href);
    if (u.origin === location.origin && u.pathname === base + 'api/settings') url = 'data:application/json,null';
    return xhrOpen.call(this, method, url, ...rest);
  };
  document.addEventListener('DOMContentLoaded', update);
})();
