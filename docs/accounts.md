# Blundr accounts

Optional. Guests can use everything. An account keeps **puzzle progress** only, so it follows you to other browsers:
the library puzzle rating and attempts, pack progress, the daily-puzzle record and each profile's personal-puzzle
review schedule. Reviewed games, profiles and the engine's eval cache stay in the browser and never reach the server.

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
- **Log out** keeps the progress in the browser, so it becomes a guest's again. The next account to log in on that browser
  gets it uploaded. "Log out and clear puzzle progress from this browser" is the option for a shared computer.
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
