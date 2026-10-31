// Portal authentication for Netlify functions.
//
// Browser sessions come from Supabase Auth (email + password + TOTP). The page
// sends the Supabase access token as `Authorization: Bearer <jwt>`, and this
// module verifies it locally against the project's JWKS (ES256). No network
// call per request once the key set is cached.
//
// A token is accepted only if ALL of these hold:
//   - ES256 signature verifies against a key in the project's JWKS
//   - iss is this project's Auth URL, aud/role are 'authenticated'
//   - not expired
//   - aal === 'aal2'                  (MFA completed for this session)
//   - app_metadata.portal_user is one of PORTAL_USERS
//     (app_metadata is admin-only; users cannot edit it themselves)
//
// The crm-log CLI can't hold an hourly-expiring JWT, so functions that the CLI
// calls opt in with { allowCli: true }, which also accepts the static
// RMT_CLI_TOKEN env var and treats the caller as Rob.
//
// Usage at the top of every handler:
//     const who = await authenticate(event);           // or { allowCli: true }
//     if (!who) return json(401, { error: 'Unauthorized' });
// After that, the sync helpers in max-scope.js (whoAmI / isMax / clientAllowed)
// read the identity that authenticate() stored on the event.
'use strict';

const crypto = require('crypto');

const PORTAL_USERS = ['Rob', 'Katy', 'Max'];
const JWKS_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 30;

let jwksCache = { keys: new Map(), fetchedAt: 0 };

function authBase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  return url ? url + '/auth/v1' : '';
}

async function loadJwks(force) {
  const fresh = Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (!force && fresh && jwksCache.keys.size) return jwksCache.keys;
  const res = await fetch(authBase() + '/.well-known/jwks.json');
  if (!res.ok) throw new Error('JWKS fetch failed: HTTP ' + res.status);
  const { keys = [] } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.kid) continue;
    map.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  }
  jwksCache = { keys: map, fetchedAt: Date.now() };
  return map;
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// Returns the verified claims, or null.
async function verifySupabaseJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'ES256' || !header.kid) return null;

  let keys = await loadJwks(false);
  let key = keys.get(header.kid);
  if (!key) {
    // Possibly a rotated key; refresh once.
    keys = await loadJwks(true);
    key = keys.get(header.kid);
    if (!key) return null;
  }

  const ok = crypto.verify(
    'sha256',
    Buffer.from(parts[0] + '.' + parts[1]),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[2], 'base64url')
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) return null;
  if (claims.iss !== authBase()) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes('authenticated') || claims.role !== 'authenticated') return null;
  return claims;
}

function bearer(event) {
  const raw = event.headers['authorization'] || event.headers['Authorization'] || '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Resolves the caller to 'Rob' | 'Katy' | 'Max', or null. Stores the result on
// event.rmtUser so max-scope.js can read it synchronously.
async function authenticate(event, opts = {}) {
  event.rmtUser = null;
  const token = bearer(event);
  if (!token) return null;

  if (opts.allowCli && process.env.RMT_CLI_TOKEN && safeEqual(token, process.env.RMT_CLI_TOKEN)) {
    event.rmtUser = 'Rob';
    event.rmtVia = 'cli';
    return 'Rob';
  }

  let claims;
  try {
    claims = await verifySupabaseJwt(token);
  } catch (e) {
    console.error('portal-auth: ' + e.message);
    return null;
  }
  if (!claims || claims.aal !== 'aal2') return null;

  const name = claims.app_metadata && claims.app_metadata.portal_user;
  if (!PORTAL_USERS.includes(name)) return null;

  event.rmtUser = name;
  event.rmtVia = 'supabase';
  event.rmtClaims = claims;
  return name;
}

module.exports = { authenticate, verifySupabaseJwt, PORTAL_USERS };
