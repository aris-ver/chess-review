import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

import pytest

from chess_review import updater

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "packaging"))
import pack  # noqa: E402  packaging/pack.py: the build-side half of the update format


def test_parse_version():
    assert updater.parse_version("v0.1.5") == (0, 1, 5)
    assert updater.parse_version("0.2") == (0, 2)
    assert updater.parse_version("v0.1.4-3-gabc123") == (0, 1, 4)     # git describe on an untagged commit
    assert updater.parse_version("dev") is None
    assert updater.parse_version(None) is None
    assert updater.parse_version("v0.1.10") > updater.parse_version("v0.1.9")


RELEASE = {
    "tag_name": "v0.2.0", "html_url": "https://github.com/x/y/releases/tag/v0.2.0",
    "assets": [
        {"name": "chess-review-windows.zip", "browser_download_url": "https://dl/full.zip", "size": 100_000_000},
        {"name": "chess-review-update-abc123def456.zip", "browser_download_url": "https://dl/small.zip", "size": 3_000_000},
    ],
}


def test_pick_asset_prefers_the_small_zip_for_a_matching_runtime():
    a = updater.pick_asset(RELEASE, "abc123def456")
    assert (a["kind"], a["url"], a["size"]) == ("update", "https://dl/small.zip", 3_000_000)


def test_pick_asset_falls_back_to_the_full_zip():
    assert updater.pick_asset(RELEASE, "000000000000")["kind"] == "full"
    assert updater.pick_asset(RELEASE, None)["kind"] == "full"
    assert updater.pick_asset({"assets": []}, "abc123def456") is None


def _updater(monkeypatch, installed_version, runtime="abc123def456", release=RELEASE):
    monkeypatch.setattr(updater, "installed", lambda: {"version": installed_version, "runtime": runtime})
    monkeypatch.setattr(updater, "_fetch_latest", lambda: release)
    monkeypatch.setattr(updater.sys, "platform", "win32")
    return updater.Updater()


def test_check_reports_a_newer_release(monkeypatch):
    u = _updater(monkeypatch, "v0.1.4")
    u.check()
    s = u.status()
    assert s["enabled"] and s["newer"] and s["latest"] == "v0.2.0" and s["kind"] == "update" and s["size"] == 3_000_000


def test_check_is_quiet_when_up_to_date_or_ahead(monkeypatch):
    for v in ("v0.2.0", "v0.3.0", "v0.2.0-2-gdeadbee"):
        u = _updater(monkeypatch, v)
        u.check()
        assert not u.status()["newer"], v
        assert u.download() is False


def test_disabled_from_a_source_checkout(monkeypatch):
    u = _updater(monkeypatch, None)
    calls = []
    monkeypatch.setattr(updater, "_fetch_latest", lambda: calls.append(1))
    u.check()
    assert not u.enabled and not calls and u.status()["enabled"] is False


def test_check_survives_a_network_error(monkeypatch):
    u = _updater(monkeypatch, "v0.1.4")

    def boom():
        raise updater.requests.ConnectionError("offline")
    monkeypatch.setattr(updater, "_fetch_latest", boom)
    u.check()
    assert u.status()["check_error"] == "offline" and "newer" not in u.status()


# --- the zip format, built by packaging/pack.py and consumed by updater.unpack ---

def _fake_app(root: Path, version="v0.2.0", runtime_bytes=b"python-dll-v1") -> Path:
    app = root / "chess-review"
    (app / "_internal" / "chess_review" / "static").mkdir(parents=True)
    (app / "_internal" / "assets" / "book").mkdir(parents=True)
    (app / "_internal" / "bin").mkdir()
    (app / pack.EXE).write_bytes(b"exe " + version.encode())
    (app / "_internal" / "python312.dll").write_bytes(runtime_bytes)
    (app / "_internal" / "base_library.zip").write_bytes(b"stdlib pycs compiled at " + version.encode())
    (app / "_internal" / "chess_review" / "static" / "index.html").write_text(f"<html>{version}</html>")
    (app / "_internal" / "assets" / "book" / "a.tsv").write_text("eco\tname\n")
    (app / "_internal" / "bin" / "stockfish.exe").write_bytes(b"engine")
    return app


def test_fingerprint_ignores_app_files_build_output_and_stockfish(tmp_path):
    a = _fake_app(tmp_path / "a")
    b = _fake_app(tmp_path / "b", version="v9.9.9")     # different exe, static files and base_library.zip
    (b / "_internal" / "bin" / "stockfish.exe").write_bytes(b"newer engine")
    assert pack.runtime_fingerprint(a / "_internal") == pack.runtime_fingerprint(b / "_internal")
    c = _fake_app(tmp_path / "c", runtime_bytes=b"python-dll-v2")
    assert pack.runtime_fingerprint(a / "_internal") != pack.runtime_fingerprint(c / "_internal")


