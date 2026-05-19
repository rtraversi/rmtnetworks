// /lib/email-sender.js
//
// Provider-agnostic email send. Default backend: Zoho SMTP via nodemailer.
//
// Env (Zoho):
//   ZOHO_SMTP_HOST     (default: smtp.zoho.com)
//   ZOHO_SMTP_PORT     (default: 465)
//   ZOHO_SMTP_USER     (the Zoho mailbox address)
//   ZOHO_SMTP_PASSWORD (Zoho application-specific password)
//   ZOHO_FROM_NAME     (display name, optional)
//   ZOHO_FROM_ADDRESS  (defaults to ZOHO_SMTP_USER)
//
// To swap providers later: set EMAIL_PROVIDER=sendgrid|mailgun|smtp and add a
// matching branch below. Public interface is intentionally tiny.

const nodemailer = require('nodemailer');

const PROVIDER = (process.env.EMAIL_PROVIDER || 'zoho').toLowerCase();

function buildZohoTransport() {
  return nodemailer.createTransport({
    host: process.env.ZOHO_SMTP_HOST || 'smtp.zoho.com',
    port: Number(process.env.ZOHO_SMTP_PORT || 465),
    secure: true, // 465 is TLS
    auth: {
      user: process.env.ZOHO_SMTP_USER,
      pass: process.env.ZOHO_SMTP_PASSWORD,
    },
  });
}

function buildTransport() {
  switch (PROVIDER) {
    case 'zoho': return buildZohoTransport();
    // case 'sendgrid': ...
    // case 'mailgun':  ...
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${PROVIDER}`);
  }
}

/**
 * Send an email.
 * @param {object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.text]
 * @param {string} [opts.html]
 * @param {Array<{filename: string, content: Buffer|Uint8Array, contentType?: string}>} [opts.attachments]
 * @returns {Promise<{messageId: string, accepted: string[], rejected: string[]}>}
 */
async function sendEmail({ to, subject, text, html, attachments = [] }) {
  if (!to) throw new Error('sendEmail: "to" is required');
  if (!subject) throw new Error('sendEmail: "subject" is required');
  if (!text && !html) throw new Error('sendEmail: provide "text" or "html"');

  const fromAddress = process.env.ZOHO_FROM_ADDRESS || process.env.ZOHO_SMTP_USER;
  const fromName    = process.env.ZOHO_FROM_NAME    || 'RMT Networks';
  if (!fromAddress) throw new Error('Sender address not configured (set ZOHO_SMTP_USER or ZOHO_FROM_ADDRESS)');

  const transport = buildTransport();
  const info = await transport.sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to,
    subject,
    text,
    html,
    attachments,
  });
  return {
    messageId: info.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
  };
}

module.exports = { sendEmail, currentProvider: () => PROVIDER };
