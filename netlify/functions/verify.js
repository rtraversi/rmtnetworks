exports.handler = async (event) => {
  const auth  = event.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (process.env.SESSION_SECRET && token === process.env.SESSION_SECRET) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, user: 'Rob' }) };
  }

  if (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, user: 'Katy' }) };
  }

  if (process.env.MAX_SESSION_SECRET && token === process.env.MAX_SESSION_SECRET) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, user: 'Max' }) };
  }

  return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
};
