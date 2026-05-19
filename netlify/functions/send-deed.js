// /netlify/functions/send-deed.js
//
// Renders the deed PDF and emails it via the configured provider (Zoho default).
//
// Request body (JSON):
//   {
//     deed:   { ...DeedRecord... },
//     to:     "recipient@example.com" | ["a@x.com", "b@x.com"],
//     subject?: "Draft Deed — ...",        // optional override
//     message?: "Please review attached." // optional plain-text body override
//   }
//
// Response: { ok: true, messageId: "...", accepted: [...], rejected: [...] }

const { renderDeedPdf } = require('../../lib/deed-renderer');
const { sendEmail }     = require('../../lib/email-sender');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function defaultSubject(deed) {
  const name = (deed.grantee_name || '').split(/[,;\sand]+/i)[0] || 'New Owner';
  return `Draft Deed — ${name} — ${deed.property_address || ''}`.trim().replace(/[\s—]+$/, '');
}

function defaultMessage(deed) {
  return [
    'Attached is the draft deed generated from the uploaded prior conveyance.',
    '',
    `Deed type:   ${deed.deed_type || ''}`,
    `Grantor:     ${deed.grantor_name || ''}`,
    `Grantee:     ${deed.grantee_name || ''}`,
    `Property:    ${deed.property_address || ''}, ${deed.property_city || ''}`,
    `Consideration: ${deed.consideration_words || deed.consideration_amount || ''}`,
    '',
    'This is a demo document and should be reviewed by counsel before signing.',
    '',
    '— RMT Networks',
  ].join('\n');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { deed, to, subject, message } = body;
  if (!deed || !deed.grantor_name || !deed.grantee_name) {
    return json(400, { error: 'deed.grantor_name and deed.grantee_name are required' });
  }
  if (!to) return json(400, { error: '"to" recipient required' });

  try {
    const pdfBytes = await renderDeedPdf(deed);
    const result = await sendEmail({
      to,
      subject: subject || defaultSubject(deed),
      text:    message || defaultMessage(deed),
      attachments: [
        {
          filename: `new-deed-${(deed.grantee_name || 'draft').slice(0, 24).replace(/[^a-z0-9]+/gi, '-')}.pdf`,
          content: Buffer.from(pdfBytes),
          contentType: 'application/pdf',
        },
      ],
    });
    return json(200, { ok: true, ...result });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
