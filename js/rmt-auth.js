// RMT portal session helper (Supabase Auth: email + password + TOTP).
//
// Load in <head> on every logged-in page, right after the vendored client:
//   <script src="/js/vendor/supabase-2.118.0.js"></script>
//   <script src="/js/rmt-auth.js"></script>
//   <script>RMTAuth.guard();</script>
//
// What it does:
//   - RMTAuth.guard([{ allow: [...] }]): hides nothing itself; checks for an MFA-verified (aal2)
//     session, confirms it with /verify, sets document.body.dataset.user and
//     makes the body visible. No session -> back to the login page.
//   - Wraps window.fetch so every same-origin call to /.netlify/functions/* or
//     /api/* carries a fresh access token (refreshed when near expiry) and is
//     retried once after a token refresh on 401. Pages therefore never hold a
//     token that can go stale; RMTAuth.token() is only there for readability.
//   - RMTAuth.signOut(): ends this browser's session and returns to login.
//
// The browser only ever has the publishable key. It cannot read tables: anon
// and authenticated have no grants (clients-schema-v14). All data goes through
// Netlify functions, which verify the token in lib/portal-auth.js.
(function () {
  'use strict';

  var SUPABASE_URL = 'https://enowrzljapjkaxpsvdhr.supabase.co';
  var PUBLISHABLE_KEY = 'sb_publishable_SXXPzDWeL7a6OQJJLCyX4A_JEX3Wi6U';
  var STORAGE_KEY = 'rmt-auth';
  var LOGIN_PATH = '/';

  // One password + authenticator sign-in lasts MFA_MAX_AGE_DAYS on this
  // browser. The session lives in localStorage so new tabs and browser
  // restarts reuse it; the functions (lib/portal-auth.js) refuse tokens whose
  // TOTP step is older than that, and guard() signs out locally to match.
  var MFA_MAX_AGE_DAYS = 30;
  var storage = (function () {
    try {
      var ls = window.localStorage;
      ls.setItem('rmt-probe', '1'); ls.removeItem('rmt-probe');
      // Carry over a session from the old sessionStorage setup once.
      try {
        var old = window.sessionStorage.getItem(STORAGE_KEY);
        if (old && !ls.getItem(STORAGE_KEY)) ls.setItem(STORAGE_KEY, old);
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch (e) { /* ignore */ }
      return ls;
    } catch (e) { return undefined; }
  })();

  function mfaFresh(claims) {
    var amr = (claims && Array.isArray(claims.amr)) ? claims.amr : [];
    var totp = 0;
    amr.forEach(function (a) { if (a && a.method === 'totp' && typeof a.timestamp === 'number' && a.timestamp > totp) totp = a.timestamp; });
    return totp > 0 && Date.now() / 1000 - totp <= MFA_MAX_AGE_DAYS * 86400;
  }

  var client = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { storageKey: STORAGE_KEY, storage: storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  function decodeClaims(jwt) {
    try {
      var p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var bin = atob(p + '==='.slice((p.length + 3) % 4));
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, function (c) { return c.charCodeAt(0); })));
    } catch (e) { return null; }
  }

  // Last stored access token, read synchronously. May be expired; the fetch
  // wrapper below swaps in a fresh one before the request leaves.
  function token() {
    try {
      var raw = storage && storage.getItem(STORAGE_KEY);
      var s = raw && JSON.parse(raw);
      return (s && s.access_token) || '';
    } catch (e) { return ''; }
  }

  function goLogin() {
    var here = location.pathname + location.search;
    var next = here && here !== '/' && here !== '/index.html' ? '?next=' + encodeURIComponent(here) : '';
    location.replace(LOGIN_PATH + next);
  }

  async function freshToken() {
    var res = await client.auth.getSession(); // refreshes if expired
    var s = res && res.data && res.data.session;
    return s ? s.access_token : '';
  }

  function needsAuth(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin &&
        (u.pathname.indexOf('/.netlify/functions/') === 0 || u.pathname.indexOf('/api/') === 0);
    } catch (e) { return false; }
  }

  var origFetch = window.fetch.bind(window);

  function send(input, init, tok) {
    var isReq = typeof Request !== 'undefined' && input instanceof Request;
    var headers = new Headers((init && init.headers) || (isReq ? input.headers : undefined));
    if (tok) headers.set('Authorization', 'Bearer ' + tok);
    else headers.delete('Authorization');
    if (isReq) return origFetch(new Request(input.clone(), Object.assign({}, init, { headers: headers })));
    return origFetch(input, Object.assign({}, init, { headers: headers }));
  }

  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : (input && (input.url || String(input)));
    if (!needsAuth(url)) return origFetch(input, init);

    var res = await send(input, init, await freshToken());
    if (res.status !== 401) return res;

    // Token may have been revoked or rotated mid-flight: refresh once and
    // retry. A 401 after that is a real "not allowed" (e.g. a Rob-only
    // endpoint called by Katy), so hand it back instead of logging out.
    var r = await client.auth.refreshSession();
    if (r.error || !r.data || !r.data.session) { goLogin(); return res; }
    return send(input, init, r.data.session.access_token);
  };

  // Resolves to { user: 'Rob'|'Katy'|'Max', email } once the session is
  // MFA-verified and accepted by the server; otherwise redirects to login.
  // opts.allow: optional list of users; anyone else goes to opts.otherwise
  // (default /portal.html, whose own guard sends Max on to /clients.html).
  // (UI only; the functions behind the page enforce the same rule.)
  var ready = null;
  function guard(opts) {
    opts = opts || {};
    if (ready) return ready;
    ready = (async function () {
      var res = await client.auth.getSession();
      var s = res && res.data && res.data.session;
      var claims = s && decodeClaims(s.access_token);
      if (!claims || claims.aal !== 'aal2') { goLogin(); return new Promise(function () {}); }
      if (!mfaFresh(claims)) {
        // 30 days are up: drop this browser's session so login starts clean.
        try { await client.auth.signOut({ scope: 'local' }); } catch (e) { /* ignore */ }
        goLogin(); return new Promise(function () {});
      }

      var who = null;
      try {
        var r = await window.fetch('/.netlify/functions/verify');
        if (r.status === 401) { await client.auth.signOut({ scope: 'local' }); goLogin(); return new Promise(function () {}); }
        if (r.ok) who = (await r.json()).user;
      } catch (e) { /* network blip: show the page; data calls re-check */ }

      var info = { user: who || (claims.app_metadata && claims.app_metadata.portal_user) || null, email: claims.email || '' };
      if (opts.allow && opts.allow.indexOf(info.user) === -1) { location.replace(opts.otherwise || '/portal.html'); return new Promise(function () {}); }
      onBody(function () {
        if (info.user) document.body.dataset.user = info.user;
        document.body.style.visibility = 'visible';
      });
      return info;
    })();
    return ready;
  }

  function onBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  async function signOut() {
    try { await client.auth.signOut({ scope: 'local' }); } catch (e) { /* ignore */ }
    try { storage && storage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    location.replace(LOGIN_PATH);
  }

  // Another tab signed out, or the refresh token was revoked.
  client.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT' && location.pathname !== LOGIN_PATH && location.pathname !== '/index.html') goLogin();
  });

  window.RMTAuth = { client: client, token: token, guard: guard, signOut: signOut, decodeClaims: decodeClaims, mfaFresh: mfaFresh };
})();
