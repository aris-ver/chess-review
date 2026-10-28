# Blundr security checklist

The basic defences blundr.gr should have, and where each one stands. Audited 2026-10-28 against the code and the live
site (`curl`, public DNS). ✅ in place · 🔧 added in code (live after the next deploy) · 👤 a setting only the owner
can change (dashboard, registrar, accounts).

## Accounts and sessions (worker/)

| | Defence | Where |
|---|---|---|
| ✅ | Passwords hashed with a slow salted hash (PBKDF2-SHA256, 100,000 iterations, 16-byte salt), compared in constant time | `email.js` |
| ✅ | Minimum password length (10), maximum (200) | `email.js` |
| ✅ | Log-in throttled per address: 10 failures, then 15 minutes | `email.js` |
| ✅ | No account enumeration: same answer and timing for a wrong address and a wrong password, sign-up and forgot always say "sent" | `email.js` |
| ✅ | Email codes: 6 digits, hashed, 15 minutes, 5 tries, one a minute per address | `email.js` |
| ✅ | Password reset signs out every session | `email.js` |
| ✅ | Session token random (256 bits), stored only as its SHA-256, 90 days | `index.js`, `store.js` |
| ✅ | Session cookie HttpOnly, SameSite=Lax, Path=/account/ | `index.js` |
| ✅ | CSRF: every POST must carry the site's own Origin (or the desktop app's header, which forces a CORS preflight nobody answers) | `index.js` |
| ✅ | OAuth with PKCE and a state bound to the browser by cookie; Google's id_token audience, issuer and expiry checked | `index.js`, `providers.js` |
| ✅ | Desktop sign-in: one-time 2-minute code that's useless without the app's PKCE verifier; redirect only to 127.0.0.1 | `index.js` |
| ✅ | SQL injection: every query is a prepared statement with bound values | `store.js`, `email.js` |
| ✅ | Input validated: file names by allow-list regex, lines must be JSON objects, size caps per line, request and account | `store.js` |
| ✅ | No stack traces to the client: unknown errors answer `server error` | `index.js` |
| ✅ | Data minimisation: no IP logs (observability off), unused accounts deleted after 730 days, export and delete work | `wrangler.jsonc`, `store.js` |
| ✅ | No `workers.dev` or preview URLs: one origin only | `wrangler.jsonc` |
| 🔧 | **HTTPS enforced on /account/***: http redirects or is refused, cookies always Secure | `index.js` |
| 🔧 | **Per-IP rate limit** on the email, log-in and sign-in-start routes (mail bombing, password spraying): 3 emails and 20 sign-in steps a minute per IP | `index.js`, `wrangler.jsonc` |
| ⚠️ | Brevo's 300 emails a day can still be spent by many IPs, or one sending steadily (the limit is per minute, per Cloudflare location). If that happens: Turnstile on sign-up and forgot, or a daily cap on emails sent | |

## The site (web-dist/)

| | Defence | Where |
|---|---|---|
| ✅ | User-supplied text escaped before it goes into HTML (`esc()` in the account dialog) | `account.js` |
| ✅ | Engine from unpkg pinned to an exact version | `build_web.js` |
| 🔧 | **Security headers**: HSTS, Content-Security-Policy, X-Frame-Options / frame-ancestors, nosniff, Referrer-Policy, Permissions-Policy | `_headers` via `build_web.js` |
| 🔧 | **Engine integrity**: the unpkg .wasm is checked against the SHA-256 of the file we built with | `build_web.js`, `engines.js` |

## Secrets and dependencies

| | Defence | Where |
|---|---|---|
| ✅ | Secrets (`GOOGLE_CLIENT_SECRET`, `BREVO_API_KEY`) only in `wrangler secret` / `.dev.vars`, which is git-ignored; none in the code or its history | `.gitignore` |
| ✅ | No known vulnerabilities in what ships (`npm audit --omit=dev`: 0 in worker/ and the root) | |
| ⚠️ | Dev-only tools in worker/ (wrangler's sharp, esbuild, vitest) have advisories; they never reach visitors. Update when convenient | `worker/package.json` |

## Owner's settings (👤)

These live outside the repo. Each takes a minute or two.

| | Defence | How |
|---|---|---|
| ✅ | **Always Use HTTPS** (http → 301 to https), **minimum TLS 1.2** | Cloudflare → SSL/TLS → Edge Certificates. Set 2026-10-28 |
| ✅ | **SPF record**: TXT `@` `v=spf1 include:spf.brevo.com ~all` | Cloudflare DNS. Added 2026-10-28 |
| ✅ | **CAA records**: letsencrypt.org, pki.goog, ssl.com (Cloudflare adds its own other CAs to them automatically) | Cloudflare DNS. Added 2026-10-28 |
| 👤 | **DNSSEC**: on at Cloudflare (2026-10-28), *pending* until the DS record is at the .gr registrar | Registrar's DNSSEC/DS page: key tag `2371`, algorithm `13`, digest type `2`, digest `1AE0D2F9C9823861D5E2E021276BE9A363B8427E9BD563CD53FB3564C021CCF0` (public key `mdsswUyr3DPW132mOi8V9xESWE8jTo0dxCjjnopKl+GqJxpVXckHAeF+KkxLbxILfDLUT0rAK9iUzy1L53eKGQ==`, flags 257, if it asks for a DNSKEY instead) |
| 👤 | **DMARC to enforcement**: today `p=none` (report only) | Once SPF has been in a week or two and Brevo's DMARC reports look clean: `p=quarantine`, later `p=reject` |
| 👤 | **Two-factor sign-in**: **off on Cloudflare** (2026-10-28) | Cloudflare → My Profile → Authentication. Then the .gr registrar, Google Cloud (the OAuth client), Brevo, GitHub, the Gmail behind them |
| 👤 | **Registrar lock** on blundr.gr | At the registrar |
| ⛔ | **Bot Fight Mode**: left off on purpose | It challenges non-browser clients, and the desktop app's server calls `/account/*` with plain fetch; the free plan can't exempt a path. The per-IP limits cover the account routes instead |
| 👤 | **Scoped API tokens** — no global API key in scripts; tokens limited to the blundr Worker and D1 | Cloudflare → My Profile → API Tokens |
| 👤 | **Billing / usage alerts**, so an attack that runs up requests is noticed | Cloudflare → Notifications |
