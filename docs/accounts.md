# Blundr accounts

Optional. Guests can use everything. An account keeps **puzzle progress** and the **profile list**, so they follow you to
other browsers: the library puzzle rating and attempts, pack progress, the daily-puzzle record, each profile's
personal-puzzle review schedule, and the chess.com/Lichess profiles you added (source, username, when added, pinned).
Reviewed games, analysis and the engine's eval cache stay in the browser and never reach the server.

## The profile list

It syncs like puzzle progress, as a virtual `profiles.jsonl` that `sync.py` builds from `profiles/*/meta.json`, one line
per profile: `{"added", "pinned", "source", "username"}`. Pasted-PGN profiles stay out of it, because their games
can't be fetched again. A profile that arrives from the account is created empty, and `account.js` asks for it the way
the Add profile form does, so its games are fetched fresh from chess.com or Lichess. A pin set or cleared on one browser
reaches the others. If two browsers disagree at the same time, pinned wins. **A profile deleted on one browser is deleted
on the others too, with the reviews made there** (they exist only in that browser), unless a job is running on it at
that moment. Local-only state (the "new games" flags) is not synced.

**The desktop app** could use the same account later. The format has nothing browser-specific in it, and `sync.py` is
plain Python over `DATA`. It would need three things:
1. Sign-in from a desktop app. Lichess and Google support OAuth for native apps with a loopback redirect
   (`http://127.0.0.1:<port>/callback`, PKCE). The Worker would hand out a session token in the response body,
   since a desktop app has no cookie jar, and accept it as a `Bearer` header.
2. `sync.py` moved into `chess_review/`, with the delta, account, commit loop run by the desktop server after puzzle
   results and at start-up.
3. A Log in control in the shared page. It already exists in `account.js`; only the transport differs.

## Shape

```
 page                                  Python worker (Pyodide)                Worker (Cloudflare)          D1
 ────                                  ───────────────────────                ───────────────────          ──
 web/account.js                        web/py/chess_web/sync.py               worker/src/index.js          users, identities,
   header button + account dialog        POST api/sync/delta   ──┐            /account/me, login,           sessions, logins,
   sync: delta → account → commit        POST api/sync/commit    │  ───►      callback, logout,             progress
   after each puzzle result, on load,    POST api/sync/forget    │            progress, export, delete,
   on login, when the tab comes back                             └─ (page)    unlink; daily cron
```

- **One Worker** (`worker/wrangler.jsonc`) serves `web-dist/` as static assets and runs code only for `/account/*`
  (`run_worker_first`). Static requests are free and unmetered; the account API is a few requests a day per user.
  The full engine (95 MB) is over the 25 MiB asset limit, so `build_web.py` writes a `.assetsignore` for it and
  deployments point `--engine-wasm` at R2 as before.
- **Sign-in**: OAuth 2 with PKCE, with Lichess (no registration needed, no scope: id and username only) and Google
  (scope `openid email`; email kept and shown). Sign-up and log-in are separate buttons. A sign-up needs the
  consent box ticked (15 or older, terms and privacy policy) and records the consent version and time. A log-in to an
  account that doesn't exist sends you back with `?account=no-account` and the dialog offers to sign up. A second
  sign-in method can be linked from the account dialog, and removed as long as one is left.
- **Session**: a random token in the `blundr_session` cookie (HttpOnly, SameSite=Lax, Secure on https, `Path=/account/`),
  stored in D1 only as its SHA-256. 90 days, extended on use. POSTs must carry the site's own `Origin`.
- **Sync** is a three-way merge of the JSONL files, done in Python (`sync.py`, whose docstring has the details) against
  the copy last received from the account (`DATA/account_sync.json`). The server keeps a set of lines per file
  (`store.js`), so two browsers writing at once can't undo each other. A guest has no base, so signing up or logging
  in uploads everything already in the browser. A rating reset moves the lines into a `.reset-` archive file, and that
  move reaches the other browsers. After merging, files are sorted oldest first and the library record keeps one first
  try per puzzle, as on a single browser. Deleting a profile removes its review schedule from the account too.
- **Whose data is in the browser** is switched as a whole (`sync.switch`). Each owner, the guest or an account, has its
  own synced set: the puzzle files and the chess.com/Lichess profile folders with their reviews. The set of the owner
  who isn't active waits in `DATA/.accounts/<owner>/`.
  - **Signing up** in a browser that has guest data: the dialog asks whether to add it to the new account. Yes: the
    first sync uploads it. No: it is set aside, and the account starts empty. (The question comes whenever the
    account still holds nothing on the server.)
  - **Logging in** to an account that already has data: the guest's data is set aside, never added to the account.
  - **Logging out**: the account's copy is set aside (its reviews are there at the next login) and the guest's comes
    back. "Log out and remove my progress and profiles from this browser" deletes the account's copy instead, for a
    shared computer.
  - **Deleting the account**: its copy becomes the guest's, merged with what the guest had set aside, unless the box
    to remove it is ticked.
  - The shared eval cache and pasted-PGN games belong to nobody and stay put. A profile being fetched or analysed
    can't be moved, so the switch waits for it.
- **Retention**: a daily cron deletes expired sessions, sign-ins never finished (15 minutes), and accounts unused for
  `RETENTION_DAYS` (730), with all their data.

## Privacy (EU/GDPR)

`web/pages/privacy.html` and `web/pages/terms.html` are built to `/privacy.html` and `/terms.html`.

> **Not legal advice.** They were drafted with Claude Code, not by a lawyer. Have them checked before going live.
> Fill in every `[[…]]` placeholder (your name, postal address, contact email, the D1 location, the backup window).
> `build_web.py` warns while any are left.

What makes it fit without a cookie banner: the two cookies and the browser storage are all strictly necessary for what
the visitor asked for (ePrivacy art. 5(3) exemption). Worker observability (request logs with IPs) is off. There's no
analytics. **Adding analytics, ads, or any non-essential cookie or storage means a consent banner becomes
required.** Account holders get Download my data (JSON of every row about them: art. 15/20) and Delete account
(immediate, all tables: art. 17) in the dialog. When the terms or the policy change, bump `CONSENT_VERSION` in
`worker/src/consent.js` and `web/account.js`, and the date on both pages.

## Run it locally

```
python scripts/build_web.py                 # web-dist/
cd worker && npm install
python ../scripts/fake_lichess.py &         # optional: a Lichess stand-in that signs in any name you type
echo LICHESS_URL=http://localhost:8788 > .dev.vars
npm run dev                                 # local D1 migrations, then http://localhost:8787/
npm test                                    # the Worker's tests (vitest, local D1)
```

Without `LICHESS_URL` the real lichess.org is used, which also works from localhost. For Google locally, add
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `.dev.vars` with `http://localhost:8787/account/callback/google` as an
authorised redirect URI. Python side: `pytest tests/test_sync.py`.

## Deploy (when you're ready)

1. `npx wrangler d1 create blundr --location weur`, put the printed id in `wrangler.jsonc`.
2. Google Cloud console: create an OAuth client (web application) with the redirect URI
   `https://blundr.gr/account/callback/google`. Set the consent screen's privacy policy and terms links to the pages
   above. Then `npx wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
3. `python scripts/build_web.py --engine-wasm https://engine.blundr.gr/stockfish-19-single.wasm`, then in `worker/`:
   `npm run deploy`, and add blundr.gr as the Worker's custom domain. This takes the place of the Pages project in docs/web.md.
