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


# --- the exe's old names (_retire_old_exes) ---

def test_started_under_an_old_name_it_hands_over_to_blundr(tmp_path, monkeypatch):
    _tree(tmp_path, ["Blundr.exe", "Chess Review.exe"])
    started = []
    monkeypatch.setattr(launcher.sys, "platform", "win32")
    monkeypatch.setattr(launcher.subprocess, "Popen", lambda args, **kw: started.append(args))
    assert launcher._retire_old_exes(tmp_path / "Chess Review.exe", frozen=True) is True
    assert started == [[str(tmp_path / "Blundr.exe")]]


def test_started_as_blundr_it_deletes_the_old_names(tmp_path, monkeypatch):
    _tree(tmp_path, ["Blundr.exe", "Chess Review.exe", "chess-review.exe"])
    monkeypatch.setattr(launcher.sys, "platform", "win32")
    monkeypatch.setattr(launcher.threading, "Thread", lambda target, args, **kw: type("T", (), {"start": lambda s: target(*args)})())
    assert launcher._retire_old_exes(tmp_path / "Blundr.exe", frozen=True) is False
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Blundr.exe"]


def test_an_old_name_without_blundr_beside_it_just_runs(tmp_path, monkeypatch):
    _tree(tmp_path, ["Chess Review.exe"])
    monkeypatch.setattr(launcher.sys, "platform", "win32")
    assert launcher._retire_old_exes(tmp_path / "Chess Review.exe", frozen=True) is False
    assert launcher._retire_old_exes(tmp_path / "Blundr.exe", frozen=False) is False
