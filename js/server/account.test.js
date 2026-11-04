// account.js beyond the route dump: the PKCE challenge is the verifier's SHA-256 (the dump can only say both are
// there), and a token kept for another site doesn't count.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { Account, TOKEN_FILE } from './account.js';
import { memoryFiles } from './profiles-files.js';

test('account: the sign-in sends the verifier whose SHA-256 it sent as the challenge', async () => {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push(JSON.parse(new TextDecoder().decode(init.body)));
    return Response.json(url.endsWith('/start') ? { url: '/account/app/go?resume=S' } : { token: 'T' });
  };
  const files = memoryFiles();
  const opened = [];
  const a = new Account({ fetch, files, port: () => 9000, openBrowser: u => opened.push(u) });
  const out = await a.handle('POST', '/account/app/login/lichess', '', new TextEncoder().encode('{"mode": "login"}'));
  assert.equal(out.status, 200);
  assert.deepEqual(opened, ['https://blundr.gr/account/app/go?resume=S']);
  await a.handle('GET', '/account/callback', 'state=S&code=C&account=welcome', null);
  const [start, token] = sent;
  assert.deepEqual([start.provider, start.mode, start.consent, start.port], ['lichess', 'login', null, 9000]);
  assert.equal(token.verifier.length, 64);
  assert.match(token.verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(start.challenge, createHash('sha256').update(token.verifier).digest('base64url'));
  assert.equal(await a.loadToken(), 'T');
  assert.equal(a.outcome, 'welcome');
});

test("account: a token kept for another site isn't sent", async () => {
  const files = memoryFiles();
  await files.writeText(TOKEN_FILE, '{"site": "http://localhost:8787", "token": "dev"}');
  let auth;
  const a = new Account({ fetch: async (url, init) => { auth = init.headers.Authorization; return Response.json({ user: null }); }, files });
  assert.equal(await a.loadToken(), null);
  const dev = new Account({ fetch: async () => Response.json({}), files, site: 'http://localhost:8787/' });
  assert.equal(await dev.loadToken(), 'dev');
  await a.handle('GET', '/account/me', '', null);
  assert.equal(auth, undefined);
  assert.equal(await files.exists(TOKEN_FILE), false, 'signed out: the token goes, whichever site it was for');
});
