// The desktop half of the in-app updater (README.md, "Updater"): what js/server/updater.js's Updater is given to
// download into, unpack with and apply with. A release carries
//
//     blundr-app-<runtime>.asar   just app.asar: the small update, for an install whose runtime (the Electron
//                                 version, in resources/build.json) is <runtime>
//     Blundr-windows.zip          the whole app under Blundr/: the full update, and what a new user downloads
//
// Both are unpacked into DATA/update/stage/Blundr as the install folder's files (a small update: resources/app.asar
// and a resources/build.json with the new version). Applying writes DATA/update/apply.ps1, which waits for this
// process to exit, swaps the files in (a small update file by file through a .new rename; a full one moves the
// install folder's contents aside, copies the new ones in and puts the old ones back if that fails), logs to
// DATA/update.log and starts Blundr.exe again, as chess_review/updater.py's write_apply_script does.

import { execFileSync, spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const EXE_NAME = 'Blundr.exe';
export const LEGACY_EXE_NAMES = ['Chess Review.exe', 'chess-review.exe'];    // updater.LEGACY_EXE_NAMES
export const ZIP_ROOT = 'Blundr';
export const ASIDE = '.blundr-old';      // where a full update keeps the old files until the new ones are in

/** Electron's fs without its asar support (an .asar file is a file, not a folder), or node:fs outside Electron. */
export function rawFs() {
  if (!process.versions.electron) return nodeFs;
  return createRequire(import.meta.url)('original-fs');
}

/** The files adapter the Updater downloads through (profiles-files.js's remove, mkdir, writeBytes), plus openWrite:
 * the download goes to disk as it comes. Over the raw fs, so a downloaded .asar stays a plain file. */
export function updateFiles(dataDir, fs = rawFs()) {
  const at = path => join(dataDir, ...path.split('/').filter(Boolean));
  const p = fs.promises;
  return {
    async remove(path) { await p.rm(at(path), { recursive: true, force: true }); },
    async mkdir(path) { await p.mkdir(at(path), { recursive: true }); },
    async writeBytes(path, bytes) {
      await p.mkdir(dirname(at(path)), { recursive: true });
      await p.writeFile(at(path), bytes);
    },
    async openWrite(path) {
      await p.mkdir(dirname(at(path)), { recursive: true });
      const fh = await p.open(at(path), 'w');
      return { write: bytes => fh.write(bytes), close: () => fh.close() };
    },
  };
}

/** resources/build.json's {version, runtime}; nulls when there is none (a checkout: no updates there). */
export function readInstalled(resources, fs = rawFs()) {
  try {
    const d = JSON.parse(fs.readFileSync(join(resources, 'build.json'), 'utf8'));
    return { version: d.version ?? null, runtime: d.runtime ?? null };
  } catch {
    return { version: null, runtime: null };
  }
}

/** The file list of an asar archive's header, or null when the file isn't one. */
export function asarFiles(path, fs = rawFs()) {
  let fd;
  try {
    fd = fs.openSync(path, 'r');
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) < 16 || head.readUInt32LE(0) !== 4) return null;
    const len = head.readUInt32LE(12);
    if (len <= 0 || len > 64 << 20) return null;
    const json = Buffer.alloc(len);
    fs.readSync(fd, json, 0, len, 16);
    return JSON.parse(json.toString('utf8')).files ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Whether an asar holds this app: a package.json and js/desktop/main.js. */
export function isAppAsar(path, fs = rawFs()) {
  const files = asarFiles(path, fs);
  return !!(files?.['package.json'] && files.js?.files?.desktop?.files?.['main.js']);
}

/** The zip's entries (Windows' tar, bsdtar, reads zips). */
function zipEntries(zip) {
  return execFileSync('tar', ['-tf', zip], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true })
    .split(/\r?\n/).filter(Boolean);
}

/** The Updater's unpack: (path, stageDir, kind) → the stage, all relative to dataDir. Checks what was downloaded
 * and lays it out as the install folder's files under <stageDir>/Blundr. Throws (the page shows it) when the file
 * isn't what it should be; the install is never touched here. */
export function makeUnpack(dataDir, { fs = rawFs(), entries = zipEntries, extract = null } = {}) {
  const at = rel => join(dataDir, ...rel.split('/').filter(Boolean));
  return async (path, stageDir, kind) => {
    const stage = `${stageDir}/${ZIP_ROOT}`;
    await fs.promises.rm(at(stageDir), { recursive: true, force: true });
    if (kind === 'update') {
      if (!isAppAsar(at(path), fs)) throw new Error('the downloaded update is not an app.asar of this app');
      await fs.promises.mkdir(at(`${stage}/resources`), { recursive: true });
      await fs.promises.rename(at(path), at(`${stage}/resources/app.asar`));
      return stage;
    }
    for (const e of entries(at(path))) {
      const parts = e.replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts[0] !== ZIP_ROOT || parts.includes('..') || /^[a-z]:/i.test(e) || e.startsWith('/')) {
        throw new Error(`unexpected entry in the download: ${e}`);
      }
    }
    await fs.promises.mkdir(at(stageDir), { recursive: true });
    if (extract) await extract(at(path), at(stageDir));
    else execFileSync('tar', ['-xf', at(path), '-C', at(stageDir)], { windowsHide: true });
    const app = at(stage);
    if (!fs.existsSync(join(app, EXE_NAME)) || !isAppAsar(join(app, 'resources', 'app.asar'), fs)) {
      throw new Error('the downloaded zip does not look like a Blundr build');
    }
    if (!fs.existsSync(join(app, 'resources', 'build.json'))) throw new Error('the downloaded zip has no build.json');
    return stage;
  };
}

