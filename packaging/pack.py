"""Stamp a PyInstaller output folder and zip it for release; build_windows.ps1 runs this last.

    python packaging/pack.py <dist>/chess-review --version v0.1.5 --out packaging/dist

Writes <app>/_internal/build.json = {version, runtime} and three zips:

    Blundr-windows.zip                  everything but the old exe names, in a Blundr/ folder: what a new user
                                        downloads
    chess-review-windows.zip            everything, in a chess-review/ folder: the full zip as updaters up to
                                        v0.6.0 look for it (an install whose runtime no longer matches)
    chess-review-update-<runtime>.zip   the exes, _internal/base_library.zip, _internal/build.json,
                                        _internal/chess_review/**, _internal/assets/**  -  the parts that
                                        change between most releases, in a chess-review/ folder

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
import shutil
import zipfile
from pathlib import Path

ZIP_ROOT = "chess-review"                  # what every updater so far unpacks
FULL_ROOT = "Blundr"                       # the folder a new user unzips
FULL_ZIP = "Blundr-windows.zip"
LEGACY_FULL_ZIP = "chess-review-windows.zip"
EXE = "Blundr.exe"
# What the exe was called before: chess-review.exe up to v0.1.11, "Chess Review.exe" up to v0.5.6. An updater from
# such an install looks for its own name (refusing a zip without it, and starting that exe again once updated), so
# the zips updaters take ship a byte-identical copy under each. The app, started under one, hands over to Blundr.exe,
# which deletes them (launcher._retire_old_exes).
LEGACY_EXES = ("Chess Review.exe", "chess-review.exe")
APP_DIRS = ("chess_review", "assets")     # app-owned data under _internal: in the update zip, not the fingerprint
GENERATED = ("base_library.zip",)         # PyInstaller output under _internal: same treatment
EXCLUDED = ("bin",)                       # in neither
STAMP = "build.json"


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
    yield app / EXE
    yield from (app / n for n in LEGACY_EXES if (app / n).is_file())
    yield app / "_internal" / STAMP
    yield from (app / "_internal" / g for g in GENERATED if (app / "_internal" / g).is_file())
    for d in APP_DIRS:
        yield from (p for p in (app / "_internal" / d).rglob("*") if p.is_file())


def write_zip(path: Path, app: Path, files, root: str = ZIP_ROOT) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, f"{root}/{f.relative_to(app).as_posix()}")


def write_zips(app: Path, out: Path, runtime: str) -> tuple[Path, Path, Path]:
    """The new user's full zip, the full zip for older updaters, the update zip."""
    out.mkdir(parents=True, exist_ok=True)
    for old in [*out.glob("chess-review-*.zip"), *out.glob("Blundr-*.zip")]:
        old.unlink()
    everything = [f for f in app.rglob("*") if f.is_file()]
    full, legacy, update = out / FULL_ZIP, out / LEGACY_FULL_ZIP, out / f"chess-review-update-{runtime}.zip"
    write_zip(full, app, (f for f in everything if f.parent != app or f.name not in LEGACY_EXES), FULL_ROOT)
    write_zip(legacy, app, everything)
    write_zip(update, app, update_files(app))
    return full, legacy, update


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("app", type=Path, help="the PyInstaller output folder (contains the exe and _internal/)")
    p.add_argument("--version", required=True)
    p.add_argument("--out", type=Path, required=True, help="where the zips go")
    args = p.parse_args()
    app, internal = args.app, args.app / "_internal"
    if not (app / EXE).is_file() or not internal.is_dir():
        raise SystemExit(f"{app} is not a chess-review build")
    for name in LEGACY_EXES:                     # the transitional duplicates; not part of the fingerprint
        shutil.copy2(app / EXE, app / name)

    runtime = runtime_fingerprint(internal)
    (internal / STAMP).write_text(json.dumps({"version": args.version, "runtime": runtime}), encoding="ascii")

    full, legacy, update = write_zips(app, args.out, runtime)
    print(f"version {args.version}, runtime {runtime}")
    print(f"full:   {full} ({full.stat().st_size >> 20} MB)")
    print(f"legacy: {legacy} ({legacy.stat().st_size >> 20} MB)")
    print(f"update: {update} ({update.stat().st_size >> 20} MB)")


if __name__ == "__main__":
    main()
