// The desktop server without Electron: the page with its pieces, the static files, the placeholder for api/…, the
// port fallback, and the data folder and engine paths config.py would pick.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ROOT, STATIC_DIR, dataDir, stockfishPath } from './paths.js';
import { listen, makeServer } from './server.js';

const HOST = '127.0.0.1';
let server, base;

before(async () => {
  server = makeServer({ staticDir: STATIC_DIR });
  base = `http://${HOST}:${await listen(server, HOST, 0)}`;
});
after(() => server.close());

test('server: / is index.html with the pieces filled in', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.ok(!html.includes('/*__PIECES__*/'));
  assert.match(html, /const PIECES = \{"b": ?"<g id=\\"black-bishop\\"/);
});

test('server: static files, themes cacheable, nothing outside the folder', async () => {
  const js = await fetch(base + '/account.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  const theme = await fetch(base + '/themes/');
  assert.equal(theme.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(base + '/nope.txt')).status, 404);
  assert.equal((await fetch(base + '/..%2f..%2fpackage.json')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});

test('server: api/, account/ and p/ answer the placeholder until js/server exists', async () => {
  for (const [method, path] of [['GET', '/api/profiles'], ['POST', '/api/p/x/refresh'], ['GET', '/account/me'], ['GET', '/p/x/games.json']]) {
    const res = await fetch(base + path, { method, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 503, path);
    assert.match((await res.json()).error, /JS server/);
  }
});

test('server: a custom api gets method, url and body', async () => {
  const s = makeServer({ staticDir: STATIC_DIR, api: async (method, url, body) =>
    ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, url, body: body.toString() }) }) });
  const port = await listen(s, HOST, 0);
  try {
    const res = await fetch(`http://${HOST}:${port}/api/stop?x=1`, { method: 'POST', body: 'hi' });
    assert.deepEqual(await res.json(), { method: 'POST', url: '/api/stop?x=1', body: 'hi' });
  } finally {
    s.close();
  }
});

test('server: a taken port falls back to a free one', async () => {
  const taken = createServer();
  await new Promise(r => taken.listen(0, HOST, r));
  const busy = taken.address().port;
  const s = makeServer({ staticDir: STATIC_DIR });
  try {
    const port = await listen(s, HOST, busy);
    assert.notEqual(port, busy);
    assert.equal((await fetch(`http://${HOST}:${port}/`)).status, 200);
  } finally {
    s.close();
    taken.close();
  }
});

test('paths: the data folder and Stockfish where config.py puts them', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  assert.equal(dataDir({ packaged: true, env, platform: 'win32' }), join(env.LOCALAPPDATA, 'chess-review'));
  assert.equal(dataDir({ packaged: true, env: {}, platform: 'linux', home: '/home/a' }), join('/home/a', '.local', 'share', 'chess-review'));
  assert.equal(dataDir({ packaged: true, env: { XDG_DATA_HOME: '/x' }, platform: 'linux' }), join('/x', 'chess-review'));
  assert.equal(dataDir({ packaged: false, env: {} }), join(ROOT, 'data'));
  assert.equal(dataDir({ packaged: true, env: { CHESS_REVIEW_DATA: '/d' } }), '/d');
  assert.equal(stockfishPath({ packaged: true, resources: 'R', env: {}, platform: 'win32' }), join('R', 'bin', 'stockfish.exe'));
  assert.equal(stockfishPath({ packaged: false, env: {}, platform: 'linux' }), join(ROOT, 'bin', 'stockfish'));
  assert.equal(stockfishPath({ packaged: false, env: { STOCKFISH: '/sf' } }), '/sf');
});
