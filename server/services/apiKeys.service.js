'use strict';
/**
 * Per-user Claude API keys. Stored encrypted (AES-256-GCM). The browser only
 * ever receives the last four characters and the test status.
 */
const db = require('../db');
const config = require('../config');
const { encrypt, decrypt, encryptionAvailable } = require('../lib/crypto');
const { ValidationError, AppError } = require('../lib/errors');
const activity = require('./activity.service');

async function getStatus(userId) {
  const { rows } = await db.query(
    'SELECT id, key_last4, status, last_tested_at, last_test_result, updated_at FROM user_api_keys WHERE user_id = $1 AND provider = $2',
    [userId, 'anthropic'],
  );
  const row = rows[0];
  return {
    has_user_key: !!row,
    user_key_last4: row ? row.key_last4 : null,
    user_key_status: row ? row.status : null,
    last_tested_at: row ? row.last_tested_at : null,
    last_test_result: row ? row.last_test_result : null,
    server_key_configured: !!config.claude.apiKey,
    encryption_configured: encryptionAvailable(),
    active_source: row ? 'user' : (config.claude.apiKey ? 'server' : 'none'),
    model: config.claude.model,
  };
}

async function saveKey(user, apiKey) {
  const key = String(apiKey || '').trim();
  if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(key)) throw new ValidationError('That does not look like a valid Anthropic API key (it should start with sk-ant-)');
  if (!encryptionAvailable()) throw new AppError('APP_ENCRYPTION_KEY is not configured on the server, so personal API keys cannot be stored securely. Ask the administrator to set it.', 503, 'encryption_unavailable');
  const encrypted = encrypt(key);
  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO user_api_keys (user_id, provider, encrypted_key, key_last4, status)
       VALUES ($1, 'anthropic', $2, $3, 'untested')
       ON CONFLICT (user_id, provider) DO UPDATE SET encrypted_key = EXCLUDED.encrypted_key, key_last4 = EXCLUDED.key_last4, status = 'untested', last_tested_at = NULL, last_test_result = NULL
       RETURNING id`,
      [user.id, encrypted, key.slice(-4)],
    );
    await client.query('UPDATE users SET api_key_reference = $2 WHERE id = $1', [user.id, rows[0].id]);
    await client.query('INSERT INTO user_settings (user_id, api_key_reference) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET api_key_reference = EXCLUDED.api_key_reference', [user.id, rows[0].id]);
    await activity.log('api_key_updated', { userId: user.id, details: { last4: key.slice(-4) } }, client);
  });
  return getStatus(user.id);
}

async function removeKey(user) {
  await db.withTransaction(async (client) => {
    await client.query('UPDATE users SET api_key_reference = NULL WHERE id = $1', [user.id]);
    await client.query('UPDATE user_settings SET api_key_reference = NULL WHERE user_id = $1', [user.id]);
    await client.query("DELETE FROM user_api_keys WHERE user_id = $1 AND provider = 'anthropic'", [user.id]);
    await activity.log('api_key_removed', { userId: user.id }, client);
  });
  return getStatus(user.id);
}

/** Resolves the key to use for a user: their own key, else the server key. */
async function resolveKeyForUser(userId) {
  if (userId) {
    const { rows } = await db.query("SELECT encrypted_key FROM user_api_keys WHERE user_id = $1 AND provider = 'anthropic'", [userId]);
    if (rows[0] && encryptionAvailable()) {
      try { return { apiKey: decrypt(rows[0].encrypted_key), source: 'user' }; } catch (_) { /* fall through to server key */ }
    }
  }
  if (config.claude.apiKey) return { apiKey: config.claude.apiKey, source: 'server' };
  return { apiKey: null, source: 'none' };
}

async function recordTestResult(userId, ok, result) {
  await db.query(
    "UPDATE user_api_keys SET status = $2, last_tested_at = now(), last_test_result = $3 WHERE user_id = $1 AND provider = 'anthropic'",
    [userId, ok ? 'valid' : 'invalid', JSON.stringify(result || {})],
  );
}

module.exports = { getStatus, saveKey, removeKey, resolveKeyForUser, recordTestResult };
