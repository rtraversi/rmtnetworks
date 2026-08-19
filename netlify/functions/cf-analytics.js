// cf-analytics.js — Rob-only Cloudflare Web Analytics summary for the portal tile.
//
// GET  Authorization: Bearer <rmt session token>
//
// Returns visitor numbers collected by the Cloudflare Web Analytics beacon that
// sits on the public pages (added 2026-08-19):
//   visits_24h, pageviews_24h, visits_7d, pageviews_7d
//   top_pages [{ path, pageviews }]  — best effort, see below
//   site_tag, note
//
// WHY CLOUDFLARE AND NOT THE OLD track-hit COUNTER
//
// netlify/functions/track-hit.js increments a single integer in Supabase per
// page. It cannot tell you two visits from one person reloading, it has no
// referrer, no country, no time dimension, and it only covers three pages. The
// beacon collects all of that for free, so this function reads from there
// instead. track-hit is left in place for now — retiring it is a separate call.
//
// WHAT THIS CANNOT DO
//
// Cloudflare's RUM data is aggregate and cookieless by design. There are no
// per-visitor trails and no custom events, so "who looked at the deed demo and
// then clicked through" is not answerable here. That would need our own events
// table, the way demo.iurisiq.com does it.
//
// TOP PAGES IS DELIBERATELY BEST EFFORT
//
// The totals use only fields the dataset is documented to expose. The top-pages
// breakdown groups by a dimension whose exact name has moved before, and a bad
// field name fails the WHOLE GraphQL document — which would take the totals down
// with it. So it is a second, separate request: if it fails, the tile still
// shows real numbers and reports why the breakdown is missing, rather than
// showing nothing at all.