const q = s => "'" + String(s).replace(/'/g, "''") + "'";

/** The PowerShell that finishes an update after process `pid` exits (updater.write_apply_script's, for this app's
 * layout). kind 'update': each staged file over the install's, through a .new rename. 'full': the install folder's
 * contents moved aside into .blundr-old, the stage's copied in (put back as they were if that fails), the old ones
 * deleted. Then Blundr.exe starts again, whatever happened; DATA/update.log says what did. */
export function applyScript({ pid, stage, install, kind, logfile }) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$log = ${q(logfile)}`,
    `$stage = ${q(stage)}`,
    `$install = ${q(install)}`,
    `$aside = Join-Path $install ${q(ASIDE)}`,
    "function Log($m) { Add-Content -Path $log -Value ((Get-Date -Format s) + ' ' + $m) }",
    `Log 'waiting for pid ${pid}'`,
    `try { Wait-Process -Id ${pid} -Timeout 120 -ErrorAction Stop } catch { }`,
    'Start-Sleep -Milliseconds 500',
    'function Replace-File($src, $dst) {',
    "  $tmp = $dst + '.new'",
    '  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null',
    '  Copy-Item -LiteralPath $src -Destination $tmp -Force',
    '  Move-Item -LiteralPath $tmp -Destination $dst -Force',
    '}',
    'function Retry($what, $block) {',
    '  for ($i = 1; $i -le 20; $i++) {',
    "    try { & $block; return } catch { if ($i -eq 20) { throw }; Log ($what + ' failed, retrying: ' + $_); Start-Sleep -Seconds 1 }",
    '  }',
    '}',
    'try {',
  ];
  if (kind === 'update') {
    lines.push(
      "  Retry 'copy' {",
      '    Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {',
      "      $rel = $_.FullName.Substring($stage.Length).TrimStart('\\')",
      '      Replace-File $_.FullName (Join-Path $install $rel)',
      '    }',
      '  }',
    );
  } else {
    lines.push(
      '  if (Test-Path -LiteralPath $aside) { Remove-Item -LiteralPath $aside -Recurse -Force }',
      '  New-Item -ItemType Directory -Force -Path $aside | Out-Null',
      "  Retry 'move the old files aside' {",
      `    Get-ChildItem -LiteralPath $install -Force | Where-Object { $_.Name -ne ${q(ASIDE)} } | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $aside -Force }`,
      '  }',
      '  try {',
      '    Get-ChildItem -LiteralPath $stage -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $install -Recurse -Force }',
      '  } catch {',
      "    Log ('copying the new files in failed, restoring the old ones: ' + $_)",
      `    Get-ChildItem -LiteralPath $install -Force | Where-Object { $_.Name -ne ${q(ASIDE)} } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
      '    Get-ChildItem -LiteralPath $aside -Force | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $install -Force }',
      '    throw',
      '  }',
      '  Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction SilentlyContinue',
    );
  }
  lines.push(
    `  foreach ($n in @(${LEGACY_EXE_NAMES.map(q).join(', ')})) { $p = Join-Path $install $n; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } }`,
    "  Log 'applied'",
    '  Remove-Item -LiteralPath (Split-Path -Parent $stage) -Recurse -Force -ErrorAction SilentlyContinue',
    '} catch {',
    "  Log ('FAILED: ' + $_)",
    '}',
    `Start-Process -FilePath (Join-Path $install ${q(EXE_NAME)}) -WorkingDirectory $install`,
    '',
  );
  return lines.join('\r\n');
}

/** The Updater's apply: a small update gets its new build.json, the script is written (with a BOM: PowerShell reads
 * a BOM-less file as ANSI) and started detached, and `quit` runs once the HTTP answer has gone out. */
export function makeApply({ dataDir, install, pid = process.pid, quit, fs = rawFs(), start = startScript, delay = 500 }) {
  return async ({ stage, kind, installed, latest }) => {
    const stageDir = join(dataDir, ...stage.split('/'));
    if (kind === 'update') {
      fs.writeFileSync(join(stageDir, 'resources', 'build.json'),
                       JSON.stringify({ version: latest.version, runtime: installed.runtime }));
    }
    const script = join(dataDir, 'update', 'apply.ps1');
    fs.writeFileSync(script, '﻿' + applyScript({ pid, stage: stageDir, install, kind, logfile: join(dataDir, 'update.log') }), 'utf8');
    start(script);
    setTimeout(quit, delay);
  };
}

function startScript(script) {
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** fetch with GitHub's releases API for this repo (…/repos/<repo>/releases) served from `base` instead
 * (BLUNDR_UPDATE_API=http://127.0.0.1:<port>/releases: a test release on this machine). */
export function releasesFetch(base, repo, fetch = globalThis.fetch) {
  const from = `https://api.github.com/repos/${repo}/releases`;
  return (url, opts) => fetch(String(url).startsWith(from) ? base.replace(/\/$/, '') + String(url).slice(from.length) : url, opts);
}
