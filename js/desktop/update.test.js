// The desktop updater's halves without Electron or Windows: the download streamed to disk, the asar check, unpacking
// both kinds (a zip's entries and extraction stand in for tar), the apply script's text, the apply hook, and the
// fetch that serves a test release.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { ELECTRON_ASSETS, Updater } from '../server/updater.js';
import { applyScript, asarFiles, isAppAsar, makeApply, makeUnpack, readInstalled, releasesFetch, updateFiles } from './update.js';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'blundr-update-'));
  dirs.push(d);
  return d;
};
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

/** A minimal asar: Chromium's pickle header ([4][header size][payload size][json length][json, padded]) and files. */
export function fakeAsar(files) {
  const tree = {};
  let offset = 0;
  const payload = [];
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    let node = tree;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= { files: {} }).files;
    const b = Buffer.from(text);
    node[parts.at(-1)] = { size: b.length, offset: String(offset) };
    offset += b.length;
    payload.push(b);
  }
  const json = Buffer.from(JSON.stringify({ files: tree }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(padded.length + 8, 4);
  head.writeUInt32LE(padded.length + 4, 8);
  head.writeUInt32LE(json.length, 12);
  return Buffer.concat([head, padded, ...payload]);
}
const APP = { 'package.json': '{}', 'js/desktop/main.js': '//' };

test('update: asar check', () => {
  const d = tmp();
  writeFileSync(join(d, 'good.asar'), fakeAsar(APP));
  writeFileSync(join(d, 'other.asar'), fakeAsar({ 'package.json': '{}' }));
  writeFileSync(join(d, 'junk.asar'), 'PK\x03\x04 not an asar');
  assert.ok(asarFiles(join(d, 'good.asar'))['package.json']);
  assert.equal(isAppAsar(join(d, 'good.asar')), true);
  assert.equal(isAppAsar(join(d, 'other.asar')), false);
  assert.equal(isAppAsar(join(d, 'junk.asar')), false);
  assert.equal(isAppAsar(join(d, 'missing.asar')), false);
});

test('update: build.json read, nulls without one', () => {
  const d = tmp();
  assert.deepEqual(readInstalled(d), { version: null, runtime: null });
  writeFileSync(join(d, 'build.json'), JSON.stringify({ version: 'v1.0.0', runtime: 'electron-44.9.3' }));
  assert.deepEqual(readInstalled(d), { version: 'v1.0.0', runtime: 'electron-44.9.3' });
});

test('update: a small update streams to disk, is staged as resources/app.asar and applied with a new build.json', async () => {
  const data = tmp();
  const asar = fakeAsar(APP);
  const half = asar.length >> 1;
  let writes = 0;
  const files = updateFiles(data);
  const openWrite = files.openWrite;
  files.openWrite = async path => {
    const out = await openWrite(path);
    return { write: b => { writes++; return out.write(b); }, close: out.close };
  };
  const latest = { tag_name: 'v1.0.1', html_url: 'u', body: '', assets: [
    { name: 'Blundr-windows.zip', browser_download_url: 'https://dl/full.zip', size: 999 },
    { name: 'blundr-app-electron-44.9.3.asar', browser_download_url: 'https://dl/app.asar', size: asar.length },
  ] };
  const fetch = async url => {
    if (url.includes('api.github.com')) return Response.json(url.endsWith('latest') ? latest : [latest]);
    assert.equal(url, 'https://dl/app.asar');
    return new Response(new ReadableStream({ start(c) { c.enqueue(asar.subarray(0, half)); c.enqueue(asar.subarray(half)); c.close(); } }));
  };
  const started = [];
  let quit = 0;
  const u = new Updater({
    fetch, files, installed: { version: 'v1.0.0', runtime: 'electron-44.9.3' }, platform: 'win32', assets: ELECTRON_ASSETS,
    unpack: makeUnpack(data),
    apply: makeApply({ dataDir: data, install: 'C:\\Apps\\Blundr', pid: 42, quit: () => quit++, start: s => started.push(s), delay: 0 }),
  });
  await u.check();
  assert.equal(u.status().kind, 'update');
  assert.equal(u.download(), true);
  await u.task;
  assert.equal(u.state, 'ready', u.error);
  assert.equal(writes, 2);
  assert.equal(u.stage, 'update/stage/Blundr');
  assert.deepEqual(readFileSync(join(data, 'update', 'stage', 'Blundr', 'resources', 'app.asar')), asar);
  assert.equal(existsSync(join(data, 'update', 'blundr-app-electron-44.9.3.asar')), false);
  await u.apply();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(quit, 1);
  assert.deepEqual(started, [join(data, 'update', 'apply.ps1')]);
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'update', 'stage', 'Blundr', 'resources', 'build.json'), 'utf8')),
                   { version: 'v1.0.1', runtime: 'electron-44.9.3' });
  const script = readFileSync(started[0], 'utf8');
  assert.ok(script.startsWith('\ufeff'));
  assert.match(script, /Wait-Process -Id 42/);
  assert.match(script, /Replace-File/);
  assert.match(script, /\$install = 'C:\\Apps\\Blundr'/);
});

