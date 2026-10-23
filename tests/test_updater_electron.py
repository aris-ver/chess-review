"""The bridge release's way to the Electron app (updater.py's "electron" kind): spotting an Electron release, unpacking
its zip, exporting the data to SQLite once more before anything is swapped, and the PowerShell that replaces the
whole install folder (run for real on Windows)."""

import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from chess_review import migrate_sqlite, updater

RUNTIME = "abc123def456"
ELECTRON_RELEASE = {"tag_name": "v1.0.0", "html_url": "https://github.com/x/releases/v1.0.0", "body": "", "assets": [
    {"name": "Blundr-windows.zip", "browser_download_url": "https://dl/Blundr-windows.zip", "size": 120_000_000},
    {"name": "blundr-app-electron-44.9.3.asar", "browser_download_url": "https://dl/app.asar", "size": 3_000_000},
    # the bridge's own small zip, re-attached for older Pythons: not for the bridge itself
    {"name": f"chess-review-update-{RUNTIME}.zip", "browser_download_url": "https://dl/u.zip", "size": 5_000_000},
]}


def test_an_electron_release_is_a_full_electron_download_even_with_a_matching_small_zip():
    a = updater.pick_asset(ELECTRON_RELEASE, RUNTIME)
    assert a == {"name": "Blundr-windows.zip", "url": "https://dl/Blundr-windows.zip", "size": 120_000_000,
                 "kind": "full", "electron": True}
    # a Python release with the same names but no .asar stays as it was
    py = {**ELECTRON_RELEASE, "assets": [x for x in ELECTRON_RELEASE["assets"] if not x["name"].endswith(".asar")]}
    assert updater.pick_asset(py, RUNTIME)["kind"] == "update"


def test_the_page_sees_a_full_download(monkeypatch):
    monkeypatch.setattr(updater, "installed", lambda: {"version": "v0.7.0", "runtime": RUNTIME})
    monkeypatch.setattr(updater, "_fetch_latest", lambda: ELECTRON_RELEASE)
    monkeypatch.setattr(updater, "_fetch_releases", lambda: [ELECTRON_RELEASE])
    monkeypatch.setattr(updater.sys, "platform", "win32")
    u = updater.Updater()
    u.check()
    s = u.status()
    assert s["newer"] is True and s["kind"] == "full" and s["size"] == 120_000_000


def _electron_zip(path: Path, asar=True, root="Blundr") -> Path:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(f"{root}/Blundr.exe", b"electron exe")
        z.writestr(f"{root}/ffmpeg.dll", b"dll")
        z.writestr(f"{root}/locales/en-US.pak", b"pak")
        z.writestr(f"{root}/resources/build.json", json.dumps({"version": "v1.0.0", "runtime": "electron-44.9.3"}))
        z.writestr(f"{root}/resources/bin/stockfish.exe", b"sf")
        if asar:
            z.writestr(f"{root}/resources/app.asar", b"asar")
    return path


def test_unpack_takes_the_electron_zip(tmp_path):
    app = updater.unpack(_electron_zip(tmp_path / "e.zip"), tmp_path / "stage", "electron")
    assert app == tmp_path / "stage" / "Blundr"
    assert (app / "resources" / "app.asar").read_bytes() == b"asar"


@pytest.mark.parametrize("asar,root", [(False, "Blundr"), (True, "chess-review")])
def test_unpack_refuses_what_is_not_the_electron_build(tmp_path, asar, root):
    with pytest.raises(ValueError, match="does not look like a Blundr build"):
        updater.unpack(_electron_zip(tmp_path / "e.zip", asar=asar, root=root), tmp_path / "stage", "electron")


def test_the_python_zip_check_still_refuses_an_electron_zip(tmp_path):
    with pytest.raises(ValueError):
        updater.unpack(_electron_zip(tmp_path / "e.zip"), tmp_path / "stage", "full")


def test_export_for_electron(monkeypatch, tmp_path):
    for res in ({"status": "done"}, {"status": "skipped", "reason": "done already"},
                {"status": "skipped", "reason": "sqlite in use"}):
        monkeypatch.setattr(migrate_sqlite, "migrate", lambda data, r=res: r)
        assert updater.export_for_electron(tmp_path) == res

    def locked(data):
        raise OSError("IO Error: Could not set lock on file evals.duckdb\nmore")
    monkeypatch.setattr(migrate_sqlite, "migrate", locked)
    with pytest.raises(RuntimeError, match=r"could not be converted .*Could not set lock on file evals.duckdb\)\. Nothing"):
        updater.export_for_electron(tmp_path)


def test_export_for_electron_for_real(tmp_path):
    (tmp_path / "puzzle_solved.jsonl").write_text('{"id": "p1", "ts": 1}\n', encoding="utf-8")
    assert updater.export_for_electron(tmp_path)["status"] == "done"
    assert updater.export_for_electron(tmp_path)["reason"] == "done already"
    # the app wrote since: exported again, so nothing done after the start-up export is left behind
    with (tmp_path / "puzzle_solved.jsonl").open("a", encoding="utf-8") as f:
        f.write('{"id": "p2", "ts": 2}\n')
    os.utime(tmp_path / "puzzle_solved.jsonl", ns=(1, 2_000_000_000_000_000_000))
    assert updater.export_for_electron(tmp_path)["status"] == "done"
    marker = json.loads((tmp_path / migrate_sqlite.MARKER).read_text(encoding="utf-8"))
    assert marker["files"]["progress.sqlite"]["puzzle_solved"] == 2


