'use strict';
/** scrypt password hashing (Node built-in). Format: scrypt$N$r$p$salt$hash (base64). */
const crypto = require('crypto');

const N = 16384, r = 8, p = 1, KEYLEN = 64;

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 4) throw new Error('Password too short');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, rr, pp, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: +n, r: +rr, p: +pp });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