test('update: a small update that is not this app is refused, the install untouched', async () => {
  const data = tmp();
  mkdirSync(join(data, 'update'));
  writeFileSync(join(data, 'update', 'x.asar'), 'nope');
  await assert.rejects(makeUnpack(data)('update/x.asar', 'update/stage', 'update'), /not an app.asar/);
});

test('update: a full zip is checked entry by entry, then for the app', async () => {
  const data = tmp();
  mkdirSync(join(data, 'update'));
  writeFileSync(join(data, 'update', 'Blundr-windows.zip'), 'zip');
  const extract = async (zip, dest) => {
    mkdirSync(join(dest, 'Blundr', 'resources'), { recursive: true });
    writeFileSync(join(dest, 'Blundr', 'Blundr.exe'), 'MZ');
    writeFileSync(join(dest, 'Blundr', 'resources', 'app.asar'), fakeAsar(APP));
    writeFileSync(join(dest, 'Blundr', 'resources', 'build.json'), '{}');
  };
  const ok = ['Blundr/', 'Blundr/Blundr.exe', 'Blundr/resources/app.asar', 'Blundr/resources/build.json'];
  assert.equal(await makeUnpack(data, { entries: () => ok, extract })('update/Blundr-windows.zip', 'update/stage', 'full'),
               'update/stage/Blundr');
  for (const bad of [['chess-review/chess-review.exe'], ['Blundr/../evil.exe'], ['/etc/x'], ['Blundr\\..\\x']]) {
    await assert.rejects(makeUnpack(data, { entries: () => bad, extract })('update/Blundr-windows.zip', 'update/stage', 'full'),
                         /unexpected entry/);
  }
  // a Python build (no app.asar) is not taken
  const python = async (zip, dest) => {
    mkdirSync(join(dest, 'Blundr', '_internal'), { recursive: true });
    writeFileSync(join(dest, 'Blundr', 'Blundr.exe'), 'MZ');
  };
  await assert.rejects(makeUnpack(data, { entries: () => ok, extract: python })('update/Blundr-windows.zip', 'update/stage', 'full'),
                       /does not look like a Blundr build/);
});

test('update: the full apply script swaps the whole folder and puts it back on failure', () => {
  const s = applyScript({ pid: 7, stage: "C:\\D\\update\\stage\\Blundr", install: "C:\\it's\\Blundr", kind: 'full', logfile: 'C:\\D\\update.log' });
  assert.match(s, /\$install = 'C:\\it''s\\Blundr'/);
  assert.match(s, /Move-Item -LiteralPath \$_.FullName -Destination \$aside/);
  assert.match(s, /restoring the old ones/);
  assert.match(s, /'Chess Review.exe', 'chess-review.exe'/);
  assert.match(s, /Start-Process -FilePath \(Join-Path \$install 'Blundr.exe'\)/);
  assert.ok(!/Replace-File \$_/.test(s));
  assert.ok(s.includes('\r\n'));
});

test('update: BLUNDR_UPDATE_API serves the releases from elsewhere, nothing else changes', async () => {
  const seen = [];
  const f = releasesFetch('http://127.0.0.1:9/releases/', 'aris-ver/chess-review', async url => { seen.push(url); return new Response(''); });
  await f('https://api.github.com/repos/aris-ver/chess-review/releases/latest');
  await f('https://api.github.com/repos/aris-ver/chess-review/releases?per_page=100');
  await f('https://example.com/x');
  assert.deepEqual(seen, ['http://127.0.0.1:9/releases/latest', 'http://127.0.0.1:9/releases?per_page=100', 'https://example.com/x']);
});
