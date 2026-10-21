"""The page's requests answered by the desktop's own serve.Handler, without a socket.

The page still asks for `api/...` and `p/<id>/...`; web/shim.js hands those to the Python worker instead of the
network, and handle() runs them through Handler.do_GET/do_POST with an in-memory request and response. Every
route, file and error message is the desktop's, so nothing of the logic is copied into JavaScript.

Works on CPython as well (tests/test_web_bridge.py); setup() is the Pyodide side.
"""

import http.client
import io
import json
import logging
from pathlib import Path
from typing import Optional

from chess_review import book, profiles, serve, site, updater
from chess_review.config import SITE_DIR

log = logging.getLogger("web.bridge")


class _Request(serve.Handler):
    """A Handler for one request held in memory: BaseHTTPRequestHandler's __init__ would read it off a socket."""

    def __init__(self, method: str, path: str, body: bytes, content_type: Optional[str]):
        self.command, self.path, self.request_version = method, path, "HTTP/1.0"
        self.requestline = f"{method} {path} HTTP/1.0"
        self.client_address, self.server, self.close_connection = ("browser", 0), None, True
        self.directory = str(SITE_DIR)
        head = f"Content-Length: {len(body)}\r\n" + (f"Content-Type: {content_type}\r\n" if content_type else "") + "\r\n"
        self.headers = http.client.parse_headers(io.BytesIO(head.encode("latin-1")))
        self.rfile, self.wfile = io.BytesIO(body), io.BytesIO()


def handle(method: str, path: str, body: bytes = b"", content_type: Optional[str] = None) -> tuple[int, list, bytes]:
    """(status, [(header, value)], body) for one request, as the desktop server would send it."""
    if method == "POST" and path.startswith("/api/sync/"):    # the web build's own: account sync (sync.py)
        from . import sync
        try:
            out = sync.handle(path, json.loads(bytes(body or b"{}") or b"{}"))
        except ValueError:
            out = None
        if out is None:
            return 400, [("Content-Type", "application/json")], b'{"error": "bad sync request"}'
        return 200, [("Content-Type", "application/json")], json.dumps(out).encode()
    req = _Request(method, path, bytes(body or b""), content_type)
    try:
        getattr(req, "do_" + method)()
    except Exception as e:  # noqa: BLE001 - the desktop server would log it and drop the connection
        log.exception("%s %s failed", method, path)
        return 500, [("Content-Type", "application/json")], json.dumps({"error": str(e)}).encode()
    raw = req.wfile.getvalue()
    head, _, payload = raw.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers = [tuple(line.split(": ", 1)) for line in lines[1:] if ": " in line]
    return status, headers, payload


def setup(app_dir: str, engines) -> None:
    """Pyodide start-up: what serve.main does before serving, minus the socket and the threads. `engines` is the
    JavaScript engine pool (web/engines.js)."""
    from .runner import WebRunner

    # The opening book's positions, worked out by scripts/build_web.py: reading the TSVs takes 8 s in Pyodide.
    keys = frozenset((Path(app_dir) / "book_keys.txt").read_text(encoding="utf-8").split("\n"))
    book.load = lambda: keys
    # site.build copies the page and its themes next to the profiles for the desktop server; here the page and
    # themes are the static site's own files
    site.write_static = lambda: None
    profiles.migrate_legacy()
    profiles.expire_shown()
    serve.Handler.runner = WebRunner(engines)
    serve.Handler.updates = updater.Updater()       # disabled outside the packaged desktop app
    serve.Handler.new_games = serve.NewGames()      # the new-games scan needs a thread: not yet


def handle_js(method: str, path: str, body=None, content_type: Optional[str] = None):
    """handle() for the worker: the body arrives as a Uint8Array, the reply leaves as a JS-friendly list."""
    if body is not None and hasattr(body, "to_bytes"):
        body = body.to_bytes()
    status, headers, payload = handle(method, path, body or b"", content_type)
    return [status, [list(h) for h in headers], payload]
