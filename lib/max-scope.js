// Restricts the "Max" clients.html session to a single client's data.
// Every Netlify function Max's token can reach imports this so the scope
// policy lives in exactly one place. Update MAX_ALLOWED_CLIENT_ID if his
// access ever needs to move to a different client.
'use strict';

const MAX_ALLOWED_CLIENT_ID = '93deb5dc-a2a1-4ee5-9800-42a70b5f3db2'; // IURIX (BSBR Holdings, LLC)

function whoAmI(event) {
  const raw = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  if (process.env.SESSION_SECRET && token === process.env.SESSION_SECRET) return 'Rob';
  if (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET) return 'Katy';
  if (process.env.MAX_SESSION_SECRET && token === process.env.MAX_SESSION_SECRET) return 'Max';
  return null;
}

function isMax(event) {
  return whoAmI(event) === 'Max';
}

// True if this caller is allowed to touch this client_id. Non-Max callers
// (Rob/Katy) are always allowed; Max is allowed only for MAX_ALLOWED_CLIENT_ID.
function clientAllowed(event, clientId) {
  if (!isMax(event)) return true;
  return clientId === MAX_ALLOWED_CLIENT_ID;
}

module.exports = { MAX_ALLOWED_CLIENT_ID, whoAmI, isMax, clientAllowed };
