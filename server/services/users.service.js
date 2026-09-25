'use strict';
const db = require('../db');
const { NotFoundError, ValidationError } = require('../lib/errors');
const { hashPassword } = require('../lib/password');
const activity = require('./activity.service');

const PUBLIC_COLS = 'id, username, display_name, role, account_status, rotation_order, participates_in_rotation, must_change_password, last_login_at, created_at, updated_at';

async function listUsers(client) {
  const { rows } = await db.q(client)(`SELECT ${PUBLIC_COLS} FROM users ORDER BY rotation_order`);
  return rows;
}

async function getById(id, client) {
  const { rows } = await db.q(client)(`SELECT ${PUBLIC_COLS} FROM users WHERE id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('User not found');
  return rows[0];
}

/** Ordered rotation chain of active participating users (Amman -> Fizza -> Shahroz -> Amman). */
async function rotationChain(client) {
  const { rows } = await db.q(client)(
    `SELECT ${PUBLIC_COLS} FROM users WHERE account_status = 'active' AND participates_in_rotation = true ORDER BY rotation_order`,
  );
  return rows;
}

function nextInChain(chain, userId) {
  const idx = chain.findIndex((u) => u.id === userId);
  if (idx < 0) return chain[0] || null;
  return chain[(idx + 1) % chain.length];
}

async function adminUpdateUser(admin, id, patch) {
  const target = await getById(id);
  const sets = [];
  const params = [id];
  if (patch.display_name !== undefined) { params.push(String(patch.display_name).trim().slice(0, 80)); sets.push(`display_name = $${params.length}`); }
  if (patch.account_status !== undefined) {
    if (!['active', 'disabled'].includes(patch.account_status)) throw new ValidationError('Invalid account_status');
    if (target.id === admin.id && patch.account_status === 'disabled') throw new ValidationError('You cannot disable your own account');
    params.push(patch.account_status); sets.push(`account_status = $${params.length}`);
  }
  if (patch.participates_in_rotation !== undefined) { params.push(!!patch.participates_in_rotation); sets.push(`participates_in_rotation = $${params.length}`); }
  if (patch.new_password !== undefined && patch.new_password !== '') {
    if (String(patch.new_password).length < 6) throw new ValidationError('Password must be at least 6 characters');
    params.push(hashPassword(String(patch.new_password))); sets.push(`password_hash = $${params.length}`);
    params.push(true); sets.push(`must_change_password = $${params.length}`);
  }
  if (!sets.length) return target;
  await db.withTransaction(async (client) => {
    await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
    if (patch.new_password) await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await activity.log('user_updated', { userId: admin.id, details: { target_user: id, fields: sets.map((s) => s.split(' ')[0]).filter((f) => f !== 'password_hash') , password_reset: !!patch.new_password } }, client);
  });
  return getById(id);
}

module.exports = { listUsers, getById, rotationChain, nextInChain, adminUpdateUser, PUBLIC_COLS };
