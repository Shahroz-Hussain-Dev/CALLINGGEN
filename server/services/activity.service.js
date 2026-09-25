'use strict';
const db = require('../db');

/**
 * Appends an audit event. Safe to call inside a transaction (pass client).
 * Never include secrets in details.
 */
async function log(action, { userId = null, contactId = null, listId = null, details = {} } = {}, client) {
  const run = db.q(client);
  await run(
    'INSERT INTO activity_logs (user_id, action, contact_id, list_id, details) VALUES ($1, $2, $3, $4, $5)',
    [userId, action, contactId, listId, JSON.stringify(details || {})],
  );
}

async function list({ user, limit = 50, offset = 0, action = null, userId = null, from = null, to = null }) {
  const where = [];
  const params = [];
  if (user.role !== 'owner') { params.push(user.id); where.push(`a.user_id = $${params.length}`); }
  else if (userId) { params.push(userId); where.push(`a.user_id = $${params.length}`); }
  if (action) { params.push(action); where.push(`a.action = $${params.length}`); }
  if (from) { params.push(from); where.push(`a."timestamp" >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`a."timestamp" < ($${params.length}::date + interval '1 day')`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT a.id, a.user_id, u.display_name AS user_name, a.action, a.contact_id, c.business_name, a.list_id, l.list_name,
            a."timestamp", a.details,
            count(*) OVER() AS total
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN contacts c ON c.id = a.contact_id
       LEFT JOIN contact_lists l ON l.id = a.list_id
       ${whereSql}
       ORDER BY a."timestamp" DESC, a.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = rows.length ? Number(rows[0].total) : 0;
  return { items: rows.map(({ total: _t, ...r }) => r), total };
}

module.exports = { log, list };