'use strict';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const REST_BASE   = 'https://api.cloudflare.com/client/v4';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const json = (status, body) => ({
  statusCode: status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Same guard as stripe-metrics.js — Rob's token only.
function isRob(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  if (!process.env.SESSION_SECRET) return false;
  return token === process.env.SESSION_SECRET;
}

// Site tag survives between invocations on a warm lambda. It changes only when
// the site is recreated in Cloudflare, so re-looking it up on every request
// would be a wasted round trip on the critical path of a dashboard tile.
let cachedSiteTag = null;

async function cfFetch(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

/**
 * Find the Web Analytics site tag for rmtnetworks.
 *
 * The beacon token in the page and the site tag the API wants are DIFFERENT
 * identifiers, which is an easy hour to lose. CF_SITE_TAG can pin it; otherwise
 * we list the account's sites and match on host.
 */
async function resolveSiteTag(accountId, token) {
  if (process.env.CF_SITE_TAG) return process.env.CF_SITE_TAG;
  if (cachedSiteTag) return cachedSiteTag;

  const body = await cfFetch(`${REST_BASE}/accounts/${accountId}/rum/site_info/list`, token);
  const sites = body?.result || [];
  if (!sites.length) {
    throw new Error('No Web Analytics sites exist on this Cloudflare account');
  }

  const hostOf = (s) => s?.ruleset?.zone_name || s?.host || '';
  const match = sites.find((s) => hostOf(s).includes('rmtnetworks')) ||
                (sites.length === 1 ? sites[0] : null);

  if (!match) {
    // Refusing to guess: picking an arbitrary site would report another
    // property's traffic as this one's, which is worse than an error.
    throw new Error(
      `Could not identify the rmtnetworks site among ${sites.length} Web Analytics sites ` +
      `(${sites.map(hostOf).filter(Boolean).join(', ')}). Set CF_SITE_TAG to pin it.`
    );
  }

  cachedSiteTag = match.site_tag;
  return cachedSiteTag;
}

const TOTALS_QUERY = `
  query RmtTotals($accountTag: string!, $siteTag: string!, $since24h: Time!, $since7d: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        last24h: rumPageloadEventsAdaptiveGroups(
          limit: 1
          filter: { siteTag: $siteTag, datetime_geq: $since24h, datetime_lt: $until }
        ) {
          count
          sum { visits }
        }
        last7d: rumPageloadEventsAdaptiveGroups(
          limit: 1
          filter: { siteTag: $siteTag, datetime_geq: $since7d, datetime_lt: $until }
        ) {
          count
          sum { visits }
        }
      }
    }
  }
`;

const TOP_PAGES_QUERY = `
  query RmtTopPages($accountTag: string!, $siteTag: string!, $since7d: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        rumPageloadEventsAdaptiveGroups(
          limit: 10
          orderBy: [count_DESC]
          filter: { siteTag: $siteTag, datetime_geq: $since7d, datetime_lt: $until }
        ) {
          count
          dimensions { requestPath }
        }
      }
    }
  }
`;

async function graphql(token, query, variables) {
  const body = await cfFetch(GRAPHQL_URL, token, {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  // GraphQL reports field errors with HTTP 200 and a populated errors array, so
  // a plain res.ok check is not enough.
  if (body?.errors?.length) throw new Error(body.errors[0].message);
  return body?.data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };
  if (event.httpMethod !== 'GET')     return json(405, { error: 'Method not allowed' });

  if (!isRob(event.headers?.authorization || event.headers?.Authorization)) {
    return json(401, { error: 'Unauthorized' });
  }

  const accountId = process.env.CF_ACCOUNT_ID;
  const token     = process.env.CF_API_TOKEN;

  if (!accountId || !token) {
    // Report WHICH one is missing, never the values. "Set both" sends you to
    // re-check two things when only one is wrong, and the usual cause — a
    // Netlify env var whose scope excludes Functions — looks correct in the UI.
    const missing = [
      !accountId && 'CF_ACCOUNT_ID',
      !token     && 'CF_API_TOKEN',
    ].filter(Boolean);

    return json(503, {
      error: 'Cloudflare Web Analytics not configured',
      hint:  `Function cannot read: ${missing.join(' + ')}. ` +
             `(CF_ACCOUNT_ID ${accountId ? 'visible' : 'MISSING'}, ` +
             `CF_API_TOKEN ${token ? 'visible' : 'MISSING'}) — ` +
             `check the variable's Scopes include Functions, then redeploy.`,
    });
  }

  const now      = new Date();
  const until    = now.toISOString();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since7d  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString();

  let siteTag;
  try {
    siteTag = await resolveSiteTag(accountId, token);
  } catch (e) {
    // Stage-prefixed: this call and the GraphQL one below fail with the same
    // Cloudflare wording ("Authentication error") for different reasons, and
    // they need different fixes — this one can be skipped entirely with
    // CF_SITE_TAG, the other cannot.
    return json(503, {
      error: 'Could not resolve the Web Analytics site',
      hint:  `[site lookup] ${e.message}`,
    });
  }

  let totals;
  try {
    const data = await graphql(token, TOTALS_QUERY, {
      accountTag: accountId, siteTag, since24h, since7d, until,
    });
    const acct = data?.viewer?.accounts?.[0] || {};
    totals = {
      pageviews_24h: acct.last24h?.[0]?.count ?? 0,
      visits_24h:    acct.last24h?.[0]?.sum?.visits ?? 0,
      pageviews_7d:  acct.last7d?.[0]?.count ?? 0,
      visits_7d:     acct.last7d?.[0]?.sum?.visits ?? 0,
    };
  } catch (e) {
    // A token missing "Account Analytics: Read" lands here, and the message
    // Cloudflare returns says so — worth passing through rather than flattening
    // into a generic failure.
    return json(502, { error: "Cloudflare analytics query failed", hint: `[graphql] ${e.message}` });
  }

  let topPages = null;
  let topPagesError = null;
  try {
    const data = await graphql(token, TOP_PAGES_QUERY, {
      accountTag: accountId, siteTag, since7d, until,
    });
    const rows = data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
    topPages = rows.map((r) => ({
      path:      r.dimensions?.requestPath || '/',
      pageviews: r.count ?? 0,
    }));
  } catch (e) {
    topPagesError = e.message;
  }

  return json(200, {
    ...totals,
    top_pages:       topPages,
    top_pages_error: topPagesError,
    site_tag:        siteTag,
    // Zero everywhere is a legitimate answer for a beacon installed today, and
    // it is indistinguishable from a broken install without saying so.
    note: totals.pageviews_7d === 0
      ? 'No pageviews recorded yet. The beacon is blocked by most ad blockers and by Firefox strict mode, so your own visits may not count.'
      : null,
  });
};
