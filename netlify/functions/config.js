// Returns Supabase config so credentials stay out of the repo.
// Serves the publishable key only. SUPABASE_KEY is the secret key used by the
// server-side functions and must never reach a browser. Still gated to Rob/Katy
// sessions while RLS allows anon access (not to anonymous callers or Max).
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
      supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    }),
  };
};
