# Blundr accounts

Optional. Guests can use everything. An account keeps **puzzle progress** and the **profile list**, so they follow you to
other browsers and to the desktop app: the library puzzle rating and attempts, pack progress, the daily-puzzle record, each profile's
personal-puzzle review schedule, and the chess.com/Lichess profiles you added (source, username, when added, pinned).
Reviewed games, analysis and the engine's eval cache stay in the browser and never reach the server.

## The profile list

It syncs like puzzle progress, as a virtual `profiles.jsonl` that `js/server/sync.js` builds from `profiles/*/meta.json`, one line
per profile: `{"added", "pinned", "source", "username"}`. Pasted-PGN profiles stay out of it, because their games
can't be fetched again. A profile that arrives from the account is created empty, and `account.js` asks for it the way
the Add profile form does, so its games are fetched fresh from chess.com or Lichess. A pin set or cleared on one browser
reaches the others. If two browsers disagree at the same time, pinned wins. **A profile deleted on one browser is deleted
on the others too, with the reviews made there** (they exist only in that browser), unless a job is running on it at
that moment. Local-only state (the "new games" flags) is not synced.

## The desktop app

The Windows app has the same Log in button and dialog, and syncs the same account with blundr.gr. The
page code is one file, `chess_review/static/account.js`, in both apps, and so is the merge, `js/server/sync.js`:
the page runs the delta, account, commit loop in both, after each puzzle result, at start-up, on log-in and when the
window comes back into view. Only the transport differs:

- **`api/sync/*`** is answered by the JS server in both: in the tabs' worker on the website, on 127.0.0.1 in the app. The app's
  `DATA` folder plays the browser's part: "this computer" where the website says "this browser".