def _ready(monkeypatch, tmp_path):
    monkeypatch.setattr(updater, "installed", lambda: {"version": "v0.7.0", "runtime": RUNTIME})
    monkeypatch.setattr(updater, "UPDATE_DIR", tmp_path / "update")
    u = updater.Updater()
    u.latest = {"version": "v1.0.0", "asset": updater.pick_asset(ELECTRON_RELEASE, RUNTIME)}
    u.state, u.stage = "ready", tmp_path / "update" / "stage" / "Blundr"
    started = []
    monkeypatch.setattr(updater.subprocess, "Popen", lambda args, **kw: started.append(args))
    for flag in ("CREATE_NO_WINDOW", "CREATE_NEW_PROCESS_GROUP"):      # Windows-only names, off Windows
        monkeypatch.setattr(updater.subprocess, flag, getattr(subprocess, flag, 0), raising=False)
    monkeypatch.setattr(updater, "exit_app", None)
    return u, started


def test_apply_exports_first_then_writes_the_electron_script(monkeypatch, tmp_path):
    u, started = _ready(monkeypatch, tmp_path)
    order = []
    monkeypatch.setattr(updater, "export_for_electron", lambda: order.append("export") or {"status": "done"})
    real = updater.write_apply_script
    monkeypatch.setattr(updater, "write_apply_script", lambda *a: order.append(a[4]) or real(*a))
    u.apply()
    assert order == ["export", "electron"] and len(started) == 1
    s = (tmp_path / "update" / "apply.ps1").read_text(encoding="utf-8-sig")
    assert "'.blundr-old'" in s and "restoring the old ones" in s and "_internal.old" not in s


def test_apply_changes_nothing_when_the_export_fails(monkeypatch, tmp_path):
    u, started = _ready(monkeypatch, tmp_path)

    def fail():
        raise RuntimeError("Your data could not be converted")
    monkeypatch.setattr(updater, "export_for_electron", fail)
    with pytest.raises(RuntimeError):
        u.apply()
    assert started == [] and not (tmp_path / "update" / "apply.ps1").exists()


def _python_install(root: Path, system32: Path) -> Path:
    import shutil
    (root / "_internal" / "chess_review").mkdir(parents=True)
    (root / "_internal" / "python312.dll").write_bytes(b"dll")
    for n in ("Blundr.exe", "Chess Review.exe", "chess-review.exe"):
        shutil.copy(system32 / "where.exe", root / n)
    return root


def _gone_pid() -> int:
    gone = subprocess.Popen(["cmd", "/c", "exit"])   # a pid that has already exited: nothing to wait for
    gone.wait()
    return gone.pid


@pytest.mark.skipif(sys.platform != "win32", reason="runs the generated PowerShell for real")
def test_electron_script_replaces_the_whole_install(tmp_path):
    import shutil
    system32 = Path(os.environ["SystemRoot"]) / "System32"
    old = _python_install(tmp_path / "Blundr", system32)
    stage = updater.unpack(_electron_zip(tmp_path / "e.zip"), tmp_path / "update" / "stage", "electron")
    shutil.copy(system32 / "whoami.exe", stage / "Blundr.exe")    # harmless, exits at once: what Start-Process runs
    log = tmp_path / "update.log"
    script = updater.write_apply_script(tmp_path / "update" / "apply.ps1", _gone_pid(), stage, old, "electron", log)
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                   timeout=120, capture_output=True)
    assert "applied" in log.read_text(), log.read_text()
    assert sorted(p.name for p in old.iterdir()) == ["Blundr.exe", "ffmpeg.dll", "locales", "resources"]
    assert (old / "Blundr.exe").read_bytes() == (system32 / "whoami.exe").read_bytes()
    assert (old / "resources" / "app.asar").read_bytes() == b"asar"
    assert (old / "locales" / "en-US.pak").exists()
    assert not (tmp_path / "update" / "stage").exists()


@pytest.mark.skipif(sys.platform != "win32", reason="runs the generated PowerShell for real")
def test_electron_script_puts_the_old_install_back_when_the_copy_fails(tmp_path):
    import ctypes
    from ctypes import wintypes
    system32 = Path(os.environ["SystemRoot"]) / "System32"
    old = _python_install(tmp_path / "Blundr", system32)
    before = sorted(p.relative_to(old).as_posix() for p in old.rglob("*"))
    stage = updater.unpack(_electron_zip(tmp_path / "e.zip"), tmp_path / "update" / "stage", "electron")
    # a staged file nobody may read while the script runs: the copy fails half way
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = wintypes.HANDLE
    h = k32.CreateFileW(str(stage / "resources" / "app.asar"), 0x80000000, 0, None, 3, 0, None)   # GENERIC_READ, no sharing
    assert h != wintypes.HANDLE(-1).value
    try:
        log = tmp_path / "update.log"
        script = updater.write_apply_script(tmp_path / "update" / "apply.ps1", _gone_pid(), stage, old, "electron", log)
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                       timeout=120, capture_output=True)
    finally:
        k32.CloseHandle(h)
    text = log.read_text()
    assert "restoring the old ones" in text and "FAILED" in text, text
    assert sorted(p.relative_to(old).as_posix() for p in old.rglob("*")) == before
    assert (old / "_internal" / "python312.dll").read_bytes() == b"dll"
