"""Assemble the browser version (docs/web.md) into web-dist/, a static site.

    python scripts/build_web.py [--serve [--port 8200]] [--engine-wasm URL|cdn]

web-dist/
  index.html            chess_review/static/index.html as site.write_static makes it, plus the web/shim.js tag
  account.js            the Blundr account, from chess_review/static/ (the desktop app has the same one)
  privacy.html, terms.html   from web/pages/
  manifest.json, icons/ what "Add to Home Screen" installs (icons from web/icons/, rendered from its icon.svg)
  themes/               the page's pieces, boards and sounds
  app.zip               chess_review (minus static/, sound_packs/ and the puzzle pack's parquet) + web/py/chess_web
                        + book_keys.txt, unpacked into Pyodide (240 KB)
  puzzles.json          the same puzzle pack, readable before DuckDB has loaded; fetched alongside Python
  web/                  shim.js, py-worker.js, engines.js, config.js, the python-chess wheel, engine/ (Stockfish 19)

Downloads (cached in data/web-cache): python-chess's wheel (PyPI has only its sdist) and npm stockfish@19.0.1.
--engine-wasm points the full engine at another host (the Worker refuses files over 25 MiB); `--engine-wasm cdn` is
blundr.gr's: the same npm package's file on unpkg. By default it is served from web/engine/ next to the rest, which is
what --serve wants.
"""

import argparse
import functools
import io
import json
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import chess.svg  # noqa: E402

from chess_review import book, puzzles  # noqa: E402

OUT = ROOT / "web-dist"
CACHE = ROOT / "data" / "web-cache"
PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/"
CHESS_VERSION = "1.11.2"
STOCKFISH_VERSION = "19.0.1"      # the same Stockfish as the desktop's bin/: change both together, or reviews stop matching
STOCKFISH_NPM = f"https://registry.npmjs.org/stockfish/-/stockfish-{STOCKFISH_VERSION}.tgz"
# the full engine (95 MB) as visitors download it: unpkg serves npm files of any size, with CORS and a year's cache
ENGINE_CDN = f"https://unpkg.com/stockfish@{STOCKFISH_VERSION}/bin/stockfish-19-single.wasm"
ENGINE_FILES = ("stockfish-19-single.js", "stockfish-19-single.wasm", "stockfish-19-lite-single.js",
                "stockfish-19-lite-single.wasm")


def chess_wheel() -> Path:
    whl = CACHE / f"chess-{CHESS_VERSION}-py3-none-any.whl"
    if not whl.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        subprocess.run([sys.executable, "-m", "pip", "wheel", "--no-deps", f"chess=={CHESS_VERSION}", "-w", str(CACHE)],
                       check=True)
    return whl


def engine_files() -> dict[str, Path]:
    out = {name: CACHE / "stockfish" / name for name in ENGINE_FILES}
    if not all(p.exists() for p in out.values()):
        print("downloading", STOCKFISH_NPM)
        data = urllib.request.urlopen(STOCKFISH_NPM).read()
        (CACHE / "stockfish").mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            for m in tar.getmembers():
                name = Path(m.name).name
                if name in out and m.isfile():
                    out[name].write_bytes(tar.extractfile(m).read())
        missing = [n for n, p in out.items() if not p.exists()]
        if missing:
            raise SystemExit(f"not in {STOCKFISH_NPM}: {missing}")
    return out


def copy_if_changed(src: Path, dst: Path) -> None:
    if not dst.exists() or dst.stat().st_size != src.stat().st_size or dst.stat().st_mtime < src.stat().st_mtime:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


NAME = "Blundr"     # the web app's name (blundr.gr); the desktop app stays "Chess Review"
RENAME = ("<title>Chess Review</title>", '<span id="home-t">Chess Review</span>', "home ? 'Chess Review' : 'Home'",
          "`Chess Review puzzle of the day")
