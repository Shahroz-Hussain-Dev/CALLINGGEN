'use strict';
const db = require('../db');
const { NotFoundError, ForbiddenError, ValidationError } = require('../lib/errors');
const v = require('../lib/validate');
const activity = require('./activity.service');
const contacts = require('./contacts.service');

const SELECT = `f.*, u.display_name AS owner_name, cb.display_name AS created_by_name, c.business_name, c.phone, c.city, c.niche, c.contact_type, c.contact_status, c.current_owner_id`;
const FROM = 'FROM follow_ups f JOIN users u ON u.id = f.owner_id JOIN users cb ON cb.id = f.created_by JOIN contacts c ON c.id = f.contact_id';

async function getById(id, client) {
  const { rows } = await db.q(client)(`SELECT ${SELECT} ${FROM} WHERE f.id = $1`, [id]);
  return rows[0] || null;
}

function assertAccess(user, fu) {
  if (!fu) throw new NotFoundError('Follow-up not found');
  if (user.role === 'owner') return;
  if (fu.owner_id !== user.id && fu.current_owner_id !== user.id) throw new ForbiddenError('This follow-up is not yours');
}

async function list(user, { status = null, due = null, from = null, to = null, contact_id = null, owner_id = null, limit = 100, offset = 0 } = {}) {
  const params = [];
  const where = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (user.role !== 'owner') add('(f.owner_id = ? OR c.current_owner_id = $1)', user.id);
  else if (owner_id) add('f.owner_id = ?', v.uuid(owner_id, { field: 'owner_id' }));
  if (status) add('f.status = ?', v.oneOf(status, ['pending', 'completed', 'rescheduled', 'cancelled'], { field: 'status' }));
  if (due === 'today') where.push("f.status = 'pending' AND f.follow_up_date = CURRENT_DATE");
  if (due === 'overdue') where.push("f.status = 'pending' AND f.follow_up_date < CURRENT_DATE");
  if (due === 'upcoming') where.push("f.status = 'pending' AND f.follow_up_date > CURRENT_DATE");
  if (due === 'due') where.push("f.status = 'pending' AND f.follow_up_date <= CURRENT_DATE");
  if (from) add('f.follow_up_date >= ?::date', v.dateStr(from, { field: 'from' }));
  if (to) add('f.follow_up_date <= ?::date', v.dateStr(to, { field: 'to' }));
  if (contact_id) add('f.contact_id = ?', v.uuid(contact_id, { field: 'contact_id' }));
  params.push(v.int(limit, { field: 'limit', min: 1, max: 500, fallback: 100 }), v.int(offset, { field: 'offset', min: 0, fallback: 0 }));
  const { rows } = await db.query(
    `SELECT ${SELECT}, count(*) OVER() AS total ${FROM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE f.status WHEN 'pending' THEN 0 ELSE 1 END, f.follow_up_date ASC, f.follow_up_time ASC NULLS LAST, f.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows.map(({ total: _t, ...r }) => r), total: rows.length ? Number(rows[0].total) : 0 };
}

async function summary(user) {
  const scope = user.role === 'owner' ? '' : 'AND (f.owner_id = $1 OR c.current_owner_id = $1)';
  const params = user.role === 'owner' ? [] : [user.id];
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE f.status = 'pending' AND f.follow_up_date = CURRENT_DATE) AS today,
            count(*) FILTER (WHERE f.status = 'pending' AND f.follow_up_date < CURRENT_DATE) AS overdue,
            count(*) FILTER (WHERE f.status = 'pending' AND f.follow_up_date > CURRENT_DATE) AS upcoming,
            count(*) FILTER (WHERE f.status = 'pending') AS pending
       FROM follow_ups f JOIN contacts c ON c.id = f.contact_id WHERE true ${scope}`,
    params,
  );
  return { today: Number(rows[0].today), overdue: Number(rows[0].overdue), upcoming: Number(rows[0].upcoming), pending: Number(rows[0].pending) };
}

