"""Assemble the browser version (docs/web.md) into web-dist/, a static site.

    python scripts/build_web.py [--serve [--port 8200]] [--engine-wasm URL|cdn]

web-dist/
  index.html            chess_review/static/index.html as site.write_static makes it, plus the web/shim.js tag
  account.js            the Blundr account, from chess_review/static/ (the desktop app has the same one)
  privacy.html, terms.html   from web/pages/
  manifest.json, icons/ what "Add to Home Screen" installs (icons from web/icons/, rendered from packaging/chess-review.ico)
  themes/               the page's pieces, boards and sounds
  js/                   the JS server as the desktop runs it: js/core, js/server (minus the Node adapters), js/web (the
                        worker, its tabs, the browser adapters), js/vendor (chessops, SQLite WASM); no tests
  web/                  shim.js, engines.js, config.js, engine/ (Stockfish 19)
  book_keys.txt         the opening book's positions, one fen_key a line (js/core/book.js)
  puzzles.json          the Lichess puzzle pack, fetched alongside the app; packs.json, the puzzle packs
  legacy/               the one-time move from the Python build's data (js/web/legacy.js): app.zip (only what
                        chess_review/migrate_sqlite.py needs) and python-chess's wheel, with Pyodide from its CDN.
                        Fetched only by a browser that still has the Python build's IndexedDB, and only once.

Downloads (cached in data/web-cache): python-chess's wheel (PyPI has only its sdist) and npm stockfish@19.0.1.
--engine-wasm points the full engine at another host (the Worker refuses files over 25 MiB); `--engine-wasm cdn` is
blundr.gr's: the same npm package's file on unpkg. By default it is served from web/engine/ next to the rest, which is
what --serve wants.
"""

import argparse
import functools
import io
import json
import re
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
# Pyodide and python-chess only for the one-time move from the Python build's data (legacy/, js/web/legacy.js): the
# Pyodide that wrote that IndexedDB, so its IDBFS layout reads back as it was written
LEGACY_PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/"
CHESS_VERSION = "1.11.2"
# what chess_review/migrate_sqlite.py imports: all the legacy app.zip holds
LEGACY_MODULES = ("__init__.py", "config.py", "fen.py", "migrate_sqlite.py")
# js/ as the browser gets it: no tests, no Node adapters, no Electron
JS_DIRS = ("core", "server", "web", "vendor")
JS_SKIP = (".test.js", "-node.js", ".md")
# File names that ad blockers' privacy lists block on sight (EasyPrivacy has /analyse.js, /stats.js, /track.js ...):
# a module of the worker with such a name doesn't load where one is installed, and Blundr never starts there.
BLOCKED_NAME = re.compile(r"analy[sz]|track|stats?\b|statistic|metric|telemetr|beacon|pixel|advert|(^|[-_.])ads?([-_.]|$)"
                          r"|counter|collect|insight|fingerprint", re.I)
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


NAME = "Blundr"     # the app's name, on blundr.gr and on Windows
BG = "#302e2b"      # the page's --bg: the status bar and the splash while it loads
# Added to the home screen (iPhone: Share > Add to Home Screen; Android: Install app) the site opens full screen with
# its own icon. iOS reads the apple-* tags, everything else the manifest. No service worker: it stays an online site.
HEAD = f"""<link rel="manifest" href="manifest.json">
<link rel="icon" href="icons/favicon-32.png" type="image/png">
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
    t = html.index("</title>") + len("</title>\n")
    html = html[:t] + HEAD + html[t:]
    i = html.index("<script")       # before the page's own scripts (account.js first): the first fetch must already be redirected
    return html[:i] + '<script src="web/shim.js"></script>\n' + html[i:]


def data_files(out: Path) -> None:
    """What the JS server reads besides its code: the opening book's keys, the Lichess puzzle pack and the packs."""
    keys = sorted(book.load())
    if not keys:
        raise SystemExit(f"no opening book in {book.BOOK_DIR} (scripts/fetch_book.sh)")
    (out / "book_keys.txt").write_text("\n".join(keys), encoding="utf-8")
    # beside the code, fetched alongside it (the Worker sends it compressed: 8 MB of JSON, about 2 MB as sent)
    (out / "puzzles.json").write_text(json.dumps(puzzles.PACK_INSTANCE._read(), separators=(",", ":")), encoding="utf-8")
    copy_if_changed(ROOT / "chess_review" / "puzzle_packs" / "packs.json", out / "packs.json")


