'use strict';
const db = require('../db');
const config = require('../config');
const { verifyPassword, hashPassword } = require('../lib/password');
const { randomToken, sha256 } = require('../lib/crypto');
const { AuthError, RateLimitError, ValidationError } = require('../lib/errors');
const activity = require('./activity.service');
const { PUBLIC_COLS } = require('./users.service');

// Best-effort in-memory login throttle (per username + per IP).
const attempts = new Map();
function throttleKeyCheck(key) {
  const now = Date.now();
  const windowMs = config.security.loginWindowMinutes * 60000;
  const entry = attempts.get(key);
  if (entry && now - entry.first > windowMs) attempts.delete(key);
  const cur = attempts.get(key);
  if (cur && cur.count >= config.security.loginMaxAttempts) throw new RateLimitError();
}
function throttleRecordFailure(key) {
  const cur = attempts.get(key);
  if (cur) cur.count += 1; else attempts.set(key, { first: Date.now(), count: 1 });
}
function throttleClear(key) { attempts.delete(key); }

async function login({ username, password, ip, userAgent }) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    throw new ValidationError('Username and password are required');
  }
  const uname = username.trim().toLowerCase();
  throttleKeyCheck(`u:${uname}`);
  if (ip) throttleKeyCheck(`ip:${ip}`);

  const { rows } = await db.query(`SELECT ${PUBLIC_COLS}, password_hash FROM users WHERE username_normalized = $1`, [uname]);
  const user = rows[0];
  const ok = user && verifyPassword(password, user.password_hash);
  if (!ok || user.account_status !== 'active') {
    throttleRecordFailure(`u:${uname}`);
    if (ip) throttleRecordFailure(`ip:${ip}`);
    await activity.log('login_failed', { details: { username: uname.slice(0, 40), reason: !user ? 'unknown_user' : (!ok ? 'bad_password' : 'disabled') } });
    throw new AuthError('Invalid username or password');
  }
  throttleClear(`u:${uname}`);
  if (ip) throttleClear(`ip:${ip}`);

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.session.ttlHours * 3600000);
  await db.withTransaction(async (client) => {
    await client.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [user.id, sha256(token), expiresAt, ip || null, (userAgent || '').slice(0, 300)],
    );
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await activity.log('login', { userId: user.id, details: { ip: ip || null } }, client);
  });
  delete user.password_hash;
  return { user, token, expiresAt };
}

/** Resolves a session token to a user; slides expiry. Returns null when invalid. */
async function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.expires_at, s.created_at AS session_created_at, ${PUBLIC_COLS.split(', ').map((c) => 'u.' + c).join(', ')}
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row || row.account_status !== 'active') return null;
  const absoluteLimit = new Date(row.session_created_at).getTime() + config.session.absoluteTtlDays * 86400000;
  if (Date.now() > absoluteLimit) return null;
  // slide expiry when less than half of TTL remains
  const remaining = new Date(row.expires_at).getTime() - Date.now();
  if (remaining < (config.session.ttlHours * 3600000) / 2) {
    const newExp = new Date(Math.min(Date.now() + config.session.ttlHours * 3600000, absoluteLimit));
    db.query('UPDATE sessions SET expires_at = $2, last_seen_at = now() WHERE id = $1', [row.session_id, newExp]).catch(() => {});
  }
  const { session_id, expires_at, session_created_at, ...user } = row;
  return { user, sessionId: session_id };
}

async function logout(token, user) {
  if (!token) return;
  await db.withTransaction(async (client) => {
    await client.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
    if (user) await activity.log('logout', { userId: user.id }, client);
  });
}

async function changePassword(user, { current_password, new_password }) {
  if (typeof new_password !== 'string' || new_password.length < 6) throw new ValidationError('New password must be at least 6 characters');
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!rows[0] || !verifyPassword(String(current_password || ''), rows[0].password_hash)) throw new AuthError('Current password is incorrect');
  await db.withTransaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [user.id, hashPassword(new_password)]);
    await activity.log('password_changed', { userId: user.id }, client);
  });
}

async function cleanupExpiredSessions() {
  await db.query("DELETE FROM sessions WHERE expires_at < now() - interval '7 days'");
}

module.exports = { login, resolveSession, logout, changePassword, cleanupExpiredSessions };
