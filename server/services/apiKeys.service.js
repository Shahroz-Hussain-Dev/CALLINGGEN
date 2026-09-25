'use strict';
/**
 * Per-user AI API keys (Gemini or Anthropic). Stored encrypted (AES-256-GCM).
 * The browser only ever receives the last four characters and the test status.
 */
const db = require('../db');
const config = require('../config');
const { encrypt, decrypt, encryptionAvailable } = require('../lib/crypto');
const { ValidationError, AppError } = require('../lib/errors');
const activity = require('./activity.service');

const PROVIDERS = {
  gemini: { label: 'Google Gemini', pattern: /^(AIza[0-9A-Za-z_\-]{30,}|AQ\.[A-Za-z0-9_\-]{20,})$/, hint: 'Gemini keys start with AIza… (Google AI Studio) or AQ.…', serverKey: () => config.ai.gemini.apiKey },
  anthropic: { label: 'Anthropic Claude', pattern: /^sk-ant-[A-Za-z0-9_\-]{20,}$/, hint: 'Anthropic keys start with sk-ant-', serverKey: () => config.claude.apiKey },
};
function activeProvider() { return PROVIDERS[config.ai.provider] ? config.ai.provider : 'anthropic'; }
function normalizeProvider(p) { const n = String(p || activeProvider()).toLowerCase(); if (!PROVIDERS[n]) throw new ValidationError('Unknown AI provider'); return n; }

async function getStatus(userId, provider) {
  const p = normalizeProvider(provider);
  const { rows } = await db.query('SELECT id, key_last4, status, last_tested_at, last_test_result, updated_at FROM user_api_keys WHERE user_id = $1 AND provider = $2', [userId, p]);
  const row = rows[0];
  const serverConfigured = !!PROVIDERS[p].serverKey();
  return {
    provider: p,
    provider_label: PROVIDERS[p].label,
    key_hint: PROVIDERS[p].hint,
    has_user_key: !!row,
    user_key_last4: row ? row.key_last4 : null,
    user_key_status: row ? row.status : null,
    last_tested_at: row ? row.last_tested_at : null,
    last_test_result: row ? row.last_test_result : null,
    server_key_configured: serverConfigured,
    encryption_configured: encryptionAvailable(),
    active_source: row ? 'user' : (serverConfigured ? 'server' : 'none'),
    model: p === 'gemini' ? config.ai.gemini.model : config.claude.model,
  };
}

async function saveKey(user, apiKey, provider) {
  const p = normalizeProvider(provider);
  const key = String(apiKey || '').trim();
  if (!PROVIDERS[p].pattern.test(key)) throw new ValidationError(`That does not look like a valid ${PROVIDERS[p].label} API key. ${PROVIDERS[p].hint}.`);
  if (!encryptionAvailable()) throw new AppError('APP_ENCRYPTION_KEY is not configured on the server, so personal API keys cannot be stored securely. Ask the administrator to set it.', 503, 'encryption_unavailable');
  const encrypted = encrypt(key);
  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO user_api_keys (user_id, provider, encrypted_key, key_last4, status)
       VALUES ($1, $2, $3, $4, 'untested')
       ON CONFLICT (user_id, provider) DO UPDATE SET encrypted_key = EXCLUDED.encrypted_key, key_last4 = EXCLUDED.key_last4, status = 'untested', last_tested_at = NULL, last_test_result = NULL
       RETURNING id`,
      [user.id, p, encrypted, key.slice(-4)],
    );
    await client.query('UPDATE users SET api_key_reference = $2 WHERE id = $1', [user.id, rows[0].id]);
    await client.query('INSERT INTO user_settings (user_id, api_key_reference) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET api_key_reference = EXCLUDED.api_key_reference', [user.id, rows[0].id]);
    await activity.log('api_key_updated', { userId: user.id, details: { provider: p, last4: key.slice(-4) } }, client);
  });
  return getStatus(user.id, p);
}

async function removeKey(user, provider) {
  const p = normalizeProvider(provider);
  await db.withTransaction(async (client) => {
    await client.query('UPDATE users SET api_key_reference = NULL WHERE id = $1 AND api_key_reference IN (SELECT id FROM user_api_keys WHERE user_id = $1 AND provider = $2)', [user.id, p]);
    await client.query('UPDATE user_settings SET api_key_reference = NULL WHERE user_id = $1 AND api_key_reference IN (SELECT id FROM user_api_keys WHERE user_id = $1 AND provider = $2)', [user.id, p]);
    await client.query('DELETE FROM user_api_keys WHERE user_id = $1 AND provider = $2', [user.id, p]);
    await activity.log('api_key_removed', { userId: user.id, details: { provider: p } }, client);
  });
  return getStatus(user.id, p);
}

/** Resolves the key to use for a user and provider: their own key, else the server key. */
async function resolveKeyForUser(userId, provider) {
  const p = normalizeProvider(provider);
  if (userId) {
    const { rows } = await db.query('SELECT encrypted_key FROM user_api_keys WHERE user_id = $1 AND provider = $2', [userId, p]);
    if (rows[0] && encryptionAvailable()) {
      try { return { apiKey: decrypt(rows[0].encrypted_key), source: 'user' }; } catch (_) { /* fall through to server key */ }
    }
  }
  const serverKey = PROVIDERS[p].serverKey();
  if (serverKey) return { apiKey: serverKey, source: 'server' };
  return { apiKey: null, source: 'none' };
}

async function recordTestResult(userId, provider, ok, result) {
  const p = normalizeProvider(provider);
  await db.query('UPDATE user_api_keys SET status = $3, last_tested_at = now(), last_test_result = $4 WHERE user_id = $1 AND provider = $2', [userId, p, ok ? 'valid' : 'invalid', JSON.stringify(result || {})]);
}

module.exports = { getStatus, saveKey, removeKey, resolveKeyForUser, recordTestResult, PROVIDERS, activeProvider };
