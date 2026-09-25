'use strict';
/**
 * AES-256-GCM encryption for secrets stored at rest (per-user Claude API keys).
 * APP_ENCRYPTION_KEY must be a 32-byte value (base64 or hex or any string; it is
 * derived with SHA-256 so any sufficiently random string works).
 */
const crypto = require('crypto');
const config = require('../config');

function deriveKey() {
  const raw = config.security.encryptionKey;
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptionAvailable() { return !!config.security.encryptionKey; }

function encrypt(plaintext) {
  const key = deriveKey();
  if (!key) throw new Error('APP_ENCRYPTION_KEY is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(payload) {
  const key = deriveKey();
  if (!key) throw new Error('APP_ENCRYPTION_KEY is not configured');
  const [v, ivB64, tagB64, dataB64] = String(payload).split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

module.exports = { encrypt, decrypt, encryptionAvailable, randomToken, sha256 };
