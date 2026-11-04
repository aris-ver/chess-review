"""A stand-in for Lichess's OAuth, for trying the Blundr account locally without a real Lichess login.

    python scripts/fake_lichess.py [--port 8788]
    cd worker && echo LICHESS_URL=http://localhost:8788 >> .dev.vars && npm run dev

Its sign-in page asks for any username and hands it back as the code; the token is the username and /api/account
answers with it, so each name you type is a different Lichess account.
"""

import argparse
import html
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body=b"", ctype="application/json", headers=()):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/oauth" and "user" in q:
            back = q["redirect_uri"] + "?" + urlencode({"code": q["user"], "state": q.get("state", "")})
            return self._send(302, headers=[("Location", back)])
        if url.path == "/oauth":
            hidden = "".join(f'<input type="hidden" name="{html.escape(k)}" value="{html.escape(v)}">' for k, v in q.items())
            page = (f"<h3>Fake Lichess</h3><p>{html.escape(q.get('client_id', ''))} wants to sign you in.</p>"
                    f'<form>{hidden}<input name="user" value="TestPlayer" autofocus> <button>Authorize</button></form>'
                    f'<p><a href="{html.escape(q["redirect_uri"])}?error=access_denied&state={html.escape(q.get("state", ""))}">Cancel</a></p>')
            return self._send(200, page.encode(), "text/html; charset=utf-8")
        if url.path == "/api/account":
            user = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if not user:
                return self._send(401, b"{}")
            return self._send(200, json.dumps({"id": user.lower(), "username": user}).encode())
        self._send(404, b"{}")

    def do_POST(self):
        if urlparse(self.path).path == "/api/token":
            form = parse_qs(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode())
            return self._send(200, json.dumps({"access_token": form.get("code", [""])[0], "token_type": "Bearer"}).encode())
        self._send(404, b"{}")

    def do_DELETE(self):
        self._send(204)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8788)
    args = p.parse_args()
    print(f"fake Lichess on http://localhost:{args.port}/")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
