// Returns Supabase config so credentials stay out of the repo.
// Gated to Rob/Katy sessions: SUPABASE_KEY bypasses RLS, so it must never be
// served to an anonymous caller (or to Max's single-client session).
const { whoAmI, isMax } = require('../../lib/max-scope.js');

exports.handler = async (event) => {
  if (!whoAmI(event) || isMax(event)) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_KEY,
    }),
  };
};
