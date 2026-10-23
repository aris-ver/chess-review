// updater.js beyond the route dump: versions, release notes, the Electron asset names, a download without a length
// or an unpack step, and apply without a platform to hand it to.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoryFiles } from './profiles-files.js';
import { ELECTRON_ASSETS, Updater, changesSince, cmpVersion, parseVersion, pickAsset, whatsNew } from './updater.js';

test('updater: versions, notes and assets', () => {
  assert.deepEqual(parseVersion('v0.1.4-3-gabc123'), [0, 1, 4]);
  assert.equal(parseVersion('nightly'), null);
  assert.ok(cmpVersion([0, 1], [0, 1, 0]) < 0 && cmpVersion([0, 2], [0, 1, 9]) > 0 && cmpVersion([1], [1]) === 0);
  assert.equal(whatsNew('  just text \n'), 'just text');
  assert.equal(whatsNew("Get it.\r\n### what's new\r\n- a\r\n\r\n## Next\r\nb"), '- a');
  const rel = (tag, date) => ({ tag_name: tag, published_at: date, body: tag });
  assert.deepEqual(changesSince([rel('v0.6.2', '2026-01-02T0'), rel('v0.6.10', null), rel('0.6.2', '')], [0, 6, 1], [0, 6, 10]),
    [{ version: 'v0.6.10', date: '', notes: 'v0.6.10' }, { version: 'v0.6.2', date: '2026-01-02', notes: 'v0.6.2' },
     { version: '0.6.2', date: '', notes: '0.6.2' }]);
  const release = { assets: [{ name: 'blundr-app-electron-44.asar', browser_download_url: 'u1', size: 5 },
                             { name: 'Blundr-windows.zip', browser_download_url: 'u2' }] };
  assert.deepEqual(pickAsset(release, 'electron-44', ELECTRON_ASSETS), { name: 'blundr-app-electron-44.asar', url: 'u1', size: 5, kind: 'update' });
  assert.deepEqual(pickAsset(release, 'electron-45', ELECTRON_ASSETS), { name: 'Blundr-windows.zip', url: 'u2', size: null, kind: 'full' });
  assert.equal(new Updater({ installed: { version: 'v1' }, platform: 'linux' }).enabled, false);
});

test('updater: a download with no length and nothing to unpack; apply needs the platform', async () => {
  const files = memoryFiles();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.enqueue(new Uint8Array([4]));
      c.close();
    },
  });
  const latest = { tag_name: 'v2', assets: [{ name: 'Blundr-windows.zip', browser_download_url: 'https://dl/x.zip', size: 9 }] };
  const fetch = async url => (url.includes('api.github.com') ? Response.json(url.endsWith('latest') ? latest : []) : new Response(body));
  const u = new Updater({ fetch, files, installed: { version: 'v1', runtime: null }, platform: 'win32' });
  await u.check();
  assert.equal(u.download(), true);
  assert.equal(u.total, 9);
  await u.task;
  assert.deepEqual([u.state, u.done, u.total, u.stage], ['ready', 4, 9, 'update/Blundr-windows.zip']);
  assert.deepEqual([...await files.readBytes('update/Blundr-windows.zip')], [1, 2, 3, 4]);
  await assert.rejects(u.apply(), /this build cannot apply updates/);
  const handed = [];
  u.applyHook = async info => handed.push(info);
  await u.apply();
  assert.equal(handed[0].kind, 'full');
  assert.equal(handed[0].stage, 'update/Blundr-windows.zip');
});
