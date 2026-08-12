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
//      SESSION_SECRET / KATY_SESSION_SECRET — portal session tokens

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

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'POST required' });

  // Same session tokens the rest of the portal uses. Max is deliberately not
  // included — the Clients app is the only thing he can reach.
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const allowed = [
    Netlify.env.get('SESSION_SECRET'),
    Netlify.env.get('KATY_SESSION_SECRET'),
  ].filter(Boolean);

  if (!token || !allowed.includes(token)) {
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
