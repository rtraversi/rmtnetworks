// CRUD for `client_tasks` + `client_milestone_items`.
//
// GET    ?client_id=<uuid>                                    → tasks (open/done), each with nested milestone items
// POST   body {client_id, is_milestone, title, ...}           → create a task/milestone
// PATCH  ?id=<uuid>  body {...}                                → update a task (edit, or status/completed_at toggle)
// DELETE ?id=<uuid>                                            → delete a task
//
// Milestone checklist items (task_id required, tasks own them):
// POST   ?resource=milestone-item  body {task_id, title}       → add a checklist item
// PATCH  ?resource=milestone-item&id=<uuid>  body {done}       → toggle a checklist item
// DELETE ?resource=milestone-item&id=<uuid>                    → delete a checklist item

'use strict';

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function authOk(event) {
  const raw = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  return (process.env.SESSION_SECRET && token === process.env.SESSION_SECRET) ||
         (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET) ||
         (process.env.MAX_SESSION_SECRET && token === process.env.MAX_SESSION_SECRET);
}

function whoAmI(event) {
  const raw = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (process.env.SESSION_SECRET && token === process.env.SESSION_SECRET) return 'Rob';
  if (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET) return 'Katy';
  if (process.env.MAX_SESSION_SECRET && token === process.env.MAX_SESSION_SECRET) return 'Max';
  return null;
}

function sbFetch(path, opts = {}) {
  return fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

const TASK_WRITABLE_FIELDS = ['title', 'description', 'due_date', 'assignee', 'status', 'completed_at'];

function pickWritable(body) {
  const row = {};
  for (const k of TASK_WRITABLE_FIELDS) if (k in body) row[k] = body[k];
  return row;
}

exports.handler = async (event) => {
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  const qp = event.queryStringParameters || {};
  const method = event.httpMethod;
  const resource = qp.resource === 'milestone-item' ? 'milestone-item' : 'task';

  try {
    if (method === 'GET') {
      if (!qp.client_id) return json(400, { error: 'client_id required' });
      const res = await sbFetch(
        `/client_tasks?client_id=eq.${encodeURIComponent(qp.client_id)}&select=*,client_milestone_items(*)` +
        `&order=status.asc,due_date.asc.nullslast,created_at.asc&client_milestone_items.order=sort_order.asc,created_at.asc`
      );
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (resource === 'milestone-item') {
      if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        if (!body.task_id || !body.title) return json(400, { error: 'task_id and title required' });
        const res = await sbFetch('/client_milestone_items', {
          method: 'POST', body: JSON.stringify({ task_id: body.task_id, title: body.title }),
        });
        if (!res.ok) return json(500, { error: await res.text() });
        return json(200, await res.json());
      }
      if (method === 'PATCH') {
        if (!qp.id) return json(400, { error: 'id required' });
        const body = JSON.parse(event.body || '{}');
        const patch = {};
        if ('done' in body) patch.done = !!body.done;
        const res = await sbFetch(`/client_milestone_items?id=eq.${encodeURIComponent(qp.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        if (!res.ok) return json(500, { error: await res.text() });
        return json(200, await res.json());
      }
      if (method === 'DELETE') {
        if (!qp.id) return json(400, { error: 'id required' });
        const res = await sbFetch(`/client_milestone_items?id=eq.${encodeURIComponent(qp.id)}`, { method: 'DELETE' });
        if (!res.ok) return json(500, { error: await res.text() });
        return json(200, { ok: true });
      }
      return json(405, { error: 'Method not allowed' });
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.client_id || !body.title) return json(400, { error: 'client_id and title required' });
      const row = pickWritable(body);
      row.client_id = body.client_id;
      row.is_milestone = !!body.is_milestone;
      row.created_by = whoAmI(event);
      const res = await sbFetch('/client_tasks', { method: 'POST', body: JSON.stringify(row) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'PATCH') {
      if (!qp.id) return json(400, { error: 'id required' });
      const body = JSON.parse(event.body || '{}');
      const patch = pickWritable(body);
      const res = await sbFetch(`/client_tasks?id=eq.${encodeURIComponent(qp.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'DELETE') {
      if (!qp.id) return json(400, { error: 'id required' });
      const res = await sbFetch(`/client_tasks?id=eq.${encodeURIComponent(qp.id)}`, { method: 'DELETE' });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