BG = "#302e2b"      # the page's --bg: the status bar and the splash while it loads
# Added to the home screen (iPhone: Share > Add to Home Screen; Android: Install app) the site opens full screen with
# its own icon. iOS reads the apple-* tags, everything else the manifest. No service worker: it stays an online site.
HEAD = f"""<link rel="manifest" href="manifest.json">
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="theme-color" content="{BG}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="{NAME}">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
"""
MANIFEST = {"name": NAME, "short_name": NAME, "description": "Chess game review and puzzles",
            "start_url": "/", "scope": "/", "display": "standalone", "background_color": BG, "theme_color": BG,
            "icons": [{"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
                      {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"}]}


def page() -> str:
    html = (ROOT / "chess_review" / "static" / "index.html").read_text(encoding="utf-8")
    html = html.replace("/*__PIECES__*/", json.dumps(chess.svg.PIECES))
    for s in RENAME:    # each must still be there, so a change to the page can't leave the old name showing
        if s not in html:
            raise SystemExit(f"index.html no longer has {s!r}: update RENAME in {Path(__file__).name}")
        html = html.replace(s, s.replace("Chess Review", NAME))
    t = html.index("</title>") + len("</title>\n")
    html = html[:t] + HEAD + html[t:]
    i = html.index("<script")       # before the page's own scripts (account.js first): the first fetch must already be redirected
    return html[:i] + '<script src="web/shim.js"></script>\n' + html[i:]


def app_zip(dst: Path) -> None:
    keys = sorted(book.load())
    if not keys:
        raise SystemExit(f"no opening book in {book.BOOK_DIR} (scripts/fetch_book.sh)")
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        pkg = ROOT / "chess_review"
        for f in sorted(pkg.rglob("*")):
            rel = f.relative_to(pkg)
            # static/ is the site itself, sound_packs/ only a source for the themes' sounds
            if (f.is_file() and rel.parts[0] not in ("static", "sound_packs") and "__pycache__" not in rel.parts
                    and f != puzzles.PACK):
                z.write(f, "chess_review/" + rel.as_posix())
        web = ROOT / "web" / "py"
        for f in sorted(web.rglob("*.py")):
            z.write(f, f.relative_to(web).as_posix())
        z.writestr("book_keys.txt", "\n".join(keys))
    # the puzzle pack beside it, not in it: the worker fetches it alongside Python (the Worker sends it compressed)
    (dst.parent / "puzzles.json").write_text(json.dumps(puzzles.PACK_INSTANCE._read(), separators=(",", ":")),
                                             encoding="utf-8")


def build(engine_wasm: str | None) -> None:
    OUT.mkdir(exist_ok=True)
    (OUT / "index.html").write_text(page(), encoding="utf-8")
    copy_if_changed(ROOT / "chess_review" / "static" / "account.js", OUT / "account.js")
    (OUT / "web" / "account.js").unlink(missing_ok=True)       # where builds before the desktop app had it
    themes = ROOT / "chess_review" / "static" / "themes"
    for f in themes.rglob("*"):
        if f.is_file():
            copy_if_changed(f, OUT / "themes" / f.relative_to(themes))
    for f in (ROOT / "web" / "pages").glob("*.html"):      # privacy.html, terms.html: plain pages at the site's root
        copy_if_changed(f, OUT / f.name)
        if '<span class="fill">' in f.read_text(encoding="utf-8"):
            print(f"warning: {f.relative_to(ROOT)} still has placeholders (class=fill) to fill in before going live")
    for f in (ROOT / "web" / "icons").iterdir():
        copy_if_changed(f, OUT / "icons" / f.name)
    (OUT / "manifest.json").write_text(json.dumps(MANIFEST, indent=1), encoding="utf-8")
    for f in (ROOT / "web").glob("*.js"):
        copy_if_changed(f, OUT / "web" / f.name)
    whl = chess_wheel()
    copy_if_changed(whl, OUT / "web" / whl.name)
    engines = engine_files()
    for name, src in engines.items():
        dst = OUT / "web" / "engine" / name
        if engine_wasm and name == "stockfish-19-single.wasm":     # served from elsewhere (unpkg): too big for the Worker
            dst.unlink(missing_ok=True)
            continue
        copy_if_changed(src, dst)
    # The Worker (worker/, wrangler) serves web-dist/ but refuses files over 25 MiB: the full engine comes from unpkg.
    (OUT / ".assetsignore").write_text("web/engine/stockfish-19-single.wasm\n", encoding="utf-8")
    app_zip(OUT / "app.zip")
    # engineBytes: the progress bar's total, as unpkg sends no Content-Length; engineName: what the notice says it is
    config = {"pyodide": PYODIDE, "chessWheel": whl.name, "engineWasm": engine_wasm or "engine/stockfish-19-single.wasm",
              "engineBytes": engines["stockfish-19-single.wasm"].stat().st_size,
              "engineLiteWasm": "engine/stockfish-19-lite-single.wasm",
              "engineLiteBytes": engines["stockfish-19-lite-single.wasm"].stat().st_size,
              "engineName": f"Stockfish {STOCKFISH_VERSION.split('.')[0]}"}
    (OUT / "web" / "config.js").write_text(f"self.CR_CONFIG = {json.dumps(config, indent=1)};\n", encoding="utf-8")
    print("built", OUT)


class _Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript",
                      ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".webp": "image/webp"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--serve", action="store_true", help="serve web-dist/ on localhost after building")
    p.add_argument("--port", type=int, default=8200)
    p.add_argument("--engine-wasm", help="URL of stockfish-19-single.wasm, or cdn for unpkg (default: served with the site)")
    args = p.parse_args()
    build(ENGINE_CDN if args.engine_wasm == "cdn" else args.engine_wasm)
    if args.serve:
        srv = ThreadingHTTPServer(("127.0.0.1", args.port), functools.partial(_Handler, directory=str(OUT)))
        print(f"serving http://127.0.0.1:{args.port}/")
        srv.serve_forever()


if __name__ == "__main__":
    main()
