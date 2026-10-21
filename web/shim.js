// Loaded first by the web build of index.html (scripts/build_web.py adds the tag). The page asks for api/... and
// p/<id>/... as it does from the desktop server; here those go to the Python worker, which answers them with the
// desktop's own serve.Handler. Everything else (themes, sounds) is a static file and goes to the network.
(() => {
  const base = new URL('.', location.href).pathname;
  const worker = new Worker('web/py-worker.js', { type: 'module' });
  const pending = new Map();
  let seq = 0;
  const realFetch = window.fetch.bind(window);

  // The loading bar: Python first (the page waits for it), then the 99 MB engine in the background.
  const bar = document.createElement('div');
  bar.id = 'web-loading';
  bar.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;max-width:min(420px,calc(100vw - 24px));padding:8px 12px;' +
    'border-radius:8px;background:rgba(20,20,20,.88);color:#eee;font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4)';
  const state = { python: 'Loading Python', engine: '' };
  const mb = b => (b / 1048576).toFixed(0);
  const render = () => {
    bar.innerHTML = `<div>${state.python}</div>${state.engine ? `<div>${state.engine}</div>` : ''}` +
      '<div style="opacity:.7;margin-top:4px">Analysis in the browser is about 2× slower than the ' +
      '<a style="color:#9cf" href="https://github.com/aris-ver/chess-review/releases/latest" target="_blank">Windows app</a>.</div>';
  };
  const show = () => { if (!bar.isConnected) (document.body || document.documentElement).appendChild(bar); render(); };
  let pythonReady = false, engineReady = false;
  const maybeHide = () => { if (pythonReady && engineReady) setTimeout(() => bar.remove(), 4000); };

  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'response') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      const empty = m.status === 204 || m.status === 304;
      p.resolve(new Response(empty ? null : m.body, { status: m.status, headers: m.headers }));
    } else if (m.type === 'progress') {
      if (m.what === 'python') {
        state.python = m.text;
        pythonReady = m.total > 0 && m.done === m.total;
      } else {
        engineReady = m.total > 0 && m.done >= m.total;
        state.engine = engineReady ? 'Engine ready' : `Downloading the engine: ${mb(m.done)}${m.total ? ' / ' + mb(m.total) : ''} MB`;
      }
      show();
      maybeHide();
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
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (init.signal) init.signal.addEventListener('abort', () => { pending.delete(id); reject(new DOMException('Aborted', 'AbortError')); });
      // the desktop server's paths are absolute (/api/..., /p/...)
      worker.postMessage({ id, method, path: '/' + rel + url.search, body, contentType: 'application/json' }, body ? [body.buffer] : []);
    });
  };
  document.addEventListener('DOMContentLoaded', show);
})();