def _pack(app: Path, out: Path, version: str) -> tuple[Path, Path, str]:
    """pack.main() equivalent without argparse."""
    runtime = pack.runtime_fingerprint(app / "_internal")
    (app / "_internal" / pack.STAMP).write_text(json.dumps({"version": version, "runtime": runtime}))
    shutil.copy2(app / pack.EXE, app / pack.LEGACY_EXE)     # what pack.main() does: the transitional copy
    out.mkdir()
    full, small = out / "chess-review-windows.zip", out / f"chess-review-update-{runtime}.zip"
    pack.write_zip(full, app, (f for f in app.rglob("*") if f.is_file()))
    pack.write_zip(small, app, pack.update_files(app))
    return full, small, runtime


def test_update_zip_holds_only_the_app_layer(tmp_path):
    app = _fake_app(tmp_path / "build")
    full, small, runtime = _pack(app, tmp_path / "out", "v0.2.0")
    names = set(zipfile.ZipFile(small).namelist())
    assert names == {"chess-review/Chess Review.exe", "chess-review/chess-review.exe",
                     "chess-review/_internal/build.json", "chess-review/_internal/base_library.zip",
                     "chess-review/_internal/chess_review/static/index.html", "chess-review/_internal/assets/book/a.tsv"}
    assert "chess-review/_internal/python312.dll" in zipfile.ZipFile(full).namelist()
    assert "chess-review/_internal/bin/stockfish.exe" in zipfile.ZipFile(full).namelist()


def test_unpack_update(tmp_path):
    app = _fake_app(tmp_path / "build")
    _, small, runtime = _pack(app, tmp_path / "out", "v0.2.0")
    staged = updater.unpack(small, tmp_path / "stage", "update")
    assert staged == tmp_path / "stage" / "chess-review"
    assert (staged / "Chess Review.exe").read_bytes() == b"exe v0.2.0"
    assert json.loads((staged / "_internal" / "build.json").read_text())["version"] == "v0.2.0"


def test_both_exe_names_ship_so_an_older_updater_still_takes_the_zip(tmp_path):
    """Up to v0.1.11 the exe was chess-review.exe, and that install's updater -- the one that reads the
    zip -- rejects a build without it. Both names ship until those installs are gone."""
    app = _fake_app(tmp_path / "build")
    full, small, _ = _pack(app, tmp_path / "out", "v0.2.0")
    for z in (full, small):
        names = set(zipfile.ZipFile(z).namelist())
        assert {"chess-review/Chess Review.exe", "chess-review/chess-review.exe"} <= names
    staged = updater.unpack(small, tmp_path / "stage", "update")
    assert (staged / "chess-review.exe").read_bytes() == (staged / "Chess Review.exe").read_bytes()


def test_unpack_full_wants_a_python_runtime(tmp_path):
    app = _fake_app(tmp_path / "build")
    full, small, runtime = _pack(app, tmp_path / "out", "v0.2.0")
    assert (updater.unpack(full, tmp_path / "stage", "full") / "_internal" / "python312.dll").is_file()
    with pytest.raises(ValueError, match="Python runtime"):
        updater.unpack(small, tmp_path / "stage2", "full")


def test_unpack_rejects_entries_outside_the_app_folder(tmp_path):
    for bad in ("other/file", "chess-review/../x", "/etc/passwd"):
        z = tmp_path / "bad.zip"
        with zipfile.ZipFile(z, "w") as zf:
            zf.writestr(bad, "x")
        with pytest.raises(ValueError, match="unexpected entry"):
            updater.unpack(z, tmp_path / "stage", "update")


def test_unpack_accepts_backslash_entry_names(tmp_path):
    # Compress-Archive on older Windows PowerShell wrote them that way
    z = tmp_path / "bs.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("chess-review\\chess-review.exe", "exe")
        zf.writestr("chess-review\\_internal\\build.json", json.dumps({"version": "v1", "runtime": "rt"}))
        zf.writestr("chess-review\\_internal\\chess_review\\static\\index.html", "<html>")
    staged = updater.unpack(z, tmp_path / "stage", "update")
    assert (staged / "_internal" / "chess_review" / "static" / "index.html").read_text() == "<html>"