- **`account/*`** goes straight to the Worker on the website, with the session cookie. In the app it goes to the local
  server, and `js/server/account.js` passes it on to `https://blundr.gr` (`BLUNDR_URL` to point it elsewhere) with
  the header `X-Blundr-App: 1` and the session token as `Authorization: Bearer`. The token is kept in
  `DATA/account_token.json` (`%LOCALAPPDATA%\chess-review\`), together with the site it is for, and only the server
  reads it, as a browser keeps its cookie. The local server answers `account/*` only for its own page: a request from
  another site's page (`Origin`), or under another host name (DNS rebinding), gets a 403.
- **Email and password** works as on the website. The Worker sees `X-Blundr-App` and puts the session token in the
  answer instead of a cookie; the local server keeps it and gives the page the rest.
- **Lichess and Google** can't run in the app's window (Google refuses embedded webviews), so they run in the system
  browser, with the Worker still doing the OAuth:
  1. The app makes its own PKCE pair and asks `POST /account/app/start {provider, mode, consent, challenge, port}`.
     The Worker keeps a sign-in as for the website, plus the app's challenge and port, and answers with
     `https://blundr.gr/account/login/<provider>?resume=<state>`, which the app opens in the browser.
  2. That sets the usual state cookie and goes to the provider, which comes back to the usual
     `https://blundr.gr/account/callback/<provider>`. So the Google and Lichess settings are the website's, unchanged.
  3. The Worker sees the sign-in came from the app, so it sets no cookie: it keeps a one-time code (2 minutes, in
     `app_codes`, `migrations/0003_app_sign_in.sql`) and sends the browser to
     `http://127.0.0.1:<port>/account/callback?account=<outcome>&state=…&code=…`, the app's own server.
  4. The app checks the state, and swaps the code and its verifier for a session token at `POST /account/app/token`.
     A code read off that redirect is no use without the verifier. The browser tab says to go back to the app, whose
     dialog was waiting, asking `account/me` (which in the app also carries the outcome, once).
  Linking another sign-in method works the same way, with the app's token on `/account/app/start`.
- **Download my data** saves `blundr-account.json` to the Downloads folder (the app's window can't download), and the
  privacy and terms links open the website's pages in the browser.
- Offline, the button stays hidden until the window is focused again. Logging out offline forgets the token anyway.

## Shape

```
 page                                  js/server: the worker, or the app's    Worker (Cloudflare)          D1
 ────                                  ────────────────────────────────────   ───────────────────          ──
 chess_review/static/account.js        js/server/sync.js                      worker/src/index.js          users, identities,
   header button + account dialog        POST api/sync/delta   ──┐            /account/me, login,           sessions, logins,
   sync: delta → account → commit        POST api/sync/commit    │  ───►      callback, logout,             progress
   after each puzzle result, on load,    POST api/sync/forget    │            progress, export, delete,
   on login, when the tab comes back                             └─ (page)    unlink; daily cron
```

- **One Worker** (`worker/wrangler.jsonc`) serves `web-dist/` as static assets and runs code only for `/account/*`
  (`run_worker_first`). Static requests are free and unmetered; the account API is a few requests a day per user.
  The full engine (95 MB) is over the 25 MiB asset limit, so `build_web.js` writes a `.assetsignore` for it and
  the deployed build fetches it from unpkg instead (`--engine-wasm cdn`, [web.md](web.md#hosting)).
- **Sign-in**: OAuth 2 with PKCE, with Lichess (no registration needed, no scope: id and username only) and Google
  (scope `openid email`; email kept and shown). Sign-up and log-in are separate buttons. A sign-up needs the
  consent box ticked (15 or older, terms and privacy policy) and records the consent version and time. A log-in to an
  account that doesn't exist sends you back with `?account=no-account` and the dialog offers to sign up. A second
  sign-in method can be linked from the account dialog, and removed as long as one is left. Signed in, the dialog
  shows who, the sync and Log out; linking another method ("Other ways to sign in") and Download my data / Delete
  account ("Delete or download") sit behind two small links, so no one is pushed towards a second method.
- **Email and password** (`worker/src/email.js`, `migrations/0002_email_password.sql`):
  - **Sign-up**: an address, a password of 10 or more characters, and the consent box. We email a 6-digit code, and the
    account exists only once the code is typed in, so nobody can sign up with someone else's address.
  - **Codes**: kept hashed, 15 minutes, 5 tries, at most one a minute per address and purpose.
  - **Passwords**: PBKDF2-SHA256, 100,000 iterations (the Workers maximum), with a 16-byte random salt. They are never
    exported.
  - **Log-in**: after 10 failures for an address, it waits 15 minutes.
  - **Forgot password**: a code, then the new password. All of that account's sessions are signed out.
  - **No address lookup**: a taken address at sign-up gets a "you already have an account" email instead of a different
    answer, and a wrong address or a wrong password give the same error.
  - **Sending**: Brevo's transactional API (free tier, 300 a day) with the `BREVO_API_KEY` secret, from `MAIL_FROM`.
    Cloudflare's own Email Sending (a `send_email` binding named `EMAIL`) also works, with no code change, but it reaches
    arbitrary addresses only on the Workers Paid plan. With neither, as under `wrangler dev`, the message is only
    printed in the console, code included.
  - **Not yet**: a per-IP limit on asking for codes. Add a Cloudflare rate-limiting rule on `/account/email/*` if abuse
    shows up.
- **Session**: a random token in the `blundr_session` cookie (HttpOnly, SameSite=Lax, Secure on https, `Path=/account/`),
  stored in D1 only as its SHA-256. 90 days, extended on use. POSTs must carry the site's own `Origin`, or the desktop
  app's `X-Blundr-App` header, which no other site's page can send (the browser would ask first with a CORS preflight,
  and the Worker never says yes). The desktop app's session is the same kind of token, sent as `Bearer`.
- **Sync** is a three-way merge of the JSONL files, done by the JS server (`js/server/sync.js`; the whole story is in the Python original's docstring, `git show e8e547f:chess_review/sync.py`) against
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
> The controller's details are filled in. The page says the database stays in the EU, which holds only if D1 is
> created with `--jurisdiction eu`. A new placeholder goes in `<span class="fill">`, and `build_web.js` warns while any
> are left.

What makes it fit without a cookie banner: the two cookies and the browser storage are all strictly necessary for what
the visitor asked for (ePrivacy art. 5(3) exemption). Worker observability (request logs with IPs) is off. There's no
analytics. **Adding analytics, ads, or any non-essential cookie or storage means a consent banner becomes
required.** Account holders get Download my data (JSON of every row about them: art. 15/20) and Delete account
(immediate, all tables: art. 17) in the dialog. When the terms or the policy change, bump `CONSENT_VERSION` in
`worker/src/consent.js` and `chess_review/static/account.js`, and the date on both pages.

## Run it locally

```
node scripts/build_web.js                   # web-dist/
cd worker && npm install
python ../scripts/fake_lichess.py &         # optional: a Lichess stand-in that signs in any name you type
echo LICHESS_URL=http://localhost:8788 > .dev.vars
npm run dev                                 # local D1 migrations, then http://localhost:8787/
npm test                                    # the Worker's tests (vitest, local D1)
```

Without `LICHESS_URL` the real lichess.org is used, which also works from localhost. For Google locally, add
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `.dev.vars` with `http://localhost:8787/account/callback/google` as an
authorised redirect URI. The app's side: `npm test` at the root (`js/server/sync.test.js`, `account.test.js`).

The desktop app against that local Worker: `BLUNDR_URL=http://localhost:8787 npm run desktop`. Its token is kept per site, so one for blundr.gr isn't sent to localhost.

## Deploy

How blundr.gr was set up on 2026-10-22 (Cloudflare free plan, Brevo free plan). Run wrangler from WSL, in `worker/`,
after `npx wrangler login`. The domain's nameservers must already be Cloudflare's ([web.md](web.md#deploying-to-blundrgr)).

1. **Database**: `npx wrangler d1 create blundr --jurisdiction eu`, and the printed id goes in `wrangler.jsonc` (done:
   `63f34fde-…`). `npm run deploy` applies the migrations each time; `npx wrangler d1 migrations apply blundr --remote`
   does it alone.
2. **Google** (Cloud console, project `blundr-512406`, Google Auth Platform):
   - Clients: a web application client with the redirect URI `https://blundr.gr/account/callback/google` (and
     `http://localhost:8787/account/callback/google` for local runs).
   - Branding: home page `https://blundr.gr`, privacy `https://blundr.gr/privacy`, terms `https://blundr.gr/terms`
     (the `.html` addresses answer with a redirect), authorised domain `blundr.gr`. **No logo**: in production a logo
     needs Google's brand verification.
   - Audience: In production. `openid email` are non-sensitive scopes, so no verification and no user cap.
   - `npx wrangler secret put GOOGLE_CLIENT_ID`, then `GOOGLE_CLIENT_SECRET`.
3. **Email** (Brevo):
   - Senders, Domains & Dedicated IPs > Domains > add `blundr.gr`. Skip the branded subdomain (the codes have no links).
     The automatic Cloudflare setup adds the `brevo-code` TXT, the `brevo1`/`brevo2._domainkey` CNAMEs and `_dmarc`.
     Then Authenticate.
   - Senders: `Blundr <login@blundr.gr>` (`MAIL_FROM`).
   - SMTP & API > API keys: a key with no expiry, and Security > Authorised IPs off, because a Worker's IP varies.
   - `npx wrangler secret put BREVO_API_KEY`. The codes reach Gmail's inbox (the Updates tab).
4. **Build**: `node scripts/build_web.js --engine-wasm cdn` (Node ≥ 22.13). It needs the opening book in `data/book`
   (`scripts/fetch_book.sh`). In a worktree, link the main checkout's `data/book`.
5. **Worker**: `npm run deploy`. `wrangler.jsonc` attaches blundr.gr and www.blundr.gr as custom domains (their DNS
   records and certificates are made automatically), sets the daily cron, and turns the `workers.dev` address off. The
   first deploy on an account stops at the cron with error 10063 until the account has a workers.dev subdomain: open
   Workers & Pages in the dashboard once, then deploy again.
6. **www**: blundr.gr > Rules > Templates > "Redirect from WWW to root" (`https://www.*` to `https://${1}`, 301,
   query string kept). There must be one origin only: Google's redirect URI names it, and a browser keeps the reviews
   and puzzles per origin.

Updating: a push to main deploys by itself (`.github/workflows/deploy-web.yml`, with the repository secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`); migrations only from a manual run with the box ticked. By hand:
build as in step 4, then `npm run deploy`. The desktop app's sign-in needs the Worker with
`migrations/0003_app_sign_in.sql` and `/account/app/*` deployed before a desktop release that has it; no Google or
Lichess setting changes for it. A new Stockfish is `STOCKFISH_VERSION` in `build_web.js`, together
with the desktop's `bin/`, or reviews stop matching between the two.
