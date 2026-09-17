# PyInstaller spec for the Windows desktop build; packaging/build_windows.ps1 runs it (that script also
# fetches Stockfish, stages the opening book and creates the build venv). The build venv and the output
# must live on a local disk: .NET (which pywebview needs) refuses to load assemblies from a network
# path such as \\wsl.localhost\...

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH).parent  # repo root (this spec lives in packaging/)

datas, binaries, hiddenimports = [], [(str(ROOT / "packaging" / "bin" / "stockfish.exe"), "bin")], []
for pkg in ("webview", "pythonnet", "clr_loader"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
hiddenimports += collect_submodules("chess_review") + collect_submodules("chess")

a = Analysis(
    [str(ROOT / "launcher.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["pytest", "_pytest", "pygments"],
    noarchive=False,
)
a.datas += Tree(str(ROOT / "chess_review" / "static"), prefix="chess_review/static")
a.datas += Tree(str(ROOT / "packaging" / "assets" / "book"), prefix="assets/book")

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="chess-review",
    debug=False,
    strip=False,
    upx=False,
    console=False,   # native window only; logs go to %LOCALAPPDATA%\chess-review\app.log
    icon=str(ROOT / "packaging" / "chess-review.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="chess-review",
)
