// The optional Blundr account (docs/accounts.md): a Log in button at the end of the header, the account dialog, and
// keeping puzzle progress in step with the account. Loaded by the web build right after web/shim.js; the desktop
// app has none of it. The page itself is untouched: everything here is added from the outside.
//
// The account API is the Worker's /account/* (worker/src/index.js), a real network request. The merge is the
// Python worker's /api/sync/* (web/py/chess_web/sync.py), which shim.js routes there like every other api/ call.
(() => {
  const CONSENT = '2026-10-22';      // worker/src/consent.js: the terms and privacy policy agreed to
  const PROGRESS_WRITES = /^api\/(puzzles\/(attempt|solved|daily|reset)|profiles|profiles\/[^/]+\/(delete|pin))$/;
  const OVERVIEW = /^(|#|#\/|#\/packs(\/[a-z0-9-]+)?|#\/puzzles\/mine)$/;     // screens that show progress, safe to redraw

  let me = null, providers = [], lastSync = null, syncError = null, minPassword = 10;
  const pageFetch = window.fetch;                // shim.js's: api/ goes to Python, the rest to the network
  const post = (url, body) => pageFetch(url, { method: 'POST', body: JSON.stringify(body || {}), headers: { 'Content-Type': 'application/json' } });
  const getJSON = async url => { const r = await pageFetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const say = msg => (typeof window.toast === 'function' ? window.toast(msg) : console.log(msg));

  // ---------- sync ----------

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const redraw = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

  // Whose data is in the browser (web/py/chess_web/sync.py switch()): set aside one owner's, bring back another's.
  // Python answers busy while a profile that would move is being fetched or analysed: wait for it.
  async function handOver(body, route = 'api/sync/switch') {
    for (let i = 0; i < 200; i++) {
      const r = await (await post(route, body)).json();
      if (!r.busy) { if (r.switched || r.released) redraw(); return r; }
      await sleep(3000);
    }
    throw new Error('a profile stayed busy');
  }

  // Signed in: the browser must hold this account's data before anything syncs. A brand-new account on a browser
  // with a guest's progress asks first whether to take it (attach waits for the answer); any other account never
  // gets the guest's data: it is set aside and comes back on logging out.
  let attached = false;
  async function attach() {
    const st = await (await post('api/sync/state')).json();
    if (st.owner !== me.id) {
      const g = st.owner == null ? st.guest_data : null;
      if (g && (g.puzzle_records || g.profiles) && !me.progress_lines) {
        open({ offer: g });
        return;
      }
      await handOver({ user: me.id });
    }
    attached = true;
    sync();
  }
  async function answerOffer(keep) {
    await handOver({ user: me.id, keep });
    view.offer = null;
    attached = true;
    await sync();
    say(keep ? 'Your progress and profiles are saved to your account' : 'Starting fresh: what you did as a guest comes back when you log out');
  }

  let syncing = null, again = false, syncT = null;
  async function syncOnce() {
    let changed = [];
    for (let round = 0; round < 3; round++) {        // again while this browser still has something the account lacks
      const d = await (await post('api/sync/delta', { user: me.id })).json();
      const r = await post('account/progress', d);
      if (r.status === 401) {                          // the session ended elsewhere: back to the guest's data
        me = null;
        attached = false;
        render();
        await handOver({ user: null });
        return;
      }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const { files } = await r.json();
      const c = await (await post('api/sync/commit', { user: me.id, files })).json();
      changed = changed.concat(c.changed || []);
      // a profile added on another browser arrives without games: fetch them here, as adding it would
      for (const p of c.profiles_added || []) await post('api/profiles', { source: p.source, username: p.username });
      me.progress_lines = Object.values(files).reduce((n, l) => n + l.length, 0);
      if (!c.pending) break;
    }
    lastSync = new Date();
    syncError = null;
    if (changed.length) {
      if (OVERVIEW.test(location.hash)) window.dispatchEvent(new HashChangeEvent('hashchange'));    // redraw it with the merged progress
      else say('Puzzle progress updated from your account');
    }
  }
  function sync() {
    if (!me || !attached) return Promise.resolve();
    if (syncing) { again = true; return syncing; }
    syncing = syncOnce().catch(e => { syncError = String(e.message || e); console.error('account sync', e); })
      .finally(() => { syncing = null; renderDialog(); if (again) { again = false; sync(); } });
    return syncing;
  }
  const syncSoon = () => { clearTimeout(syncT); syncT = setTimeout(sync, 2000); };

  // a puzzle result (or a reset, or a profile removed) is progress to send: watch the page's requests for them
  const base = new URL('.', location.href).pathname;
  window.fetch = async (input, init = {}) => {
    const res = await pageFetch(input, init);
    try {
      const method = (init.method || (input instanceof Request && input.method) || 'GET').toUpperCase();
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      if (me && method !== 'GET' && res.ok && path.startsWith(base) && PROGRESS_WRITES.test(path.slice(base.length))) syncSoon();
    } catch (e) { /* never in the page's way */ }
    return res;
  };

  // ---------- header button ----------

  const css = document.createElement('style');
  css.textContent = `
#b-account { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
#b-account svg { width: 16px; height: 16px; fill: currentColor; display: block; }
dialog#account { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 0; width: min(440px, calc(100vw - 32px)); max-height: 85vh; }
dialog#account::backdrop { background: rgba(0, 0, 0, .55); }
dialog#account .head { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
dialog#account .head b { flex: 1; font-size: 15px; }
dialog#account .head button { padding: 2px 8px; }
dialog#account .body { padding: 14px 18px 16px; font-size: 14px; line-height: 1.45; overflow: auto; max-height: calc(85vh - 52px); }
dialog#account p { margin: 0 0 12px; }
dialog#account .muted { color: var(--muted); font-size: 13px; }
dialog#account a { color: var(--accent); }
dialog#account .tabs { display: flex; gap: 6px; margin-bottom: 14px; }
dialog#account .tabs button { flex: 1; }
dialog#account .col { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
dialog#account .col button, dialog#account a.btn { padding: 8px 12px; }
dialog#account a.btn { display: block; text-align: center; color: var(--text); background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; }
dialog#account a.btn:hover { background: #46423d; }
dialog#account label.consent { display: flex; gap: 8px; align-items: flex-start; margin: 4px 0 2px; cursor: pointer; }
dialog#account label.consent input { margin-top: 3px; }
dialog#account .note { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin-bottom: 12px; }
dialog#account .note.bad { border-color: var(--c-blunder); }
dialog#account .ids { list-style: none; padding: 0; margin: 0 0 12px; }
dialog#account .ids li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
dialog#account .ids li span { flex: 1; }
dialog#account .ids button { padding: 2px 8px; font-size: 12px; }
dialog#account hr { border: 0; border-top: 1px solid var(--line); margin: 14px 0; }
dialog#account .danger { background: var(--c-blunder); border-color: var(--c-blunder); color: #fff; font-weight: 600; }
dialog#account input[type=email], dialog#account input[type=password], dialog#account #acc-code { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
dialog#account input:focus { outline: none; border-color: var(--accent); }
dialog#account #acc-code { letter-spacing: .3em; text-align: center; font-size: 18px; }
dialog#account .or { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; margin: 4px 0; }
dialog#account .or::before, dialog#account .or::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
dialog#account .foot { display: flex; gap: 14px; justify-content: center; margin-top: 12px; font-size: 13px; }
`;
  const ICON = '<svg viewBox="0 0 24 24"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5z"/></svg>';
  let btn, dlg, view = { tab: 'login', note: null, confirmDelete: false };

  function render() {
    if (!btn) return;
    btn.innerHTML = ICON + `<span class="t">${me ? esc(shortName()) : 'Log in'}</span>`;
    btn.title = me ? 'Your account' : 'Log in or sign up to keep your puzzle progress';
    renderDialog();
  }
  const shortName = () => (me.identities[0] || {}).name || 'Account';

  function open(opts = {}) {
    view = { tab: view.tab, note: null, confirmDelete: false, offer: view.offer, ...opts };
    renderDialog();
    if (!dlg.open) dlg.showModal();
  }

  // ---------- the dialog ----------

  function providerButtons(mode, disabled) {
    return providers.map(p => `<button class="${mode === 'signup' ? 'primary' : ''}" data-go="${p.id}" data-mode="${mode}"${disabled ? ' disabled' : ''}>` +
      `${mode === 'signup' ? 'Sign up' : 'Log in'} with ${esc(p.name)}</button>`).join('');
  }
  const note = () => view.note ? `<div class="note${view.note.bad ? ' bad' : ''}">${view.note.html}</div>` : '';
  const legal = '<div class="foot"><a href="privacy.html" target="_blank">Privacy policy</a><a href="terms.html" target="_blank">Terms of use</a></div>';

  // ---- email and password (worker/src/email.js): forms, and the step where the emailed code is typed in ----
  const PROVIDER_NAMES = { lichess: 'Lichess', google: 'Google', email: 'Email' };
  const emailInput = (auto = 'email') => `<input id="acc-email" type="email" placeholder="Email address" autocomplete="${auto}" value="${esc(view.email || '')}" required>`;
  const passwordInput = (auto, placeholder = 'Password') => `<input id="acc-pw" type="password" placeholder="${placeholder}" autocomplete="${auto}" minlength="${minPassword}" required>`;
  const or = () => (providers.length ? '<div class="or"><span>or</span></div>' : '');
  const codeInput = '<input id="acc-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" required>';

  function stepBody() {
    const s = view.step;
    if (s.kind === 'code') {
      return `<p>We sent a 6-digit code to <b>${esc(s.email)}</b>. It works for 15 minutes.</p>` +
        `<form data-form="verify" class="col">${codeInput}<button class="primary">${s.purpose === 'link' ? 'Add this address' : 'Create my account'}</button></form>` +
        '<p class="muted">Nothing came? Check the spam folder, or <a href="#" data-act="resend">send a new code</a>. <a href="#" data-act="back">Back</a></p>';
    }
    if (s.kind === 'forgot') {
      return '<p>Type your email address and we will send you a code to set a new password.</p>' +
        `<form data-form="forgot" class="col">${emailInput()}<button class="primary">Send the code</button></form>` +
        '<p class="muted"><a href="#" data-act="back">Back to log in</a></p>';
    }
    if (s.kind === 'reset') {
      return `<p>If <b>${esc(s.email)}</b> has a Blundr account, a code is on its way.</p>` +
        `<form data-form="reset" class="col">${codeInput}${passwordInput('new-password', `New password (at least ${minPassword} characters)`)}<button class="primary">Set the new password</button></form>` +
        '<p class="muted">Setting a new password logs you out everywhere else. <a href="#" data-act="resend">Send a new code</a> · <a href="#" data-act="back">Back</a></p>';
    }
    if (s.kind === 'link') {
      return '<p>Add an email address and password, to log in with them as well.</p>' +
        `<form data-form="link" class="col">${emailInput()}${passwordInput('new-password', `Password (at least ${minPassword} characters)`)}<button class="primary">Send me a code</button></form>` +
        '<p class="muted"><a href="#" data-act="back">Back</a></p>';
    }
    return '';
  }

  function guestBody() {
    const signup = view.tab === 'signup';
    if (view.step) return note() + stepBody() + legal;
    return note() +
      `<div class="tabs"><button data-tab="login" class="${signup ? '' : 'active'}">Log in</button><button data-tab="signup" class="${signup ? 'active' : ''}">Sign up</button></div>` +
      '<p>An account keeps your <b>puzzle progress</b> (puzzle rating, packs, the daily streak and review schedules) and your <b>list of profiles</b>, so they follow you to other browsers, where the games are fetched again. ' +
      'Your reviewed games stay in this browser and are never uploaded. Everything on Blundr works without an account.</p>' +
      (signup
        ? '<label class="consent"><input type="checkbox" id="acc-consent"> <span>I am 15 or older and agree to the <a href="terms.html" target="_blank">terms of use</a> and the <a href="privacy.html" target="_blank">privacy policy</a>.</span></label>' +
          `<form data-form="signup" class="col">${emailInput()}${passwordInput('new-password', `Password (at least ${minPassword} characters)`)}` +
          '<button class="primary" data-mode="signup" disabled>Sign up with email</button></form>' +
          `${or()}<div class="col">${providerButtons('signup', true)}</div>` +
          "<p class=\"muted\">If this browser has puzzle progress or profiles, you'll be asked whether to add them to the new account.</p>"
        : `<form data-form="login" class="col">${emailInput()}${passwordInput('current-password')}<button class="primary">Log in</button></form>` +
          '<p class="muted"><a href="#" data-act="toforgot">Forgot password?</a></p>' +
          `${or()}<div class="col">${providerButtons('login', false)}</div>` +
          '<p class="muted">You get your account\'s progress and profiles. What you did here as a guest is set aside, not added to the account, and comes back when you log out.</p>') +
      legal;
  }

  async function emailCall(step, body) {
    const r = await post(`account/email/${step}`, body);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }

  // signed in by email: the session cookie came with the answer
  function signedIn(user, html) {
    me = user;
    view = { tab: 'login', confirmDelete: false, offer: null, step: null, note: html ? { html } : null };
    render();
    if (!html) dlg.close();
    attach().catch(e => { syncError = String(e.message || e); renderDialog(); });
  }

  async function submitForm(name) {
    const val = id => (dlg.querySelector('#' + id) || {}).value || '';
    const s = view.step || {};
    if (name === 'signup') {
      view.email = val('acc-email').trim();
      const password = val('acc-pw');
      await emailCall('signup', { email: view.email, password, consent: CONSENT });
      view.step = { kind: 'code', purpose: 'signup', email: view.email, password };
      view.note = null;
    } else if (name === 'verify') {
      const d = await emailCall('verify', { email: s.email, code: val('acc-code'), purpose: s.purpose });
      if (s.purpose === 'link') {
        me = { ...me, ...d.user };
        view.step = null;
        view.note = { html: `Done: you can now log in with ${esc(s.email)} too.` };
      } else {
        return signedIn(d.user, OUTCOMES.welcome.html);
      }
    } else if (name === 'login') {
      view.email = val('acc-email').trim();
      const d = await emailCall('login', { email: view.email, password: val('acc-pw') });
      return signedIn(d.user, null);
    } else if (name === 'forgot') {
      view.email = val('acc-email').trim();
      await emailCall('forgot', { email: view.email });
      view.step = { kind: 'reset', email: view.email };
      view.note = null;
    } else if (name === 'reset') {
      const d = await emailCall('reset', { email: s.email, code: val('acc-code'), password: val('acc-pw') });
      return signedIn(d.user, 'Your new password is set, and every other device has been logged out.');
    } else if (name === 'link') {
      view.email = val('acc-email').trim();
      const password = val('acc-pw');
      await emailCall('link', { email: view.email, password });
      view.step = { kind: 'code', purpose: 'link', email: view.email, password };
      view.note = null;
    }
    renderDialog();
  }

  async function resend() {
    const s = view.step;
    if (s.kind === 'reset') await emailCall('forgot', { email: s.email });
    else await emailCall(s.purpose === 'link' ? 'link' : 'signup', { email: s.email, password: s.password, consent: CONSENT });
    view.note = { html: 'A new code is on its way.' };
    renderDialog();
  }

  function accountBody() {
    if (view.step) return note() + stepBody() + legal;
    const ids = me.identities.map(i => `<li><span>${esc(i.name)} <span class="muted">(${PROVIDER_NAMES[i.provider] || esc(i.provider)})</span></span>` +
      (me.identities.length > 1 ? `<button data-unlink="${i.provider}">Remove</button>` : '') + '</li>').join('');
    const more = providers.filter(p => !me.identities.some(i => i.provider === p.id))
      .map(p => `<button data-go="${p.id}" data-mode="link">Also sign in with ${esc(p.name)}</button>`).join('') +
      (me.identities.some(i => i.provider === 'email') ? '' : '<button data-act="tolink">Also log in with an email and password</button>');
    const status = syncing ? 'Syncing…'
      : syncError ? `Last sync failed: ${esc(syncError)}`
      : lastSync ? `Synced at ${lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet (waiting for Python to load)';
    const del = view.confirmDelete
      ? '<div class="note bad"><p><b>Delete your account?</b> Your account and the puzzle progress and profile list stored with it are deleted from the server straight away. This cannot be undone.</p>' +
        '<label class="consent"><input type="checkbox" id="acc-wipe"> <span>Also remove this account\'s progress and profiles from this browser (otherwise they stay here as a guest\'s)</span></label>' +
        '<div class="col"><button class="danger" data-act="delete">Delete my account</button><button data-act="nodelete">Cancel</button></div></div>'
      : '<button data-act="askdelete">Delete account…</button>';
    if (view.offer) {
      const parts = [view.offer.puzzle_records && `${view.offer.puzzle_records} puzzle record${view.offer.puzzle_records > 1 ? 's' : ''}`, view.offer.profiles && `${view.offer.profiles} profile${view.offer.profiles > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
      return note() +
        `<div class="note"><p><b>Add this browser's progress to your new account?</b> You have ${parts} here from before you signed up.</p>` +
        '<div class="col"><button class="primary" data-act="keep">Yes, add it to my account</button>' +
        '<button data-act="fresh">No, start the account empty</button></div>' +
        "<p class=\"muted\">If you start empty, what you did as a guest is set aside in this browser and comes back when you log out.</p></div>" + legal;
    }
    return note() +
      `<p class="muted">Signed in with</p><ul class="ids">${ids}</ul>${more ? `<div class="col">${more}</div>` : ''}` +
      `<p>Puzzle progress and profiles: ${me.progress_lines || 0} records stored. <span class="muted">${status}</span></p>` +
      '<div class="col"><button data-act="sync">Sync now</button></div><hr>' +
      '<div class="col"><a class="btn" href="account/export" download="blundr-account.json">Download my data</a>' +
      '<button data-act="logout">Log out</button>' +
      '<button data-act="logout-wipe" title="For a shared computer">Log out and remove my progress and profiles from this browser</button>' +
      `${del}</div>` +
      `<p class="muted">Account created ${new Date(me.created_at * 1000).toLocaleDateString()}. Reviewed games and engine analysis never leave this browser.</p>` +
      legal;
  }

  function renderDialog() {
    if (!dlg) return;
    dlg.innerHTML = `<div class="head"><b>${me ? 'Your account' : view.tab === 'signup' ? 'Sign up' : 'Log in'}</b><button data-act="close" title="Close">✕</button></div>` +
      `<div class="body">${me ? accountBody() : guestBody()}</div>`;
  }

  async function act(name) {
    if (name === 'close') return dlg.close();
    if (name === 'sync') { const s = sync(); renderDialog(); return s; }
    if (name === 'askdelete' || name === 'nodelete') { view.confirmDelete = name === 'askdelete'; return renderDialog(); }
    if (name === 'keep' || name === 'fresh') { await answerOffer(name === 'keep'); return renderDialog(); }
    if (name === 'toforgot') { view.step = { kind: 'forgot' }; view.note = null; return renderDialog(); }
    if (name === 'tolink') { view.step = { kind: 'link' }; view.note = null; return renderDialog(); }
    if (name === 'back') { view.step = null; view.note = null; return renderDialog(); }
    if (name === 'resend') return resend();
    if (name === 'logout' || name === 'logout-wipe') {
      await post('account/logout');
      me = null;
      attached = false;
      view.tab = 'login';
      render();
      dlg.close();
      say('Logging out…');
      await handOver({ user: null, wipe: name === 'logout-wipe' });     // the guest's own data comes back
      say(name === 'logout-wipe' ? 'Logged out; your progress and profiles were removed from this browser' : 'Logged out');
      return;
    }
    if (name === 'delete') {
      const wipe = dlg.querySelector('#acc-wipe').checked;
      const res = await post('account/delete');
      if (!res.ok) { view.note = { bad: true, html: 'Deleting the account failed. Please try again.' }; return renderDialog(); }
      me = null;
      attached = false;
      await handOver({ wipe }, 'api/sync/release');
      view = { tab: 'login', confirmDelete: false, note: { html: 'Your account and its data have been deleted from the server.' + (wipe ? ' Its progress and profiles were removed from this browser too.' : ' Its progress and profiles stay in this browser for you to use as a guest.') } };
      render();
    }
  }

  function wire() {
    dlg.addEventListener('click', async e => {
      const el = e.target.closest('[data-tab],[data-go],[data-act],[data-unlink]');
      if (!el || el.disabled) return;
      if (el.dataset.tab) { view.tab = el.dataset.tab; view.note = null; return renderDialog(); }
      if (el.dataset.go) {
        const q = new URLSearchParams({ mode: el.dataset.mode });
        if (el.dataset.mode === 'signup') q.set('consent', CONSENT);
        location.href = `account/login/${el.dataset.go}?${q}`;
        return;
      }
      if (el.dataset.unlink) {
        const r = await post(`account/unlink/${el.dataset.unlink}`);
        const d = await r.json();
        if (r.ok) me = { ...me, ...d.user }; else view.note = { bad: true, html: esc(d.error) };
        return render();
      }
      e.preventDefault();          // the links in the email steps
      el.disabled = true;
      try { await act(el.dataset.act); } catch (err) { view.note = { bad: true, html: esc(err.message) }; renderDialog(); } finally { el.disabled = false; }
    });
    dlg.addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target.closest('form[data-form]');
      const b = form.querySelector('button');
      b.disabled = true;
      try { await submitForm(form.dataset.form); } catch (err) { view.note = { bad: true, html: esc(err.message) }; renderDialog(); } finally { b.disabled = false; }
    });
    dlg.addEventListener('change', e => {
      if (e.target.id === 'acc-consent') dlg.querySelectorAll('[data-mode="signup"]').forEach(b => { b.disabled = !e.target.checked; });
    });
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });     // a click on the backdrop
  }

  // Back from the provider: /?account=<outcome> (worker/src/index.js callback()).
  const OUTCOMES = {
    'welcome': { html: 'Welcome to Blundr! Your puzzle progress and profiles are now saved to your account.' },
    'linked': { html: 'Done: you can now sign in that way too.' },
    'no-account': { tab: 'signup', html: 'There is no Blundr account for that sign-in yet. Sign up below to create one.' },
    'taken': { bad: true, html: 'That sign-in already belongs to another Blundr account.' },
    'cancelled': { html: 'Sign-in cancelled.' },
    'error': { bad: true, html: "Signing in didn't work. Please try again." },
  };
  function outcome() {
    const q = new URLSearchParams(location.search);
    const o = q.get('account');
    if (!o) return;
    q.delete('account');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    if (o === 'signed-in') return say('Logged in. Your puzzle progress will sync.');
    const n = OUTCOMES[o];
    if (n) open({ tab: n.tab || 'login', note: { bad: n.bad, html: n.html } });
  }

  async function start() {
    document.head.appendChild(css);
    const right = document.querySelector('header .right');
    btn = document.createElement('button');
    btn.id = 'b-account';
    btn.addEventListener('click', () => open());
    if (right) right.appendChild(btn);
    dlg = document.createElement('dialog');
    dlg.id = 'account';
    document.body.appendChild(dlg);
    wire();
    try {
      const d = await getJSON('account/me');
      me = d.user;
      providers = d.providers || [];
      minPassword = d.min_password || minPassword;
    } catch (e) {
      btn.classList.add('hidden');      // no account service (the plain static site): nothing to offer
      return;
    }
    render();
    outcome();
    if (me) attach().catch(e => { syncError = String(e.message || e); console.error('account attach', e); renderDialog(); });
    // another tab or browser may have moved on: catch up when this tab comes back into view
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && me) syncSoon(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
