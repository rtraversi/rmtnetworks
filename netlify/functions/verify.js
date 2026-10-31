// GET /.netlify/functions/verify
// Confirms the caller's Supabase session is accepted server-side (aal2 + a
// portal_user in app_metadata) and returns who they are. Pages use this to
// reveal user-scoped tiles; every data function re-checks on its own.
'use strict';
const { authenticate } = require('../../lib/portal-auth.js');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const user = await authenticate(event);
  if (!user) return json(401, { error: 'Unauthorized' });
  return json(200, { ok: true, user });
};
