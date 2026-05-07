exports.handler = async (event) => {
  const auth  = event.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  if (!token || !process.env.SESSION_SECRET || token !== process.env.SESSION_SECRET) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
};
