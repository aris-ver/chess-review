"""Assemble the browser version (docs/web.md) into web-dist/, a static site.

    python scripts/build_web.py [--serve [--port 8200]] [--engine-wasm URL]

web-dist/
  index.html            chess_review/static/index.html as site.write_static makes it, plus the web/shim.js and
                        web/account.js tags
  privacy.html, terms.html   from web/pages/
  themes/               the page's pieces, boards and sounds
  app.zip               chess_review (minus static/) + web/py/chess_web + book_keys.txt, unpacked into Pyodide
  web/                  shim.js, py-worker.js, engines.js, config.js, the python-chess wheel, engine/ (Stockfish 19)

Downloads (cached in data/web-cache): python-chess's wheel (PyPI has only its sdist) and npm stockfish@19.0.1.
--engine-wasm points the full engine at another host (R2: Pages refuses files over 25 MB); by default it is
served from web/engine/ next to the rest, which is what --serve wants.
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

from chess_review import book  # noqa: E402

OUT = ROOT / "web-dist"
CACHE = ROOT / "data" / "web-cache"
PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/"
CHESS_VERSION = "1.11.2"
STOCKFISH_NPM = "https://registry.npmjs.org/stockfish/-/stockfish-19.0.1.tgz"
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


def page() -> str:
    html = (ROOT / "chess_review" / "static" / "index.html").read_text(encoding="utf-8")
    html = html.replace("/*__PIECES__*/", json.dumps(chess.svg.PIECES))
    for s in RENAME:    # each must still be there, so a change to the page can't leave the old name showing
        if s not in html:
            raise SystemExit(f"index.html no longer has {s!r}: update RENAME in {Path(__file__).name}")
        html = html.replace(s, s.replace("Chess Review", NAME))
    i = html.index("<script")       # before the page's own scripts: the first fetch must already be redirected
    return html[:i] + '<script src="web/shim.js"></script>\n<script src="web/account.js"></script>\n' + html[i:]


def app_zip(dst: Path) -> None:
    keys = sorted(book.load())
    if not keys:
        raise SystemExit(f"no opening book in {book.BOOK_DIR} (scripts/fetch_book.sh)")
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        pkg = ROOT / "chess_review"
        for f in sorted(pkg.rglob("*")):
            rel = f.relative_to(pkg)
            if f.is_file() and rel.parts[0] != "static" and "__pycache__" not in rel.parts:
                z.write(f, "chess_review/" + rel.as_posix())
        web = ROOT / "web" / "py"
        for f in sorted(web.rglob("*.py")):
            z.write(f, f.relative_to(web).as_posix())
        z.writestr("book_keys.txt", "\n".join(keys))


def build(engine_wasm: str | None) -> None:
    OUT.mkdir(exist_ok=True)
    (OUT / "index.html").write_text(page(), encoding="utf-8")
    themes = ROOT / "chess_review" / "static" / "themes"
    for f in themes.rglob("*"):
        if f.is_file():
            copy_if_changed(f, OUT / "themes" / f.relative_to(themes))
    for f in (ROOT / "web" / "pages").glob("*.html"):      # privacy.html, terms.html: plain pages at the site's root
        copy_if_changed(f, OUT / f.name)
        if "[[" in f.read_text(encoding="utf-8"):
            print(f"warning: {f.relative_to(ROOT)} still has [[placeholders]] to fill in before going live")
    for f in (ROOT / "web").glob("*.js"):
        copy_if_changed(f, OUT / "web" / f.name)
    whl = chess_wheel()
    copy_if_changed(whl, OUT / "web" / whl.name)
    for name, src in engine_files().items():
        dst = OUT / "web" / "engine" / name
        if engine_wasm and name == "stockfish-19-single.wasm":     # served from elsewhere (R2): too big for Pages
            dst.unlink(missing_ok=True)
            continue
        copy_if_changed(src, dst)
    # The Worker (worker/, wrangler) serves web-dist/ but refuses files over 25 MiB: the full engine goes to R2.
    (OUT / ".assetsignore").write_text("web/engine/stockfish-19-single.wasm\n", encoding="utf-8")
    app_zip(OUT / "app.zip")
    config = {"pyodide": PYODIDE, "chessWheel": whl.name, "engineWasm": engine_wasm or "engine/stockfish-19-single.wasm"}
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
    p.add_argument("--engine-wasm", help="URL of stockfish-19-single.wasm (default: served with the site)")
    args = p.parse_args()
    build(args.engine_wasm)
    if args.serve:
        srv = ThreadingHTTPServer(("127.0.0.1", args.port), functools.partial(_Handler, directory=str(OUT)))
        print(f"serving http://127.0.0.1:{args.port}/")
        srv.serve_forever()


if __name__ == "__main__":
    main()
