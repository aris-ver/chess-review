"""The desktop app's way to the Blundr account (docs/accounts.md). static/account.js is the same page code on the website
and here: on the website its account/* requests reach the Worker (worker/src/index.js) with the session cookie; here
they come to serve.py, which hands them to handle(), and go on to the Worker at BLUNDR_URL with the session token kept
in DATA/account_token.json. Only this module sees the token; the page never does.

    GET  /account/me                  the Worker's answer, plus {app: true, site, outcome}: outcome is how a sign-in in
                                      the browser ended (once), for the page that waits for it
    POST /account/app/login/<p>       {mode, consent}: a Lichess or Google sign-in, opened in the system browser
    GET  /account/callback            the browser, back from blundr.gr: its one-time code swapped for the token
    POST /account/app/export          everything the account keeps, saved to the Downloads folder
    anything else under /account/     passed on as it is (email and password, progress, logout, unlink, delete)

A provider sign-in can't run in the app's own window (Google refuses embedded webviews), so it runs in the browser:
the Worker does the provider round trip as it does for the website, then sends the browser to this server's loopback
address with a code instead of setting a cookie, and only this app, holding the PKCE verifier, can swap that code for
a session token.
"""

import base64
import hashlib
import json
import logging
import os
import secrets
import threading
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

import requests

from .config import DATA, USER_AGENT

log = logging.getLogger("account")

SITE = os.environ.get("BLUNDR_URL", "https://blundr.gr").rstrip("/")    # http://localhost:8787 for wrangler dev
TOKEN_FILE = DATA / "account_token.json"
TIMEOUT = 20

_lock = threading.Lock()
_pending: Optional[dict] = None     # the provider sign-in open in the browser: {state, verifier}
_outcome: Optional[str] = None      # how the last one ended, until the page asks


def load_token() -> Optional[str]:
    """The session token for SITE, if signed in (one kept for another BLUNDR_URL doesn't count)."""
    try:
        d = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d.get("token") if d.get("site") == SITE else None


def save_token(token: Optional[str]) -> None:
    if not token:
        TOKEN_FILE.unlink(missing_ok=True)
        return
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = TOKEN_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"site": SITE, "token": token}), encoding="utf-8")
    os.replace(tmp, TOKEN_FILE)


def _call(method: str, path: str, body: Optional[bytes] = None) -> requests.Response:
    """The Worker's answer to one request, as the app: its own header (the Worker's stand-in for the site's Origin), and
    the token if there is one."""
    headers = {"X-Blundr-App": "1", "User-Agent": USER_AGENT, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token := load_token():
        headers["Authorization"] = f"Bearer {token}"
    r = requests.request(method, SITE + path, data=body, headers=headers, timeout=TIMEOUT, allow_redirects=False)
    if r.status_code == 401 and token:
        save_token(None)        # the session ended elsewhere (logged out, a new password, the account deleted)
    return r


def _json(obj, code: int = 200) -> tuple[int, str, bytes]:
    return code, "application/json", json.dumps(obj).encode()


def _passed(r: requests.Response) -> tuple[int, str, bytes]:
    return r.status_code, r.headers.get("Content-Type", "application/json"), r.content


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def handle(method: str, path: str, query: str, body: Optional[bytes], port: int) -> tuple[int, str, bytes]:
    """(status, content type, body) for the page's account/* request. Raises requests.RequestException when
    blundr.gr can't be reached."""
    global _pending, _outcome
    if method == "GET" and path == "/account/me":
        r = _call("GET", path)
        if not r.ok:
            return _passed(r)
        d = r.json()
        if d.get("user") is None:
            save_token(None)
        with _lock:
            d.update(app=True, site=SITE, outcome=_outcome)
            _outcome = None
        return _json(d)

    if method == "POST" and path.startswith("/account/app/login/"):
        b = json.loads(body or b"{}")
        verifier = secrets.token_urlsafe(48)
        r = _call("POST", "/account/app/start", json.dumps({
            "provider": path.rsplit("/", 1)[-1], "mode": b.get("mode"), "consent": b.get("consent"), "port": port,
            "challenge": _b64url(hashlib.sha256(verifier.encode()).digest())}).encode())
        if not r.ok:
            return _passed(r)
        url = SITE + r.json()["url"]
        with _lock:
            _pending = {"state": parse_qs(urlparse(url).query)["resume"][0], "verifier": verifier}
            _outcome = None
        import webbrowser       # here, not at the top: the website's Pyodide build imports this module but never gets here
        webbrowser.open(url)
        return _json({"url": url})

    if method == "GET" and path == "/account/callback":
        q = {k: v[0] for k, v in parse_qs(query).items()}
        with _lock:
            p = _pending
            if not p or q.get("state") != p["state"]:
                return _page("This isn't the sign-in Chess Review is waiting for. Start again from the app.")
            _pending = None
        outcome = q.get("account") or "error"
        if q.get("code"):
            t = _call("POST", "/account/app/token", json.dumps({"code": q["code"], "verifier": p["verifier"]}).encode())
            if t.ok:
                save_token(t.json()["token"])
            else:
                log.warning("sign-in code refused: %s %s", t.status_code, t.text[:200])
                outcome = "error"
        with _lock:
            _outcome = outcome
        return _page(DONE.get(outcome, DONE["error"]))

    if method == "POST" and path == "/account/app/export":
        r = _call("GET", "/account/export")
        if not r.ok:
            return _passed(r)
        folder = Path.home() / "Downloads"
        dst = (folder if folder.is_dir() else DATA) / "blundr-account.json"
        dst.write_bytes(r.content)
        return _json({"path": str(dst)})

    if path == "/account/logout":
        try:
            r = _call(method, path, body)
        except requests.RequestException:       # offline: the token goes all the same (the session expires on its own)
            r = None
        save_token(None)
        return _passed(r) if r is not None else _json({"ok": True})
    r = _call(method, path, body)
    if path == "/account/delete" and r.ok:
        save_token(None)
    if r.ok and path.startswith("/account/email/") and "application/json" in r.headers.get("Content-Type", ""):
        d = r.json()
        if d.get("token"):          # signed in by email: the token stays here, the page gets the rest
            save_token(d.pop("token"))
        return _json(d)
    return _passed(r)


# What the browser tab says once it's back, by outcome (the page in the app says the rest).
DONE = {
    "signed-in": "You're logged in. Go back to Chess Review: your puzzle progress and profiles sync from there.",
    "welcome": "Welcome to Blundr! Go back to Chess Review: your puzzle progress and profiles are saved to your account.",
    "linked": "Done: you can sign in that way too. Go back to Chess Review.",
    "no-account": "There is no Blundr account for that sign-in yet. Go back to Chess Review to sign up.",
    "taken": "That sign-in already belongs to another Blundr account. Go back to Chess Review.",
    "cancelled": "Sign-in cancelled. Go back to Chess Review to try again.",
    "error": "Signing in didn't work. Go back to Chess Review and try again.",
}


def _page(text: str) -> tuple[int, str, bytes]:
    html = ("<!doctype html><meta charset=utf-8><title>Chess Review</title>"
            "<body style=\"font:16px system-ui,sans-serif;background:#302e2b;color:#e8e6e3;display:grid;place-items:center;"
            "height:90vh;margin:0\"><div style=\"max-width:420px;text-align:center\"><h2>Chess Review</h2>"
            f"<p>{text}</p><p style=\"color:#9c9893\">You can close this tab.</p></div>")
    return 200, "text/html; charset=utf-8", html.encode()
