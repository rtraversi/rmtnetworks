// twilio-client.js — Per-client Twilio usage proxy.
// Reads encrypted Twilio credentials from client_integrations via integrations.js pattern,
// then calls the Twilio Usage API and returns structured usage data.
//
// GET /.netlify/functions/twilio-client?client_id=<uuid>&period=this_month|monthly|daily
// Authorization: Bearer <session token>

'use strict';

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const json = (status, body) => ({
  statusCode: status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function authOk(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  return (process.env.SESSION_SECRET      && token === process.env.SESSION_SECRET) ||
         (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET);
}

function getKey() {
  const hex = process.env.SECRETS_KEY || '';
  if (hex.length !== 64) throw new Error('SECRETS_KEY missing or not 64 hex chars');
  return Buffer.from(hex, 'hex');
}

function decrypt(blob) {
  if (!blob) return '';
  const [ivHex, dataHex, tagHex] = String(blob).split(':');
  if (!ivHex || !dataHex || !tagHex) throw new Error('Malformed ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

function sbFetch(path) {
  return fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    headers: {
      apikey:        process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
    },
  });
}

// Categories we surface in the portal (in display order)
const CATEGORIES = [
  { key: 'totalprice',       label: 'Total Spend',       type: 'money' },
  { key: 'calls',            label: 'Voice Calls',       type: 'count+usage' },
  { key: 'calls-inbound',    label: 'Calls Inbound',     type: 'count+usage' },
  { key: 'calls-outbound',   label: 'Calls Outbound',    type: 'count+usage' },
  { key: 'sms',              label: 'SMS',               type: 'count' },
  { key: 'sms-inbound',      label: 'SMS Inbound',       type: 'count' },
  { key: 'sms-outbound',     label: 'SMS Outbound',      type: 'count' },
  { key: 'mms',              label: 'MMS',               type: 'count' },
  { key: 'phonenumbers',     label: 'Phone Numbers',     type: 'count' },
  { key: 'recordings',       label: 'Recordings',        type: 'count+usage' },
];

// Path suffix for each period
const PERIOD_PATH = {
  this_month: 'ThisMonth',
  yesterday:  'Yesterday',
  today:      'Today',
  monthly:    'Monthly',
  daily:      'Daily',
  all_time:   '',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };
  if (event.httpMethod !== 'GET')     return json(405, { error: 'Method not allowed' });

  if (!authOk(event.headers.authorization || event.headers.Authorization)) {
    return json(401, { error: 'Unauthorized' });
  }

  const qp        = event.queryStringParameters || {};
  const clientId  = (qp.client_id || '').trim();
  const period    = (qp.period || 'this_month').trim();

  if (!clientId) return json(400, { error: 'client_id required' });

  try {
    // 1. Fetch encrypted Twilio credentials from Supabase
    const credsRes = await sbFetch(
      `/client_integrations?client_id=eq.${encodeURIComponent(clientId)}&service=eq.twilio&enabled=eq.true&select=key_name,value_encrypted`
    );
    if (!credsRes.ok) return json(500, { error: 'Failed to fetch integration credentials' });
    const creds = await credsRes.json();

    if (!creds.length) {
      return json(200, { configured: false });
    }

    // 2. Decrypt credentials
    const byKey = {};
    for (const c of creds) {
      byKey[c.key_name] = decrypt(c.value_encrypted);
    }

    const accountSid = byKey['account_sid'];
    const authToken  = byKey['auth_token'];

    if (!accountSid || !authToken) {
      return json(200, { configured: false, missing: true });
    }

    // 3. Call Twilio Usage API
    const pathSuffix = PERIOD_PATH[period] ?? 'ThisMonth';
    const twilioPath = pathSuffix
      ? `/2010-04-01/Accounts/${accountSid}/Usage/Records/${pathSuffix}.json`
      : `/2010-04-01/Accounts/${accountSid}/Usage/Records.json`;

    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const twilioRes = await fetch(`https://api.twilio.com${twilioPath}?PageSize=100`, {
      headers: { Authorization: `Basic ${basicAuth}` },
    });

    if (!twilioRes.ok) {
      const err = await twilioRes.text();
      return json(502, { error: `Twilio API error: ${twilioRes.status}`, detail: err });
    }

    const data = await twilioRes.json();
    const records = data.usage_records || [];

    // 4. Index by category and filter to what we display
    const byCategory = {};
    for (const r of records) {
      byCategory[r.category] = r;
    }

    const usage = CATEGORIES
      .filter(c => byCategory[c.key])
      .map(c => {
        const r = byCategory[c.key];
        return {
          category:    c.key,
          label:       c.label,
          type:        c.type,
          price:       parseFloat(r.price) || 0,
          price_unit:  r.price_unit,
          count:       r.count,
          count_unit:  r.count_unit,
          usage:       r.usage,
          usage_unit:  r.usage_unit,
          start_date:  r.start_date,
          end_date:    r.end_date,
        };
      });

    return json(200, {
      configured: true,
      account_sid: accountSid.replace(/.(?=.{4})/g, '·'), // mask all but last 4
      period,
      usage,
    });

  } catch (e) {
    console.error('twilio-client error:', e);
    return json(500, { error: e.message || 'Unexpected error' });
  }
};
