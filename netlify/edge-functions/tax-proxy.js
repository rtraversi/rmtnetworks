// netlify/edge-functions/tax-proxy.js
//
// Authenticated streaming proxy to the Anthropic Messages API, used by
// /tax.html so the API key never reaches the browser.
//
// Why an EDGE function and not a regular Netlify function:
//   - Regular synchronous functions time out at 10s (26s max on request), and
//     STREAMED function responses are capped at 10s. A full tax-return
//     analysis takes minutes.
//   - Edge functions limit CPU time (50ms) rather than wall-clock, and only
//     require response *headers* within 40s. We never parse the body — we
//     forward the raw bytes and pipe the SSE stream straight back — so CPU
//     use is negligible and the request can run as long as the model needs.
//
// The request body is whatever the client built for POST /v1/messages. This is
// deliberate: the prompt lives in tax.html (behind the login gate) and isn't a
// secret; the only thing that must stay server-side is the API key.
//
// Env: ANTHROPIC_TAX_API   (preferred)  — Anthropic API key
//      ANTHROPIC_DEED_API  (fallback)   — reuses the existing key if set
//      SUPABASE_URL — portal sessions are Supabase Auth JWTs (aal2)

const MAX_BODY_BYTES = 12 * 1024 * 1024; // ~8MB of PDF once base64-encoded

// Firefox aborts a text/event-stream response with "Error in input stream" when
// roughly 7.5s pass with no bytes on the wire. Adaptive thinking at high effort
// goes quiet for far longer than that while it reads the return, so long
// analyses died mid-stream in Firefox but not Chrome or Safari. Anthropic's own
// `ping` events don't come often enough to stay under the threshold, so we
// inject our own comment lines. 5s is the interval reported to hold the
// connection open reliably.
//   https://github.com/enisdenjo/graphql-sse/issues/99
const KEEPALIVE_MS = 4000;
const KEEPALIVE = new TextEncoder().encode(': keepalive\n\n');
const LF = 10;

/**
 * Forwards an SSE stream unchanged, adding comment lines during quiet periods.
 *
 * Comments are only emitted when the bytes sent so far end on an event
 * boundary ("\n\n"). A read can land mid-event, and splicing a comment into a
 * half-delivered event would corrupt the client's parse of it. If the stream is
 * mid-event, bytes are flowing anyway, so skipping that tick costs nothing.
 */
function withKeepalive(body) {
  const reader = body.getReader();
  let timer = null;
  let done = false;
  let prev = LF, last = LF; // trailing two bytes; a fresh stream counts as a boundary

  const stopTimer = () => { if (timer !== null) { clearInterval(timer); timer = null; } };

  return new ReadableStream({
    start(controller) {
      timer = setInterval(() => {
        if (done || prev !== LF || last !== LF) return;
        try { controller.enqueue(KEEPALIVE); } catch (_) { done = true; stopTimer(); }
      }, KEEPALIVE_MS);

      (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const v = chunk.value;
            if (!v || !v.length) continue;
            if (v.length === 1) { prev = last; last = v[0]; }
            else { prev = v[v.length - 2]; last = v[v.length - 1]; }
            controller.enqueue(v);
          }
          done = true; stopTimer();
          controller.close();
        } catch (e) {
          done = true; stopTimer();
          try { controller.error(e); } catch (_) { /* already errored */ }
        }
      })();
    },
    cancel(reason) {
      done = true; stopTimer();
      return reader.cancel(reason);
    },
  });
}

// --- Supabase session check -------------------------------------------------
// Edge-runtime twin of lib/portal-auth.js (that one is CommonJS + node:crypto).
// Verifies the ES256 access token against the project's JWKS with WebCrypto and
// returns app_metadata.portal_user, or null. Keep the two in step.
const JWKS_TTL_MS = 10 * 60 * 1000;
let jwks = { keys: new Map(), fetchedAt: 0 };

