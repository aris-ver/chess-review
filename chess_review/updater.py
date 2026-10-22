"""In-app updates for the Windows build: check GitHub for a newer release, download it, swap it in on restart.

A release carries two zips (packaging/pack.py builds them):

    chess-review-windows.zip             the full app, ~250 MB unpacked: Python runtime, DuckDB/PyArrow, Stockfish
    chess-review-update-<runtime>.zip    just what changes between most releases, a few MB: the exe (the app's
                                         compiled code) and _internal/chess_review (the web UI)

<runtime> hashes the rest of _internal (the DLL/.pyd layer the exe's code was compiled against). An install can
take the small zip only when its own fingerprint (in _internal/build.json) matches; otherwise the whole _internal
folder is replaced from the full zip.
The update is downloaded and unpacked under DATA/update while the app runs; applying it means writing a small
PowerShell script that waits for this process to exit, copies the files in (Windows won't let a running exe be
overwritten) and starts the new exe. The launcher closes the window once the script is spawned.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path
from typing import Callable, Optional

import requests

from .config import BUNDLE_ROOT, DATA, GITHUB_REPO, USER_AGENT

log = logging.getLogger("updater")

EXE_NAME = "Blundr.exe"
# up to v0.5.6 and v0.1.11; builds still ship all three (packaging/pack.py), so any may be the one here
LEGACY_EXE_NAMES = ("Chess Review.exe", "chess-review.exe")
FULL_ASSET = "chess-review-windows.zip"
UPDATE_ASSET = "chess-review-update-{runtime}.zip"
ZIP_ROOT = "chess-review"       # both zips wrap the app folder
CHECK_TTL = 3600                # a launch re-checks GitHub at most once an hour (unauthenticated API: 60 req/h)
UPDATE_DIR = DATA / "update"

# set by the desktop launcher: closes the window so the process exits and the apply script can run
exit_app: Optional[Callable[[], None]] = None


def parse_version(tag: Optional[str]) -> Optional[tuple]:
    """'v0.1.5' -> (0, 1, 5); a git-describe string like 'v0.1.4-3-gabc123' -> (0, 1, 4). None if unparsable."""
    m = re.match(r"^v?(\d+(?:\.\d+)*)", tag or "")
    return tuple(int(x) for x in m.group(1).split(".")) if m else None


def installed() -> dict:
    """{version, runtime} written by the build script; both None from a source checkout (no updates there)."""
    try:
        d = json.loads((BUNDLE_ROOT / "build.json").read_text(encoding="utf-8"))
        return {"version": d.get("version"), "runtime": d.get("runtime")}
    except (OSError, ValueError):
        return {"version": None, "runtime": None}


def pick_asset(release: dict, runtime: Optional[str]) -> Optional[dict]:
    """The small update zip built for this install's runtime if the release has one, else the full zip."""
    assets = {a["name"]: a for a in release.get("assets", [])}
    small = assets.get(UPDATE_ASSET.format(runtime=runtime)) if runtime else None
    a = small or assets.get(FULL_ASSET)
    if not a:
        return None
    return {"name": a["name"], "url": a["browser_download_url"], "size": a.get("size"),
            "kind": "update" if small else "full"}


