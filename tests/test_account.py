"""The desktop app's Blundr account (chess_review/account.py): the page's account/* requests passed on to the Worker
with the session token kept here, and a provider sign-in finished in the system browser. The Worker is stood in for
by a stubbed requests.request (worker/test/ checks the real one)."""

import functools
import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest
import requests

from chess_review import account, serve


class Fake:
    """The Worker: canned answers by path, and what the app sent."""

    def __init__(self):
        self.sent, self.answers = [], {}

    def __call__(self, method, url, data=None, headers=None, timeout=None, allow_redirects=True):
        path = url[len(account.SITE):]
        self.sent.append({"method": method, "path": path, "body": json.loads(data) if data else None, "headers": headers})
        code, body = self.answers.get(path, (404, {"error": "not found"}))
        r = requests.Response()
        r.status_code, r._content = code, json.dumps(body).encode()
        r.headers["Content-Type"] = "application/json"
        return r


@pytest.fixture
def worker(tmp_path, monkeypatch):
    monkeypatch.setattr(account, "TOKEN_FILE", tmp_path / "account_token.json")
    monkeypatch.setattr(account, "_pending", None)
    monkeypatch.setattr(account, "_outcome", None)
    f = Fake()
    monkeypatch.setattr(account.requests, "request", f)
    return f


def call(method, path, body=None, query=""):
    code, ctype, out = account.handle(method, path, query, json.dumps(body).encode() if body is not None else None, 8123)
    return code, json.loads(out) if "json" in ctype else out.decode()


USER = {"id": "u-1", "identities": [{"provider": "email", "name": "ana@example.com"}], "created_at": 1}


def test_email_login_keeps_the_token_here_and_sends_it_as_bearer(worker):
    worker.answers["/account/email/login"] = (200, {"ok": True, "user": USER, "token": "t" * 43})
    code, d = call("POST", "/account/email/login", {"email": "ana@example.com", "password": "x" * 10})
    assert code == 200 and d == {"ok": True, "user": USER}         # the page never sees the token
    assert worker.sent[0]["headers"]["X-Blundr-App"] == "1" and "Authorization" not in worker.sent[0]["headers"]
    assert account.load_token() == "t" * 43
    worker.answers["/account/progress"] = (200, {"files": {}})
    call("POST", "/account/progress", {"add": {}})
    assert worker.sent[-1]["headers"]["Authorization"] == "Bearer " + "t" * 43


def test_a_session_ended_elsewhere_drops_the_token(worker):
    account.save_token("t" * 43)
    worker.answers["/account/progress"] = (401, {"error": "not signed in"})
    assert call("POST", "/account/progress", {"add": {}})[0] == 401
    assert account.load_token() is None


def test_a_token_for_another_site_is_not_sent(worker, monkeypatch):
    account.save_token("t" * 43)
    monkeypatch.setattr(account, "SITE", "http://localhost:8787")
    assert account.load_token() is None


def test_provider_sign_in_through_the_browser(worker, monkeypatch):
    opened = []
    monkeypatch.setattr("webbrowser.open", opened.append)
    worker.answers["/account/app/start"] = (200, {"url": "/account/login/lichess?resume=S1"})
    code, d = call("POST", "/account/app/login/lichess", {"mode": "signup", "consent": "2026-10-22"})
    assert code == 200 and opened == [d["url"]]
    start = worker.sent[0]["body"]
    assert start["provider"] == "lichess" and start["port"] == 8123 and len(start["challenge"]) == 43
    # back in the browser, with the code: swapped for the token with the verifier only this app has
    worker.answers["/account/app/token"] = (200, {"token": "s" * 43, "user": USER})
    code, page = call("GET", "/account/callback", query="account=welcome&state=S1&code=C1")
    assert "Welcome to Blundr" in page
    token_req = worker.sent[-1]["body"]
    assert token_req["code"] == "C1" and token_req["verifier"]
    assert account.load_token() == "s" * 43
    # the waiting page learns how it went, once
    worker.answers["/account/me"] = (200, {"user": USER, "providers": []})
    assert call("GET", "/account/me")[1] | {} == {"user": USER, "providers": [], "app": True, "site": account.SITE, "outcome": "welcome"}
    assert call("GET", "/account/me")[1]["outcome"] is None


def test_a_callback_this_app_did_not_start_is_ignored(worker, monkeypatch):
    monkeypatch.setattr("webbrowser.open", lambda url: None)
    worker.answers["/account/app/start"] = (200, {"url": "/account/login/lichess?resume=S1"})
    call("POST", "/account/app/login/lichess", {"mode": "login"})
    code, page = call("GET", "/account/callback", query="account=signed-in&state=OTHER&code=C1")
    assert "isn't the sign-in" in page
    assert all(s["path"] != "/account/app/token" for s in worker.sent)
    assert account.load_token() is None


def test_no_account_comes_back_without_a_code(worker, monkeypatch):
    monkeypatch.setattr("webbrowser.open", lambda url: None)
    worker.answers["/account/app/start"] = (200, {"url": "/account/login/lichess?resume=S1"})
    call("POST", "/account/app/login/lichess", {"mode": "login"})
    assert "no Blundr account" in call("GET", "/account/callback", query="account=no-account&state=S1")[1]
    worker.answers["/account/me"] = (200, {"user": None, "providers": []})
    assert call("GET", "/account/me")[1]["outcome"] == "no-account"


def test_logging_out_offline_still_forgets_the_token(worker, monkeypatch):
    account.save_token("t" * 43)

    def offline(*a, **k):
        raise requests.ConnectionError("offline")
    monkeypatch.setattr(account.requests, "request", offline)
    assert call("POST", "/account/logout") == (200, {"ok": True})
    assert account.load_token() is None


def test_export_is_saved_to_a_file(worker, tmp_path, monkeypatch):
    monkeypatch.setattr(account.Path, "home", lambda: tmp_path)
    (tmp_path / "Downloads").mkdir()
    worker.answers["/account/export"] = (200, {"account": {"id": "u-1"}})
    code, d = call("POST", "/account/app/export")
    assert d["path"] == str(tmp_path / "Downloads" / "blundr-account.json")
    assert json.loads((tmp_path / "Downloads" / "blundr-account.json").read_text()) == {"account": {"id": "u-1"}}


@pytest.fixture
def server(tmp_path, worker):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(serve.Handler, directory=str(tmp_path)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1]
    srv.shutdown()


def request(port, method, path, headers=()):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request(method, path, body=b"{}" if method == "POST" else None, headers=dict(headers))
    r = c.getresponse()
    return r.status, json.loads(r.read() or b"null")


def test_only_the_apps_own_page_reaches_the_account(server, worker):
    worker.answers["/account/delete"] = (200, {"deleted": True})
    assert request(server, "POST", "/account/delete", {"Origin": "https://evil.test"})[0] == 403
    assert request(server, "POST", "/account/delete", {"Host": f"evil.test:{server}"})[0] == 403    # DNS rebinding
    assert worker.sent == []
    assert request(server, "POST", "/account/delete", {"Origin": f"http://127.0.0.1:{server}"}) == (200, {"deleted": True})


def test_the_server_answers_sync_steps(server, monkeypatch):
    monkeypatch.setattr(serve.sync, "handle", lambda path, body: {"path": path})
    assert request(server, "POST", "/api/sync/state") == (200, {"path": "/api/sync/state"})
    monkeypatch.setattr(serve.sync, "handle", lambda path, body: None)
    assert request(server, "POST", "/api/sync/nope")[0] == 400
