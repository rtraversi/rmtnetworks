// /lib/secrets.js
//
// AES-256-GCM encrypt/decrypt for secrets at rest (login passwords, intake
// submissions, etc). Key comes from SECRETS_KEY (64 hex chars = 32 bytes),
// never leaves the server. Ciphertext format: "iv_hex:ciphertext_hex:authtag_hex".

const crypto = require('crypto');

function getKey() {
  const hex = process.env.SECRETS_KEY || '';
  if (hex.length !== 64) throw new Error('SECRETS_KEY missing or not 64 hex chars');
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`;
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

module.exports = { encrypt, decrypt };