def _fetch_latest() -> dict:
    r = requests.get(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest", timeout=10,
                     headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    r.raise_for_status()
    return r.json()


def _fetch_releases() -> list:
    r = requests.get(f"https://api.github.com/repos/{GITHUB_REPO}/releases", params={"per_page": 100}, timeout=10,
                     headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    r.raise_for_status()
    return r.json()


def whats_new(body: Optional[str]) -> str:
    """The '## What's new' part of a release body as the workflow writes it, without the download instructions
    above it or the changelog link under it. A body without that heading is returned whole."""
    lines = (body or "").splitlines()
    start = next((i for i, l in enumerate(lines) if re.match(r"^#{1,3}\s+what'?s new", l.strip(), re.I)), None)
    if start is None:
        return (body or "").strip()
    out = []
    for l in lines[start + 1:]:
        if re.match(r"^#{1,3}\s", l) or l.strip().lower().startswith("**full changelog**"):
            break
        out.append(l)
    return "\n".join(out).strip()


def changes_since(releases: list, mine: tuple, latest: tuple) -> list:
    """Every published release after the installed version up to the latest, newest first: what an update brings."""
    out = []
    for rel in releases:
        v = parse_version(rel.get("tag_name"))
        if rel.get("draft") or rel.get("prerelease") or not v or not mine < v <= latest:
            continue
        out.append({"version": rel["tag_name"], "date": (rel.get("published_at") or "")[:10],
                    "notes": whats_new(rel.get("body"))})
    return sorted(out, key=lambda c: parse_version(c["version"]), reverse=True)


class Updater:
    """One per server. check() is cached; download() runs in a thread and status() reports its progress."""

    def __init__(self):
        self.lock = threading.Lock()
        self.installed = installed()
        self.latest: Optional[dict] = None      # {version, url, notes, asset, changes} once checked
        self.checked_at = 0.0
        self.check_error: Optional[str] = None
        self.state = "idle"                     # idle | downloading | ready | error
        self.done = self.total = 0
        self.error: Optional[str] = None
        self.stage: Optional[Path] = None       # unpacked app folder, ready to be applied

    @property
    def enabled(self) -> bool:
        return self.installed["version"] is not None and sys.platform == "win32"

    def check(self, force: bool = False) -> None:
        if not self.enabled or (not force and time.time() - self.checked_at < CHECK_TTL):
            return
        try:
            rel = _fetch_latest()
            self.latest = {"version": rel.get("tag_name"), "url": rel.get("html_url"), "notes": rel.get("body") or "",
                           "asset": pick_asset(rel, self.installed["runtime"]), "changes": []}
            self.check_error = None
            if self.newer:      # one more request, only when there is an update: the notes of every skipped release
                try:
                    self.latest["changes"] = changes_since(_fetch_releases(), parse_version(self.installed["version"]),
                                                           parse_version(self.latest["version"]))
                except (requests.RequestException, ValueError) as e:
                    log.warning("could not list releases: %s", e)     # the latest release's notes still show
        except (requests.RequestException, ValueError) as e:
            log.warning("update check failed: %s", e)
            self.check_error = str(e)
        self.checked_at = time.time()

    @property
    def newer(self) -> bool:
        mine, theirs = parse_version(self.installed["version"]), parse_version(self.latest and self.latest["version"])
        return bool(mine and theirs and theirs > mine and self.latest["asset"])

    def status(self) -> dict:
        out = {"enabled": self.enabled, "installed": self.installed["version"], "state": self.state,
               "done": self.done, "total": self.total, "error": self.error, "check_error": self.check_error}
        if self.latest:
            out.update(latest=self.latest["version"], url=self.latest["url"], notes=self.latest["notes"], newer=self.newer,
                       changes=self.latest.get("changes", []),
                       kind=self.latest["asset"]["kind"] if self.latest["asset"] else None,
                       size=self.latest["asset"]["size"] if self.latest["asset"] else None)
        return out

    def download(self) -> bool:
        """Start fetching the latest release's zip in the background. False if nothing to do or already busy."""
        with self.lock:
            if not self.newer or self.state in ("downloading", "ready"):
                return False
            self.state, self.done, self.total, self.error = "downloading", 0, self.latest["asset"]["size"] or 0, None
        threading.Thread(target=self._download, args=(self.latest["asset"],), daemon=True, name="update").start()
        return True

    def _download(self, asset: dict) -> None:
        try:
            shutil.rmtree(UPDATE_DIR, ignore_errors=True)
            UPDATE_DIR.mkdir(parents=True, exist_ok=True)
            zip_path = UPDATE_DIR / asset["name"]
            with requests.get(asset["url"], stream=True, timeout=30, headers={"User-Agent": USER_AGENT}) as r:
                r.raise_for_status()
                self.total = int(r.headers.get("Content-Length") or self.total)
                with open(zip_path, "wb") as f:
                    for chunk in r.iter_content(1 << 16):
                        f.write(chunk)
                        self.done += len(chunk)
            self.stage = unpack(zip_path, UPDATE_DIR / "stage", asset["kind"])
            zip_path.unlink()
            self.state = "ready"
        except Exception as e:  # noqa: BLE001 - whatever went wrong, the UI shows it and the install is untouched
            log.error("update download failed: %s", e)
            self.state, self.error = "error", str(e)

    def apply(self) -> None:
        """Hand over to the apply script and close the app. Only valid once state == 'ready'."""
        if self.state != "ready" or not self.stage:
            raise RuntimeError("no update ready")
        exe = Path(sys.executable)
        kind = "update" if self.latest["asset"]["kind"] == "update" else "full"
        script = write_apply_script(UPDATE_DIR / "apply.ps1", os.getpid(), self.stage, exe.parent, kind,
                                    DATA / "update.log")
        subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                         creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        log.info("update %s -> %s: apply script started, exiting", self.installed["version"], self.latest["version"])
        if exit_app:
            threading.Timer(0.5, exit_app).start()     # let the HTTP response go out first


def unpack(zip_path: Path, dest: Path, kind: str) -> Path:
    """Extract the zip's chess-review/ folder into dest and sanity-check it. Returns that folder.
    Which runtime an update zip fits is said by its name (pick_asset matched it), not re-checked here: a
    release may publish one zip under several fingerprints when those runtimes are byte-identical."""
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename.replace("\\", "/")     # Compress-Archive on older PowerShell writes backslashes
            rel = Path(*[p for p in name.split("/") if p])
            if not rel.parts or rel.parts[0] != ZIP_ROOT or ".." in rel.parts:
                raise ValueError(f"unexpected entry in {zip_path.name}: {info.filename}")
            target = dest / rel
            if name.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
    app = dest / ZIP_ROOT
    if not any((app / n).is_file() for n in (EXE_NAME, *LEGACY_EXE_NAMES)) or not (app / "_internal" / "chess_review").is_dir():
        raise ValueError("the downloaded zip does not look like a chess-review build")
    if kind == "update":
        if not (app / "_internal" / "build.json").is_file():
            raise ValueError("update zip has no build.json")
    elif not list((app / "_internal").glob("python3*.dll")):
        raise ValueError("full zip is missing the Python runtime")
    return app


def write_apply_script(path: Path, pid: int, stage: Path, install: Path, kind: str, logfile: Path) -> Path:
    """The PowerShell that finishes the update after this process exits.

    'update': copy the staged files over the install, file by file (each through a .new rename, so a file is
    either old or new, never truncated). 'full': rename _internal aside, move the new one in, replace the exes,
    delete the old runtime; if moving the new _internal fails the old one is put back. Either way the app is
    started again at the end, and whatever happened is in DATA/update.log."""
    q = lambda p: "'" + str(p).replace("'", "''") + "'"  # noqa: E731
    lines = [
        "$ErrorActionPreference = 'Stop'",
        f"$log = {q(logfile)}",
        f"$stage = {q(stage)}",
        f"$install = {q(install)}",
        f"$exeNames = @({', '.join(q(n) for n in (EXE_NAME, *LEGACY_EXE_NAMES))})",
        "function Find-Exe { foreach ($n in $exeNames) { $p = Join-Path $install $n; if (Test-Path -LiteralPath $p) { return $p } }; return (Join-Path $install $exeNames[0]) }",
        "function Log($m) { Add-Content -Path $log -Value ((Get-Date -Format s) + ' ' + $m) }",
        f"Log 'waiting for pid {pid}'",
        f"try {{ Wait-Process -Id {pid} -Timeout 120 -ErrorAction Stop }} catch {{ }}",
        "Start-Sleep -Milliseconds 500",
        "function Replace-File($src, $dst) {",
        "  $tmp = $dst + '.new'",
        "  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null",
        "  Copy-Item -LiteralPath $src -Destination $tmp -Force",
        "  Move-Item -LiteralPath $tmp -Destination $dst -Force",
        "}",
        "function Retry($what, $block) {",
        "  for ($i = 1; $i -le 20; $i++) {",
        "    try { & $block; return } catch { if ($i -eq 20) { throw }; Log ($what + ' failed, retrying: ' + $_); Start-Sleep -Seconds 1 }",
        "  }",
        "}",
        "try {",
    ]
    if kind == "update":
        lines += [
            "  Retry 'copy' {",
            "    Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {",
            "      $rel = $_.FullName.Substring($stage.Length).TrimStart('\\')",
            "      Replace-File $_.FullName (Join-Path $install $rel)",
            "    }",
            "  }",
        ]
    else:
        lines += [
            "  $old = Join-Path $install '_internal.old'",
            "  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }",
            "  Retry 'move old runtime aside' { Move-Item -LiteralPath (Join-Path $install '_internal') -Destination $old -Force }",
            "  try {",
            "    Move-Item -LiteralPath (Join-Path $stage '_internal') -Destination (Join-Path $install '_internal') -Force",
            "  } catch {",
            "    Log ('moving the new runtime in failed, restoring the old one: ' + $_)",
            "    Remove-Item -LiteralPath (Join-Path $install '_internal') -Recurse -Force -ErrorAction SilentlyContinue",
            "    Move-Item -LiteralPath $old -Destination (Join-Path $install '_internal') -Force",
            "    throw",
            "  }",
            "  Retry 'replace exe' { Get-ChildItem -LiteralPath $stage -Filter *.exe -File | ForEach-Object { Replace-File $_.FullName (Join-Path $install $_.Name) } }",
            "  Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue",
        ]
    lines += [
        "  Log 'applied'",
        "  Remove-Item -LiteralPath (Split-Path -Parent $stage) -Recurse -Force -ErrorAction SilentlyContinue",
        "} catch {",
        "  Log ('FAILED: ' + $_)",
        "}",
        "$exe = Find-Exe",
        "Start-Process -FilePath $exe -WorkingDirectory $install",
        "",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\r\n".join(lines), encoding="utf-8-sig")   # BOM: PowerShell reads a BOM-less file as ANSI
    return path