def test_apply_script_names_every_path_and_kind(tmp_path):
    p = updater.write_apply_script(tmp_path / "apply.ps1", 4242, tmp_path / "stage" / "chess-review",
                                   Path("C:/Apps/chess-review"), "update", tmp_path / "update.log")
    s = p.read_text(encoding="utf-8-sig")
    assert "Wait-Process -Id 4242" in s and "Replace-File" in s and "_internal.old" not in s
    assert "C:\\Apps\\chess-review" in s or "C:/Apps/chess-review" in s
    s = updater.write_apply_script(tmp_path / "apply.ps1", 1, tmp_path / "s", tmp_path / "i", "full",
                                   tmp_path / "log").read_text(encoding="utf-8-sig")
    assert "_internal.old" in s and "Start-Process" in s


@pytest.mark.skipif(sys.platform != "win32", reason="runs the generated PowerShell for real")
@pytest.mark.parametrize("kind", ["update", "full"])
def test_apply_script_swaps_the_install(tmp_path, kind):
    import shutil
    import subprocess
    system32 = Path(os.environ["SystemRoot"]) / "System32"
    old = _fake_app(tmp_path / "old", version="v0.1.0", runtime_bytes=b"old dll")
    new = _fake_app(tmp_path / "new", version="v0.2.0", runtime_bytes=b"old dll" if kind == "update" else b"new dll")
    # real (harmless, instantly exiting) exes so the script's final Start-Process has something to run
    shutil.copy(system32 / "where.exe", old / "chess-review.exe")
    shutil.copy(system32 / "whoami.exe", new / "chess-review.exe")
    (old / "_internal" / "leftover.pyd").write_bytes(b"gone after a full update")
    _, small, runtime = _pack(new, tmp_path / "out", "v0.2.0")
    (new / "_internal" / "leftover.pyd").unlink(missing_ok=True)
    full = tmp_path / "out" / "chess-review-windows.zip"
    stage = updater.unpack(small if kind == "update" else full, tmp_path / "stage", kind)

    gone = subprocess.Popen(["cmd", "/c", "exit"])   # a pid that has already exited: nothing to wait for
    gone.wait()
    log = tmp_path / "update.log"
    script = updater.write_apply_script(tmp_path / "apply.ps1", gone.pid, stage, old, kind, log)
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                   timeout=120, capture_output=True)

    assert "applied" in log.read_text(), log.read_text()
    assert (old / "chess-review.exe").read_bytes() == (system32 / "whoami.exe").read_bytes()
    assert (old / "_internal" / "chess_review" / "static" / "index.html").read_text() == "<html>v0.2.0</html>"
    assert json.loads((old / "_internal" / "build.json").read_text())["version"] == "v0.2.0"
    assert not (old / "_internal.old").exists() and not list(old.rglob("*.new"))
    assert not (tmp_path / "stage").exists()
    if kind == "update":
        assert (old / "_internal" / "leftover.pyd").exists()          # untouched: only the app layer was replaced
        assert (old / "_internal" / "python312.dll").read_bytes() == b"old dll"
    else:
        assert not (old / "_internal" / "leftover.pyd").exists()      # the whole runtime was swapped
        assert (old / "_internal" / "python312.dll").read_bytes() == b"new dll"
        assert (old / "_internal" / "bin" / "stockfish.exe").exists()


def test_download_fetches_unpacks_and_reports(tmp_path, monkeypatch):
    import functools
    import http.server
    import threading
    import time
    app = _fake_app(tmp_path / "build")
    _, small, runtime = _pack(app, tmp_path / "out", "v0.2.0")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(tmp_path / "out")))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        release = {"tag_name": "v0.2.0", "html_url": "x", "assets": [
            {"name": small.name, "browser_download_url": f"http://127.0.0.1:{srv.server_port}/{small.name}",
             "size": small.stat().st_size}]}
        monkeypatch.setattr(updater, "UPDATE_DIR", tmp_path / "data" / "update")
        u = _updater(monkeypatch, "v0.1.0", runtime, release)
        u.check()
        assert u.download() is True
        assert u.download() is False                      # already in flight
        for _ in range(100):
            if u.state in ("ready", "error"):
                break
            time.sleep(0.05)
        assert u.state == "ready", u.error
        s = u.status()
        assert s["done"] == s["total"] == small.stat().st_size
        assert (u.stage / "chess-review.exe").read_bytes() == b"exe v0.2.0"
        assert not list((tmp_path / "data" / "update").glob("*.zip"))     # the zip is gone once unpacked
    finally:
        srv.shutdown()
