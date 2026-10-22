// The two sign-in methods, both OAuth 2 with PKCE. Each gives back who you are at the provider ({subject, name,
// email}) and nothing is kept from it beyond that: the access token is thrown away (Lichess's is revoked).

// LICHESS_URL points sign-ins at a stand-in for local testing (scripts/fake_lichess.py); unset, it is lichess.org
const lichessUrl = env => env.LICHESS_URL || 'https://lichess.org';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

export class SignInError extends Error {}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields),
  });
  if (!res.ok) throw new SignInError(`${new URL(url).host} token: HTTP ${res.status}`);
  return res.json();
}

const lichess = {
  name: 'Lichess',
  configured: () => true,
  authorizeUrl(env, { redirectUri, state, challenge }) {
    const q = new URLSearchParams({
      response_type: 'code', client_id: env.LICHESS_CLIENT_ID, redirect_uri: redirectUri,
      code_challenge_method: 'S256', code_challenge: challenge, state,
    });
    return `${lichessUrl(env)}/oauth?${q}`;      // no scope: only the account's id and username
  },
  async identify(env, { code, verifier, redirectUri }) {
    const tok = await postForm(`${lichessUrl(env)}/api/token`, {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
      client_id: env.LICHESS_CLIENT_ID,
    });
    const auth = { Authorization: `Bearer ${tok.access_token}` };
    const res = await fetch(`${lichessUrl(env)}/api/account`, { headers: auth });
    if (!res.ok) throw new SignInError(`lichess account: HTTP ${res.status}`);
    const me = await res.json();
    await fetch(`${lichessUrl(env)}/api/token`, { method: 'DELETE', headers: auth }).catch(() => {});
    if (!me.id) throw new SignInError('lichess account: no id');
    return { subject: String(me.id), name: String(me.username || me.id), email: null };
  },
};

function jwtPayload(jwt) {
  const part = String(jwt || '').split('.')[1];
  if (!part) throw new SignInError('google: no id_token');
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
}

const google = {
  name: 'Google',
  configured: env => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  authorizeUrl(env, { redirectUri, state, challenge }) {
    const q = new URLSearchParams({
      response_type: 'code', client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, scope: 'openid email',
      code_challenge_method: 'S256', code_challenge: challenge, state, prompt: 'select_account',
    });
    return `${GOOGLE_AUTH}?${q}`;
  },
  async identify(env, { code, verifier, redirectUri }) {
    const tok = await postForm(GOOGLE_TOKEN, {
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    });
    // Straight from Google's token endpoint over TLS, so the signature needn't be checked (OpenID Connect
    // Core 3.1.3.7); the claims still must be for us and current.
    const c = jwtPayload(tok.id_token);
    if (c.aud !== env.GOOGLE_CLIENT_ID) throw new SignInError('google: id_token for another client');
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) throw new SignInError('google: bad issuer');
    if (!(c.exp * 1000 > Date.now())) throw new SignInError('google: id_token expired');
    if (!c.sub) throw new SignInError('google: no subject');
    const email = c.email && c.email_verified !== false ? String(c.email) : null;
    return { subject: String(c.sub), name: email || 'Google account', email };
  },
};

export const providers = { lichess, google };
