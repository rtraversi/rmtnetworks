// Returns public Supabase config so credentials stay out of the repo.
exports.handler = async (event) => {
  const auth = (event.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const token = sessionStorage && sessionStorage.getItem && sessionStorage.getItem('rmt_session');

  // Light auth — same CRON_SECRET isn't right here, just verify session token via verify function
  // For simplicity: open endpoint since these are publishable keys (anon/public Supabase key)
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_KEY,
    }),
  };
};