function authBase() {
  return (Netlify.env.get('SUPABASE_URL') || '').replace(/\/+$/, '') + '/auth/v1';
}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function loadJwks(force) {
  if (!force && jwks.keys.size && Date.now() - jwks.fetchedAt < JWKS_TTL_MS) return jwks.keys;
  const res = await fetch(authBase() + '/.well-known/jwks.json');
  if (!res.ok) throw new Error('JWKS fetch failed: HTTP ' + res.status);
  const { keys = [] } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.kid) continue;
    const { kty, crv, x, y } = jwk;
    map.set(jwk.kid, await crypto.subtle.importKey(
      'jwk', { kty, crv, x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
  }
  jwks = { keys: map, fetchedAt: Date.now() };
  return map;
}

async function portalUser(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return null; }
  if (header.alg !== 'ES256' || !header.kid) return null;

  let key = (await loadJwks(false)).get(header.kid);
  if (!key) key = (await loadJwks(true)).get(header.kid);
  if (!key) return null;

  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + 30 < now) return null;
  if (claims.iss !== authBase()) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes('authenticated') || claims.role !== 'authenticated') return null;
  if (claims.aal !== 'aal2') return null;
  // TOTP step must be under 30 days old (MFA_MAX_AGE_DAYS in portal-auth.js).
  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  const totp = amr.filter((a) => a && a.method === 'totp' && typeof a.timestamp === 'number')
    .reduce((max, a) => Math.max(max, a.timestamp), 0);
  if (!totp || now - totp > 30 * 86400) return null;
  return (claims.app_metadata && claims.app_metadata.portal_user) || null;
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'POST required' });

  // Same Supabase sessions the rest of the portal uses (aal2 required). Max is
  // deliberately not included — the Clients app is the only thing he can reach.
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const user = token ? await portalUser(token).catch((e) => {
    console.error('tax-proxy auth: ' + e.message);
    return null;
  }) : null;
  if (user !== 'Rob' && user !== 'Katy') {
    return json(401, { error: 'Unauthorized' });
  }

  const apiKey = Netlify.env.get('ANTHROPIC_TAX_API') || Netlify.env.get('ANTHROPIC_DEED_API');
  if (!apiKey) {
    return json(503, {
      error: 'Anthropic API key not configured',
      hint: 'Set ANTHROPIC_TAX_API in the Netlify environment variables.',
    });
  }

  // Read the body as bytes. No JSON.parse — a multi-megabyte parse would eat
  // the 50ms CPU budget, and we have nothing to add to the body anyway.
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json(413, {
      error: `Request too large (${(body.byteLength / 1048576).toFixed(1)}MB). Upload a smaller PDF.`,
    });
  }

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    });
  } catch (e) {
    return json(502, { error: 'Could not reach the Anthropic API: ' + (e && e.message) });
  }

  // Anthropic's per-request identifier. Forwarded so the browser can show it
  // on failure — a stream that dies mid-response is only diagnosable upstream
  // by this id, and it's gone once the response is piped through.
  const requestId = upstream.headers.get('request-id') || '';

  if (!upstream.ok) {
    console.error(`tax-proxy: upstream ${upstream.status}, request-id ${requestId || '(none)'}`);
  }

  const contentType = upstream.headers.get('content-type') || 'application/json';

  const headers = {
    'content-type': contentType,
    // no-transform tells intermediaries not to re-encode the body. Without it a
    // compressing CDN hop can hold a 13-byte keepalive comment in its buffer,
    // which defeats the point of sending one.
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
  };
  if (requestId) headers['x-anthropic-request-id'] = requestId;

  // Pipe the response through. An SSE stream gets keepalive comments during
  // quiet periods; anything else (an error payload) is forwarded untouched.
  const responseBody = upstream.body && contentType.includes('text/event-stream')
    ? withKeepalive(upstream.body)
    : upstream.body;

  return new Response(responseBody, { status: upstream.status, headers });
};

export const config = { path: '/api/tax-proxy' };
