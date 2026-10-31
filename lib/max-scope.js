// Restricts the "Max" clients.html session to a single client's data.
// Every Netlify function Max's token can reach imports this so the scope
// policy lives in exactly one place. Update MAX_ALLOWED_CLIENT_ID if his
// access ever needs to move to a different client.
'use strict';

const MAX_ALLOWED_CLIENT_ID = '93deb5dc-a2a1-4ee5-9800-42a70b5f3db2'; // IURIX (BSBR Holdings, LLC)

// Identity is resolved by lib/portal-auth.js authenticate(), which every
// handler awaits first. Without that call this returns null (fail closed).
function whoAmI(event) {
  return event.rmtUser || null;
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
