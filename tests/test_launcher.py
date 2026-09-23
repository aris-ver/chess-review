"""The downloaded-file mark that stops .NET loading pywebview's assemblies (_unblock_bundle).
The stream itself is NTFS-only, so os.remove is faked here and the tests check which paths we go for."""

from pathlib import Path

import pytest

import launcher


def _tree(root, names):
    for name in names:
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")


def _collect(monkeypatch):
    tried = []
    monkeypatch.setattr(launcher.sys, "platform", "win32")
    monkeypatch.setattr(launcher.os, "remove", tried.append)
    return tried


def test_only_the_files_windows_would_refuse_to_load(tmp_path, monkeypatch):
    _tree(tmp_path, ["chess-review.exe", "_internal/pythonnet/runtime/Python.Runtime.dll",
                     "_internal/_ctypes.pyd", "_internal/build.json", "assets/book/a.tsv"])
    tried = _collect(monkeypatch)
    launcher._unblock_bundle(tmp_path, frozen=True)
    assert all(t.endswith(":Zone.Identifier") for t in tried)
    assert sorted(Path(t.rsplit(":", 1)[0]).name for t in tried) == [
        "Python.Runtime.dll", "_ctypes.pyd", "chess-review.exe"]


def test_a_source_checkout_is_left_alone(tmp_path, monkeypatch):
    _tree(tmp_path, ["a.dll"])
    tried = _collect(monkeypatch)
    launcher._unblock_bundle(tmp_path, frozen=False)
    assert tried == []


def test_not_windows_is_left_alone(tmp_path, monkeypatch):
    _tree(tmp_path, ["a.dll"])
    tried = []
    monkeypatch.setattr(launcher.sys, "platform", "linux")
    monkeypatch.setattr(launcher.os, "remove", tried.append)
    launcher._unblock_bundle(tmp_path, frozen=True)
    assert tried == []


@pytest.mark.parametrize("err", [FileNotFoundError, PermissionError, OSError])
def test_a_file_we_cannot_clear_does_not_stop_the_app(tmp_path, monkeypatch, err):
    """No stream is the normal case (FileNotFoundError) and a read-only install is a real one:
    either way the launcher carries on -- the mark may be on one file and not the next."""
    _tree(tmp_path, ["a.dll", "b.dll"])
    monkeypatch.setattr(launcher.sys, "platform", "win32")
    monkeypatch.setattr(launcher.os, "remove", lambda p: (_ for _ in ()).throw(err(p)))
    launcher._unblock_bundle(tmp_path, frozen=True)
