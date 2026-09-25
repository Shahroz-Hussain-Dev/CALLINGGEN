'use strict';
const db = require('../db');
const { ValidationError, NotFoundError } = require('../lib/errors');
const activity = require('./activity.service');

async function list({ panel = null, includeInactive = false } = {}, client) {
  const params = [];
  const where = [];
  if (panel) { params.push(panel); where.push(`panel = $${params.length}`); }
  if (!includeInactive) where.push('is_active = true');
  const { rows } = await db.q(client)(
    `SELECT id, panel, category, name, sort_order, is_active, created_at FROM niches ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY panel, sort_order, name`,
    params,
  );
  return rows;
}

async function getByIds(ids, client) {
  if (!ids || !ids.length) return [];
  const { rows } = await db.q(client)('SELECT id, panel, category, name FROM niches WHERE id = ANY($1::uuid[]) AND is_active = true', [ids]);
  return rows;
}

async function create(user, { panel, name, category }) {
  if (!['strategy', 'service'].includes(panel)) throw new ValidationError('panel must be strategy or service');
  const n = String(name || '').trim();
  if (n.length < 3 || n.length > 120) throw new ValidationError('Niche name must be 3-120 characters');
  const cat = category ? String(category).trim().slice(0, 120) : null;
  const { rows: existing } = await db.query('SELECT id FROM niches WHERE panel = $1 AND lower(name) = lower($2)', [panel, n]);
  if (existing.length) throw new ValidationError('That niche already exists for this panel');
  const { rows: maxRows } = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM niches WHERE panel = $1', [panel]);
  let row;
  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'INSERT INTO niches (panel, category, name, sort_order, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, panel, category, name, sort_order, is_active, created_at',
      [panel, cat, n, maxRows[0].next, user.id],
    );
    row = rows[0];
    await activity.log('niche_created', { userId: user.id, details: { niche_id: row.id, panel, name: n } }, client);
  });
  return row;
}

async function update(user, id, patch) {
  const sets = [];
  const params = [id];
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (n.length < 3 || n.length > 120) throw new ValidationError('Niche name must be 3-120 characters');
    params.push(n); sets.push(`name = $${params.length}`);
  }
  if (patch.category !== undefined) { params.push(patch.category ? String(patch.category).trim().slice(0, 120) : null); sets.push(`category = $${params.length}`); }
  if (patch.is_active !== undefined) { params.push(!!patch.is_active); sets.push(`is_active = $${params.length}`); }
  if (!sets.length) throw new ValidationError('Nothing to update');
  let row;
  await db.withTransaction(async (client) => {
    const { rows } = await client.query(`UPDATE niches SET ${sets.join(', ')} WHERE id = $1 RETURNING id, panel, category, name, sort_order, is_active, created_at`, params);
    if (!rows[0]) throw new NotFoundError('Niche not found');
    row = rows[0];
    await activity.log('niche_updated', { userId: user.id, details: { niche_id: id, fields: sets.map((s) => s.split(' ')[0]) } }, client);
  });
  return row;
}

module.exports = { list, getByIds, create, update };