def js_tree(out: Path) -> None:
    """js/ as the browser imports it, and nothing left from a build before (a module removed from js/)."""
    want = set()
    for d in JS_DIRS:
        for f in sorted((ROOT / "js" / d).rglob("*")):
            if f.is_file() and not f.name.endswith(JS_SKIP):
                rel = f.relative_to(ROOT / "js")
                if BLOCKED_NAME.search(f.name):
                    sys.exit(f"js/{rel}: ad blockers block a file of that name, so the worker would not load "
                             "where one is installed. Rename it.")
                want.add(rel)
                copy_if_changed(f, out / "js" / rel)
    if (out / "js").exists():
        for f in (out / "js").rglob("*"):
            if f.is_file() and f.relative_to(out / "js") not in want:
                f.unlink()


def legacy(out: Path) -> dict:
    """The one-time move from the Python build's IndexedDB (js/web/legacy.js): migrate_sqlite and what it imports,
    python-chess's wheel, and Pyodide's URL. Returns config.js's `legacy` entry."""
    dst = out / "legacy"
    dst.mkdir(exist_ok=True)
    with zipfile.ZipFile(dst / "app.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for name in LEGACY_MODULES:
            z.write(ROOT / "chess_review" / name, "chess_review/" + name)
    whl = chess_wheel()
    copy_if_changed(whl, dst / whl.name)
    return {"pyodide": LEGACY_PYODIDE, "wheel": f"legacy/{whl.name}", "app": "legacy/app.zip"}


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
    # browsers ask for /favicon.ico on their own (address-bar suggestions, history), whatever the page links
    copy_if_changed(ROOT / "packaging" / "chess-review.ico", OUT / "favicon.ico")
    (OUT / "manifest.json").write_text(json.dumps(MANIFEST, indent=1), encoding="utf-8")
    for f in (ROOT / "web").glob("*.js"):
        copy_if_changed(f, OUT / "web" / f.name)
    # what the Python builds shipped: Pyodide's worker, the app's zip, python-chess's wheel
    for old in [OUT / "app.zip", OUT / "web" / "py-worker.js", *(OUT / "web").glob("chess-*.whl")]:
        old.unlink(missing_ok=True)
    js_tree(OUT)
    data_files(OUT)
    engines = engine_files()
    for name, src in engines.items():
        dst = OUT / "web" / "engine" / name
        if engine_wasm and name == "stockfish-19-single.wasm":     # served from elsewhere (unpkg): too big for the Worker
            dst.unlink(missing_ok=True)
            continue
        copy_if_changed(src, dst)
    # The Worker (worker/, wrangler) serves web-dist/ but refuses files over 25 MiB: the full engine comes from unpkg.
    (OUT / ".assetsignore").write_text("web/engine/stockfish-19-single.wasm\n", encoding="utf-8")
    # engineBytes: the progress bar's total, as unpkg sends no Content-Length; engineName: what the notice says it is
    config = {"legacy": legacy(OUT), "engineWasm": engine_wasm or "engine/stockfish-19-single.wasm",
              "engineBytes": engines["stockfish-19-single.wasm"].stat().st_size,
              "engineLiteWasm": "engine/stockfish-19-lite-single.wasm",
              "engineLiteBytes": engines["stockfish-19-lite-single.wasm"].stat().st_size,
              "engineName": f"Stockfish {STOCKFISH_VERSION.split('.')[0]}"}
    (OUT / "web" / "config.js").write_text(f"self.CR_CONFIG = {json.dumps(config, indent=1)};\n", encoding="utf-8")
    print("built", OUT)


class _Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript",
                      ".mjs": "text/javascript",
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
