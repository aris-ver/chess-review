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
// DATA/update.log and starts Blundr.exe again, as chess_review/updater.py's write_apply_script does. Applied as the app
// closes (main.js, Updater.applyOnQuit) it doesn't start it again: the user closed it.

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

/** DATA/<MARKER>: an install script at work, {pid, at} (at: ms since the epoch). Written by makeApply as it starts the
 * script, then by the script itself (its own pid), and deleted when it is done. While it is fresh and its process
 * alive, another launch neither downloads (that would wipe the stage being copied from) nor applies. */
export const MARKER = 'update-applying.json';
export const MARKER_TTL_MS = 10 * 60 * 1000;      // past this a marker is left over from a script that was killed
const MARKER_GRACE_MS = 30_000;                    // the app's marker, before the script has put its own pid in
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
/** Whether an install script is still at work on this data folder (MARKER). */
export function installing(dataDir, { fs = rawFs(), now = Date.now(), isAlive = alive } = {}) {
  let d;
  try { d = JSON.parse(fs.readFileSync(join(dataDir, MARKER), 'utf8').replace(/^﻿/, '')); } catch { return false; }
  const age = now - Number(d?.at);
  if (!(age >= -MARKER_GRACE_MS && age < MARKER_TTL_MS)) return false;
  return age < MARKER_GRACE_MS || (Number.isInteger(d.pid) && isAlive(d.pid));
}

/** The PowerShell that finishes an update once the app has closed (updater.write_apply_script's, for this app's
 * layout). It waits for every process run from the install folder to end (the app's main process `pid`, its helper
 * processes, and any other copy started from there: matched by path, so a reused pid can't fool it); one still there
 * after two minutes and nothing changes. kind 'update': each staged file over the install's, through a .new rename.
 * 'full': the install folder's contents moved aside into .blundr-old, the stage's copied in, the old ones deleted;
 * .blundr-old/.state says how far that got ('moving', 'copying', 'done'), so a swap cut off (the script killed) is put
 * back the next time a script runs, before anything else: the old files where 'moving' or 'copying' stopped, the new
 * ones kept after 'done'. A failed copy puts the old files back at once. Then Blundr.exe starts again, whatever
 * happened (relaunch false: not, the user closed the app). DATA/update.log says what happened, from an 'installing
 * <version>' line (lastInstall reads it at the next launch); `marker` (MARKER) is there while it works. */
