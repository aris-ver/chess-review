"""Stamp a PyInstaller output folder and zip it for release; build_windows.ps1 runs this last.

    python packaging/pack.py <dist>/chess-review --version v0.1.5 --out packaging/dist

Writes <app>/_internal/build.json = {version, runtime} and two zips, both wrapping a chess-review/ folder:

    chess-review-windows.zip            everything
    chess-review-update-<runtime>.zip   chess-review.exe, _internal/base_library.zip, _internal/build.json,
                                        _internal/chess_review/**, _internal/assets/**  -  the parts that
                                        change between most releases

<runtime> is a hash of every other file under _internal (the Python DLLs, the packages' .pyd/.dll files and
their data) except bin/ (Stockfish, which nothing in the exe is tied to). The exe's embedded .pyc code is
compiled against exactly those files, so a new exe can run on an existing install's _internal iff the hashes
agree - which is what chess_review/updater.py checks before taking the small zip. base_library.zip (the core
stdlib, compiled at build time) is PyInstaller output like the exe: its bytes differ from build to build
(.pyc headers carry source mtimes), so it travels with the exe instead of being fingerprinted.
"""

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ZIP_ROOT = "chess-review"
APP_DIRS = ("chess_review", "assets")     # app-owned data under _internal: in the update zip, not the fingerprint
GENERATED = ("base_library.zip",)         # PyInstaller output under _internal: same treatment
EXCLUDED = ("bin",)                       # in neither
STAMP = "build.json"
# Installs stamped with these fingerprints have the same runtime layer as the key: an earlier formula counted
# base_library.zip (v0.1.5 = a12c..., v0.1.6 = 9718...). While the current build fingerprints to the key, the
# update zip is also published under each of them, stamped with that name, since those installs' updater
# checks the stamp against its own. Once the runtime really changes they fall off and get a full download.
LEGACY = {"f3200f6c3b7a": ["a12c2bc291d5", "9718dcee7f79"]}


def runtime_fingerprint(internal: Path) -> str:
    h = hashlib.sha256()
    for f in sorted(p for p in internal.rglob("*") if p.is_file()):
        rel = f.relative_to(internal).as_posix()
        if rel == STAMP or rel in GENERATED or rel.split("/")[0] in APP_DIRS + EXCLUDED:
            continue
        h.update(rel.encode())
        h.update(hashlib.sha256(f.read_bytes()).digest())
    return h.hexdigest()[:12]


def update_files(app: Path):
    yield app / "chess-review.exe"
    yield app / "_internal" / STAMP
    yield from (app / "_internal" / g for g in GENERATED if (app / "_internal" / g).is_file())
    for d in APP_DIRS:
        yield from (p for p in (app / "_internal" / d).rglob("*") if p.is_file())


def write_zip(path: Path, app: Path, files, stamp: dict | None = None) -> None:
    """stamp replaces build.json's content in the zip (the alias zips; the file on disk keeps the real one)."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            name = f"{ZIP_ROOT}/{f.relative_to(app).as_posix()}"
            if stamp is not None and f.name == STAMP:
                z.writestr(name, json.dumps(stamp))
            else:
                z.write(f, name)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("app", type=Path, help="the PyInstaller output folder (contains chess-review.exe and _internal/)")
    p.add_argument("--version", required=True)
    p.add_argument("--out", type=Path, required=True, help="where the zips go")
    args = p.parse_args()
    app, internal = args.app, args.app / "_internal"
    if not (app / "chess-review.exe").is_file() or not internal.is_dir():
        raise SystemExit(f"{app} is not a chess-review build")

    runtime = runtime_fingerprint(internal)
    (internal / STAMP).write_text(json.dumps({"version": args.version, "runtime": runtime}), encoding="ascii")

    args.out.mkdir(parents=True, exist_ok=True)
    for old in args.out.glob("chess-review-*.zip"):
        old.unlink()
    full = args.out / "chess-review-windows.zip"
    update = args.out / f"chess-review-update-{runtime}.zip"
    write_zip(full, app, (f for f in app.rglob("*") if f.is_file()))
    write_zip(update, app, update_files(app))
    print(f"version {args.version}, runtime {runtime}")
    print(f"full:   {full} ({full.stat().st_size >> 20} MB)")
    print(f"update: {update} ({update.stat().st_size >> 20} MB)")
    for alias in LEGACY.get(runtime, []):
        path = args.out / f"chess-review-update-{alias}.zip"
        write_zip(path, app, update_files(app), stamp={"version": args.version, "runtime": alias})
        print(f"        {path} (same runtime, for installs stamped {alias})")


if __name__ == "__main__":
    main()
