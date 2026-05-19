// /netlify/functions/list-deeds.js
//
// Returns the available "new deed" records for the dropdown in the demo UI.
// Backend selection is in /lib/deed-source.js (env DEED_SOURCE).

const { listDeeds, currentSource } = require('../../lib/deed-source');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    const deeds = await listDeeds();
    return json(200, { source: currentSource(), deeds });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