export function applyScript({ pid, stage, install, kind, logfile, version = '', relaunch = true, marker = null }) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$log = ${q(logfile)}`,
    `$stage = ${q(stage)}`,
    `$install = ${q(install)}`,
    `$aside = Join-Path $install ${q(ASIDE)}`,
    "$state = Join-Path $aside '.state'",
    `$marker = ${marker ? q(marker) : '$null'}`,
    "function Log($m) { Add-Content -Path $log -Value ((Get-Date -Format s) + ' ' + $m) }",
    "function Mark { if ($marker) { Set-Content -LiteralPath $marker -Value ('{\"pid\":' + $PID + ',\"at\":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}') } }",
    "function Unmark { if ($marker) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue } }",
    // every process whose file is in the install folder (Path is unreadable for some system processes: skipped)
    "$prefix = $install.TrimEnd('\\') + '\\'",
    "function Running { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $p = $null; try { $p = $_.Path } catch { }; $p -and $p.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }) }",
    'Mark',
    `Log ${q(`installing ${version || '?'} (${kind}${relaunch ? '' : ', on quit'})`)}`,
    `Log 'waiting for Blundr (pid ${Number(pid)}) to close'`,
    'for ($i = 0; $i -lt 240 -and (Running).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }',
    '$left = Running',
    'if ($left.Count -gt 0) {',
    `  if ($left | Where-Object { $_.Id -eq ${Number(pid)} }) { Log 'FAILED: Blundr was still running, nothing changed' }`,
    "  else { Log ('FAILED: another copy of Blundr is running from this folder (pid ' + (($left | ForEach-Object { $_.Id }) -join ', ') + '), nothing changed') }",
    '  Unmark',
    '  exit 1',
    '}',
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
    // a full swap cut off: its old files back where it stopped before the new ones were all in; kept once they were
    'function Restore-Aside {',
    "  $s = ''; if (Test-Path -LiteralPath $state) { $s = (Get-Content -LiteralPath $state -Raw).Trim() }",
    "  if ($s -ne 'done') {",
    `    if ($s -eq 'copying') { Get-ChildItem -LiteralPath $install -Force | Where-Object { $_.Name -ne ${q(ASIDE)} } | Remove-Item -Recurse -Force }`,
    "    Get-ChildItem -LiteralPath $aside -Force | Where-Object { $_.Name -ne '.state' } | ForEach-Object {",
    '      $dst = Join-Path $install $_.Name',
    '      if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }',
    '      Move-Item -LiteralPath $_.FullName -Destination $install -Force',
    '    }',
    '  }',
    '  Remove-Item -LiteralPath $aside -Recurse -Force',
    "  if ($s) { return $s } else { return 'moving' }",
    '}',
    'try {',
    "  if (Test-Path -LiteralPath $aside) { $s = Restore-Aside; Log ('an earlier update was cut off (' + $s + '): put back as it was') }",
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
      '  New-Item -ItemType Directory -Force -Path $aside | Out-Null',
      "  Set-Content -LiteralPath $state -Value 'moving'",
      "  Retry 'move the old files aside' {",
      `    Get-ChildItem -LiteralPath $install -Force | Where-Object { $_.Name -ne ${q(ASIDE)} } | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $aside -Force }`,
      '  }',
      "  Set-Content -LiteralPath $state -Value 'copying'",
      '  try {',
      '    Get-ChildItem -LiteralPath $stage -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $install -Recurse -Force }',
      '  } catch {',
      "    Log ('copying the new files in failed, restoring the old ones: ' + $_)",
      '    Restore-Aside | Out-Null',
      '    throw',
      '  }',
      "  Set-Content -LiteralPath $state -Value 'done'",
      '  Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction SilentlyContinue',
    );
  }
  lines.push(
    `  foreach ($n in @(${LEGACY_EXE_NAMES.map(q).join(', ')})) { $p = Join-Path $install $n; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } }`,
    "  Log 'applied'",
    '  Remove-Item -LiteralPath (Split-Path -Parent $stage) -Recurse -Force -ErrorAction SilentlyContinue',
    '} catch {',
    "  Log ('FAILED: ' + $_)",
    '} finally {',
    '  Unmark',
    '}',
    ...(relaunch ? [`Start-Process -FilePath (Join-Path $install ${q(EXE_NAME)}) -WorkingDirectory $install`] : []),
    '',
  );
  return lines.join('\r\n');
}

/** A swap the script left half done (the machine went down mid-way), seen at launch: only 'done' is cleared here (the
 * new files are all in; the old ones aren't in use). Otherwise the next script run puts it back before anything else,
 * as files of this running app can't be moved now. Returns the state found, or null. */
export function leftAside(install, { fs = rawFs(), log = null } = {}) {
  const aside = join(install, ASIDE);
  if (!fs.existsSync(aside)) return null;
  let s = 'moving';
  try { s = fs.readFileSync(join(aside, '.state'), 'utf8').trim() || 'moving'; } catch { /* cut off before the state */ }
  if (s === 'done') {
    try { fs.rmSync(aside, { recursive: true, force: true }); } catch (e) { log?.warn?.(`could not delete ${aside}: ${e.message}`); }
  } else {
    log?.warn?.(`${aside} is left from an update cut off while ${s}: the next update puts it back first`);
  }
  return s;
}

/** What the last install in DATA/update.log's text came to: {version, error} (error null when it went in), or null
 * when there is none (or only a log from before 'installing' lines). */
export function lastInstall(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (/ installing \S+ \(/.test(lines[i])) at = i;
  if (at < 0) return null;
  const version = / installing (\S+) \(/.exec(lines[at])[1];
  const failed = lines.slice(at + 1).find(l => / FAILED: /.test(l));
  return { version, error: failed ? failed.slice(failed.indexOf('FAILED: ') + 8).trim() : null };
}

/** The Updater's apply: a small update gets its new build.json, the script is written (with a BOM: PowerShell reads
 * a BOM-less file as ANSI) and started detached, and `quit` runs once the HTTP answer has gone out. relaunch false
 * (the app is closing already): no restart after, and no quit. */
export function makeApply({ dataDir, install, pid = process.pid, quit, fs = rawFs(), start = startScript, delay = 500 }) {
  return async ({ stage, kind, installed, latest, relaunch = true }) => {
    const stageDir = join(dataDir, ...stage.split('/'));
    if (kind === 'update') {
      fs.writeFileSync(join(stageDir, 'resources', 'build.json'),
                       JSON.stringify({ version: latest.version, runtime: installed.runtime }));
    }
    const script = join(dataDir, 'update', 'apply.ps1'), marker = join(dataDir, MARKER);
    fs.writeFileSync(script, '﻿' + applyScript({ pid, stage: stageDir, install, kind, logfile: join(dataDir, 'update.log'),
                                                  version: latest.version, relaunch, marker }), 'utf8');
    // the marker before the script starts: a launch right after this one waits for it (the script then takes it over)
    fs.writeFileSync(marker, JSON.stringify({ pid, at: Date.now() }));
    try {
      start(script);
    } catch (e) {
      fs.rmSync(marker, { force: true });
      throw e;
    }
    if (relaunch) setTimeout(quit, delay);
  };
}

// Through `start`: a child must be detached to outlive the app (libuv puts the others in a job that dies with it), and
// a detached PowerShell has no console and quits without running anything; `start` gives it one, minimised and then
// hidden by -WindowStyle.
function startScript(script) {
  const cmd = `start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
  spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    .on('error', () => {})      // no cmd.exe: nothing applied, and the app closes as it would (update.log has no 'applied')
    .unref();
}

/** fetch with GitHub's releases API for this repo (…/repos/<repo>/releases) served from `base` instead
 * (BLUNDR_UPDATE_API=http://127.0.0.1:<port>/releases: a test release on this machine). */
export function releasesFetch(base, repo, fetch = globalThis.fetch) {
  const from = `https://api.github.com/repos/${repo}/releases`;
  return (url, opts) => fetch(String(url).startsWith(from) ? base.replace(/\/$/, '') + String(url).slice(from.length) : url, opts);
}
