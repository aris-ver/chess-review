// The desktop app's HTTP server on 127.0.0.1, which the window loads. It serves the page (chess_review/static) the way
// serve.Handler does and hands everything else to `api`: until js/server exists (docs/js-port.md, round 3) that is
// a placeholder that answers 503, so the page loads and says what it can't do yet.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

/** What answers api/…, account/… and p/… until js/server's handle(method, path, body) takes over. */
export async function placeholder(method, path) {
  const body = JSON.stringify({ error: `Not in this build yet: ${method} ${path} needs the JS server (docs/js-port.md, round 3).` });
  return { status: 503, headers: { 'Content-Type': 'application/json' }, body };
}

const DYNAMIC = /^\/(api|account|p)\//;

/** index.html as site.write_static writes it: the board's pieces (python-chess's chess.svg.PIECES, kept in
 * pieces.json) in place of its placeholder. */
export function indexHtml(staticDir) {
  const pieces = JSON.parse(readFileSync(new URL('./pieces.json', import.meta.url), 'utf8'));
  return readFileSync(join(staticDir, 'index.html'), 'utf8').replace('/*__PIECES__*/', JSON.stringify(pieces));
}

/** An http.Server for the page in `staticDir`; requests to api/, account/ and p/ go to `api`. */
export function makeServer({ staticDir, api = placeholder, log }) {
  const index = indexHtml(staticDir);
  const root = normalize(staticDir + sep);
  return createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      // themes (pieces, boards, sounds) may be cached and revalidated; everything else is fetched fresh (serve.py)
      const cache = path.startsWith('/themes/') ? 'no-cache' : 'no-store';
      let out;
      if (DYNAMIC.test(path)) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        out = await api(req.method, req.url, Buffer.concat(chunks), req.headers);
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        out = { status: 405, headers: {}, body: '' };
      } else if (path === '/' || path === '/index.html') {
        out = { status: 200, headers: { 'Content-Type': TYPES['.html'] }, body: index };
      } else {
        const file = normalize(join(staticDir, path));
        if (!file.startsWith(root)) out = { status: 404, headers: {}, body: 'not found' };
        else {
          try {
            out = { status: 200, headers: { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' }, body: await readFile(file) };
          } catch {
            out = { status: 404, headers: { 'Content-Type': TYPES['.txt'] }, body: 'not found' };
          }
        }
      }
      const body = typeof out.body === 'string' ? Buffer.from(out.body) : out.body ?? Buffer.alloc(0);
      res.writeHead(out.status, { 'Cache-Control': cache, 'Content-Length': body.length, ...out.headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      log?.error(`${req.method} ${req.url} failed`, err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  });
}

/** Listen on host:preferred, or on any free port if that one is taken (a second copy of the app, or something else
 * on 8123), as the launcher's _free_port does. Resolves to the port. */
export function listen(server, host, preferred) {
  const attempt = port => new Promise((resolve, reject) => {
    const fail = err => { server.off('listening', ok); reject(err); };
    const ok = () => { server.off('error', fail); resolve(server.address().port); };
    server.once('error', fail).once('listening', ok).listen(port, host);
  });
  return attempt(preferred).catch(err => {
    if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
    return attempt(0);
  });
}
