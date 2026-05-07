// Called Sunday 9am ET via GitHub Actions to keep Supabase from auto-pausing.
// (The daily fetch-usage calls already prevent pausing — this is a safety net.)
// Auth: Authorization: Bearer <CRON_SECRET>
exports.handler = async (event) => {
  const auth = (event.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.CRON_SECRET || auth !== process.env.CRON_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/subscriptions?select=id&limit=1`,
      {
        headers: {
          'apikey': process.env.SUPABASE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        },
      }
    );
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinged: true, status: res.status, time: new Date().toISOString() }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ pinged: false, error: e.message }),
    };
  }
};