async function create(user, contactId, payload) {
  const contact = await contacts.getForUser(user, contactId);
  const p = payload || {};
  const date = v.dateStr(p.follow_up_date, { field: 'follow_up_date', required: true });
  const time = v.timeStr(p.follow_up_time, { field: 'follow_up_time' });
  const reason = v.str(p.reason, { field: 'reason', required: true, min: 2, max: 500 });
  const notes = v.str(p.notes, { field: 'notes', max: 4000 });
  const person = v.str(p.contact_person, { field: 'contact_person', max: 200 });
  let row;
  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'INSERT INTO follow_ups (contact_id, owner_id, created_by, contact_person, follow_up_date, follow_up_time, reason, notes) VALUES ($1, $2, $2, $3, $4, $5, $6, $7) RETURNING id',
      [contact.id, user.id, person, date, time, reason, notes],
    );
    row = rows[0];
    await client.query("UPDATE contacts SET follow_up_date = $2, contact_status = CASE WHEN contact_status = 'not_called' THEN 'follow_up_required' ELSE contact_status END WHERE id = $1", [contact.id, date]);
    await activity.log('follow_up_created', { userId: user.id, contactId: contact.id, listId: contact.contact_list_id, details: { follow_up_id: row.id, date } }, client);
  });
  return getById(row.id);
}

async function update(user, id, payload) {
  const fu = await getById(v.uuid(id, { field: 'id' }));
  assertAccess(user, fu);
  const p = payload || {};
  const status = v.oneOf(p.status, ['pending', 'completed', 'rescheduled', 'cancelled'], { field: 'status' });
  const notes = p.notes !== undefined ? v.str(p.notes, { field: 'notes', max: 4000 }) : undefined;
  const newDate = v.dateStr(p.follow_up_date, { field: 'follow_up_date' });
  const newTime = v.timeStr(p.follow_up_time, { field: 'follow_up_time' });
  let resultId = fu.id;
  await db.withTransaction(async (client) => {
    if (status === 'rescheduled' || (newDate && newDate !== fu.follow_up_date && fu.status === 'pending' && status !== 'cancelled' && status !== 'completed')) {
      if (!newDate) throw new ValidationError('A new follow_up_date is required to reschedule');
      const { rows } = await client.query(
        'INSERT INTO follow_ups (contact_id, call_record_id, owner_id, created_by, contact_person, follow_up_date, follow_up_time, reason, notes, previous_owner_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
        [fu.contact_id, fu.call_record_id, fu.owner_id, user.id, fu.contact_person, newDate, newTime || fu.follow_up_time, fu.reason, notes !== undefined ? notes : fu.notes, fu.previous_owner_id],
      );
      resultId = rows[0].id;
      await client.query("UPDATE follow_ups SET status = 'rescheduled', rescheduled_to_id = $2, notes = COALESCE($3, notes) WHERE id = $1", [fu.id, resultId, notes !== undefined ? notes : null]);
      await client.query('UPDATE contacts SET follow_up_date = $2 WHERE id = $1', [fu.contact_id, newDate]);
      await activity.log('follow_up_rescheduled', { userId: user.id, contactId: fu.contact_id, details: { from: fu.id, to: resultId, date: newDate } }, client);
    } else {
      const sets = [];
      const params = [fu.id];
      if (status) { params.push(status); sets.push(`status = $${params.length}`); if (status === 'completed') sets.push('completed_at = now()'); }
      if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`); }
      if (newTime) { params.push(newTime); sets.push(`follow_up_time = $${params.length}`); }
      if (!sets.length) throw new ValidationError('Nothing to update');
      await client.query(`UPDATE follow_ups SET ${sets.join(', ')} WHERE id = $1`, params);
      if (status === 'completed' || status === 'cancelled') {
        await client.query(`UPDATE contacts SET follow_up_date = (SELECT MIN(follow_up_date) FROM follow_ups WHERE contact_id = $1 AND status = 'pending') WHERE id = $1`, [fu.contact_id]);
      }
      await activity.log('follow_up_updated', { userId: user.id, contactId: fu.contact_id, details: { follow_up_id: fu.id, status, notes_changed: notes !== undefined } }, client);
    }
  });
  return getById(resultId);
}

module.exports = { list, summary, create, update, getById };
