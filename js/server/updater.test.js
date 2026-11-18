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

/** A release server: tags[0] is latest; each asset's download counted. fail: the next downloads that answer 500. */
function releases(tags) {
  const seen = { downloads: [], fail: 0 };
  const rel = tag => ({ tag_name: tag, html_url: `u/${tag}`, body: `## What's new\n- ${tag}`, published_at: '2026-11-18T0',
                        assets: [{ name: 'Blundr-windows.zip', browser_download_url: `https://dl/${tag}.zip`, size: 3 }] });
  const fetch = async url => {
    if (url.includes('api.github.com')) return Response.json(url.endsWith('latest') ? rel(tags[0]) : tags.map(rel));
    seen.downloads.push(url);
    if (seen.fail > 0) { seen.fail--; return new Response('no', { status: 500, statusText: 'Internal Server Error' }); }
    return new Response(new Uint8Array([1, 2, 3]));
  };
  return { fetch, seen };
}

test('updater auto: a check that finds a release downloads it, once; the status says it installs on quit', async () => {
  let now = 10_000;
  const { fetch, seen } = releases(['v2']);
  const u = new Updater({ fetch, files: memoryFiles(), installed: { version: 'v1' }, platform: 'win32', auto: true, now: () => now });
  await u.check();
  assert.equal(u.state, 'downloading');
  assert.equal(u.download(), false, 'one download at a time');
  await u.check(true);      // a forced check while it runs starts no second one
  await u.task;
  assert.equal(u.state, 'ready');
  assert.equal(u.download(), false, 'what is staged is not fetched again');
  now += 3600;
  await u.check();
  assert.deepEqual(seen.downloads, ['https://dl/v2.zip']);
  const s = u.status();
  assert.deepEqual([s.auto, s.staged, s.install_error, s.state], [true, 'v2', null, 'ready']);
  // without auto (Python's way, and the dump's): nothing downloads until asked, and the status has no new keys
  const manual = new Updater({ fetch, files: memoryFiles(), installed: { version: 'v1' }, platform: 'win32' });
  await manual.check();
  assert.equal(manual.state, 'idle');
  assert.ok(!('auto' in manual.status()));
});

test('updater auto: a failed download is tried again at the next check, not before', async () => {
  let now = 10_000;
  const { fetch, seen } = releases(['v2']);
  seen.fail = 1;
  const u = new Updater({ fetch, files: memoryFiles(), installed: { version: 'v1' }, platform: 'win32', auto: true, now: () => now });
  await u.check();
  await u.task;
  assert.equal(u.state, 'error');
  assert.match(u.error, /500 Server Error/);
  await u.check();          // inside the hour: no check, so no retry
  assert.equal(seen.downloads.length, 1);
  now += 3600;
  await u.check();
  await u.task;
  assert.deepEqual([u.state, seen.downloads.length], ['ready', 2]);
});

test('updater auto: a newer release replaces the staged one; apply takes what is staged', async () => {
  let now = 10_000;
  const tags = ['v2'];
  const { fetch, seen } = releases(tags);
  const handed = [];
  const u = new Updater({ fetch, files: memoryFiles(), installed: { version: 'v1' }, platform: 'win32', auto: true, now: () => now,
                          apply: async info => handed.push(info) });
  await u.check();
  await u.task;
  tags.unshift('v3');
  now += 3600;
  await u.check();
  assert.deepEqual([u.state, u.stage, u.staged], ['downloading', null, null], 'the old stage is gone as the new download starts');
  assert.equal(await u.applyOnQuit(), false, 'a quit mid-download installs nothing');
  await u.task;
  assert.deepEqual([u.state, u.staged.version, seen.downloads], ['ready', 'v3', ['https://dl/v2.zip', 'https://dl/v3.zip']]);
  // the latest moves on again before the next check's download: apply still installs what is staged
  u.latest = { ...u.latest, version: 'v4' };
  await u.apply();
  assert.equal(handed[0].latest.version, 'v3');
  assert.equal(handed[0].relaunch, true);
  assert.equal(u.state, 'applying');
  assert.equal(u.download(), false, 'no download once applying');
});

test('updater auto: install on quit hands over once, without a relaunch, and never throws', async () => {
  const { fetch } = releases(['v2']);
  const handed = [];
  const u = new Updater({ fetch, files: memoryFiles(), installed: { version: 'v1' }, platform: 'win32', auto: true,
                          apply: async info => handed.push(info) });
  assert.equal(await u.applyOnQuit(), false, 'nothing staged');
  await u.check();
  await u.task;
  assert.equal(await u.applyOnQuit(), true);
  assert.deepEqual([handed.length, handed[0].relaunch, handed[0].kind, handed[0].latest.version], [1, false, 'full', 'v2']);
  assert.equal(await u.applyOnQuit(), false, 'only once');
  // a hook that fails (the script can't be written): the quit goes on, the update stays staged
  const bad = new Updater({ fetch, files: memoryFiles(), installed: { version: 'v1' }, platform: 'win32', auto: true,
                            apply: async () => { throw new Error('disk full'); } });
  await bad.check();
  await bad.task;
  assert.equal(await bad.applyOnQuit(), false);
  assert.equal(bad.state, 'ready');
  // Restart now, then the window closing: applied once
  const once = [];
  const r = new Updater({ fetch, files: memoryFiles(), installed: { version: 'v1' }, platform: 'win32', auto: true,
                          apply: async info => once.push(info.relaunch) });
  await r.check();
  await r.task;
  await r.apply();
  assert.equal(await r.applyOnQuit(), false);
  assert.deepEqual(once, [true]);
  // not auto: the quit installs nothing
  const manual = new Updater({ fetch, files: memoryFiles(), installed: { version: 'v1' }, platform: 'win32', apply: async () => once.push('x') });
  await manual.check();
  manual.download();
  await manual.task;
  assert.equal(await manual.applyOnQuit(), false);
});

test('updater auto: the version whose install failed is not fetched again by itself; a newer one is', async () => {
  let now = 10_000;
  const tags = ['v2'];
  const { fetch, seen } = releases(tags);
  const u = new Updater({ fetch, files: memoryFiles(), installed: { version: 'v1' }, platform: 'win32', auto: true, now: () => now });
  u.installFailed = { version: 'v2', error: 'access denied' };
  await u.check();
  assert.equal(u.state, 'idle');
  assert.deepEqual(u.status().install_error, { version: 'v2', error: 'access denied' });
  assert.equal(u.download(), true, "the banner's button still fetches it");
  await u.task;
  tags.unshift('v3');
  now += 3600;
  await u.check();
  await u.task;
  assert.deepEqual([u.staged.version, seen.downloads], ['v3', ['https://dl/v2.zip', 'https://dl/v3.zip']]);
});
