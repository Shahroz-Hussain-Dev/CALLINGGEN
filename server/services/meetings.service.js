'use strict';
/**
 * Shared meeting scheduler. Overlaps are prevented by the database exclusion
 * constraint (meetings_no_overlap_excl), so two users can never book the same
 * slot even when they submit at the exact same moment.
 */
const db = require('../db');
const { NotFoundError, ForbiddenError, ValidationError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');
const activity = require('./activity.service');
const settings = require('./settings.service');
const contacts = require('./contacts.service');
const { combineDateTime } = require('../lib/dates');

const TYPES = ['website_development', 'automation_sales', 'senior_management', 'follow_up', 'other'];
const STATUSES = ['scheduled', 'completed', 'cancelled', 'rescheduled', 'no_show'];
const SELECT = `m.*, u.display_name AS owner_name, cb.display_name AS created_by_name, c.city AS contact_city, c.niche AS contact_niche, c.contact_type, c.phone AS contact_phone, c.current_owner_id AS contact_owner_id`;
const FROM = 'FROM meetings m JOIN users u ON u.id = m.meeting_owner_id JOIN users cb ON cb.id = m.created_by LEFT JOIN contacts c ON c.id = m.business_contact_id';

async function getById(id, client) {
  const { rows } = await db.q(client)(`SELECT ${SELECT} ${FROM} WHERE m.id = $1`, [id]);
  return rows[0] || null;
}

function canManage(user, meeting) {
  return user.role === 'owner' || meeting.meeting_owner_id === user.id;
}

async function list(user, { from = null, to = null, owner_id = null, status = null, contact_id = null } = {}) {
  const params = [];
  const where = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (from) add('m.meeting_date >= ?::date', v.dateStr(from, { field: 'from' }));
  if (to) add('m.meeting_date <= ?::date', v.dateStr(to, { field: 'to' }));
  if (owner_id) add('m.meeting_owner_id = ?', v.uuid(owner_id, { field: 'owner_id' }));
  if (status) add('m.meeting_status = ?', v.oneOf(status, STATUSES, { field: 'status' }));
  if (contact_id) add('m.business_contact_id = ?', v.uuid(contact_id, { field: 'contact_id' }));
  const { rows } = await db.query(`SELECT ${SELECT} ${FROM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.starts_at ASC LIMIT 1000`, params);
  return rows.map((m) => ({ ...m, can_manage: canManage(user, m) }));
}

async function parseTimes(p, { required = true } = {}) {
  const all = await settings.getAll();
  const tz = all.timezone;
  const date = v.dateStr(p.meeting_date, { field: 'meeting_date', required });
  const start = v.timeStr(p.start_time, { field: 'start_time', required });
  let end = v.timeStr(p.end_time, { field: 'end_time' });
  if (!date || !start) return null;
  const startsAt = combineDateTime(date, start, tz);
  if (!startsAt) throw new ValidationError('Invalid meeting date or time');
  let endsAt;
  if (!end) {
    endsAt = new Date(startsAt.getTime() + (Number(all.default_meeting_duration_minutes) || 60) * 60000);
    end = toLocalTime(endsAt, tz);
  } else {
    endsAt = combineDateTime(date, end, tz);
    if (!endsAt) throw new ValidationError('Invalid meeting end time');
  }
  if (endsAt <= startsAt) throw new ValidationError('End time must be after start time');
  if (endsAt - startsAt > 12 * 3600000) throw new ValidationError('A meeting cannot be longer than 12 hours');
  return { date, start, end, startsAt, endsAt, tz };
}

function toLocalTime(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return fmt.format(date);
}

async function findConflicts(startsAt, endsAt, excludeId, client) {
  const { rows } = await db.q(client)(
    `SELECT m.id, m.business_name, m.meeting_date, m.start_time, m.end_time, u.display_name AS owner_name FROM meetings m JOIN users u ON u.id = m.meeting_owner_id
      WHERE m.meeting_status IN ('scheduled','rescheduled') AND tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange($1, $2, '[)') AND ($3::uuid IS NULL OR m.id <> $3)`,
    [startsAt, endsAt, excludeId || null],
  );
  return rows;
}

async function checkAvailability(user, p) {
  const t = await parseTimes(p);
  const conflicts = await findConflicts(t.startsAt, t.endsAt, p.exclude_id ? v.uuid(p.exclude_id, { field: 'exclude_id' }) : null);
  return { available: conflicts.length === 0, conflicts, end_time: t.end };
}

async function create(user, payload) {
  const p = payload || {};
  const t = await parseTimes(p);
  const type = v.oneOf(p.meeting_type, TYPES, { field: 'meeting_type', required: true });
  const contactId = p.business_contact_id ? v.uuid(p.business_contact_id, { field: 'business_contact_id' }) : null;
  let contact = null;
  if (contactId) contact = await contacts.getForUser(user, contactId);
  const businessName = v.str(p.business_name, { field: 'business_name', max: 200 }) || (contact ? contact.business_name : null);
  if (!businessName) throw new ValidationError('business_name is required');
  const fields = {
    contact_person: v.str(p.contact_person, { field: 'contact_person', max: 200 }),
    phone_number: v.str(p.phone_number, { field: 'phone_number', max: 60 }) || (contact ? contact.phone : null),
    location: v.str(p.location, { field: 'location', max: 300 }),
    online_link: v.str(p.online_link, { field: 'online_link', max: 500 }),
    notes: v.str(p.notes, { field: 'notes', max: 8000 }),
  };
  const idem = v.str(p.idempotency_key, { field: 'idempotency_key', max: 120 });
  const ownerId = user.role === 'owner' && p.meeting_owner_id ? v.uuid(p.meeting_owner_id, { field: 'meeting_owner_id' }) : user.id;

  if (idem) {
    const { rows } = await db.query('SELECT id FROM meetings WHERE idempotency_key = $1', [idem]);
    if (rows[0]) return getById(rows[0].id);
  }
  let id;
  try {
    await db.withTransaction(async (client) => {
      const conflicts = await findConflicts(t.startsAt, t.endsAt, null, client);
      if (conflicts.length) throw new ConflictError('That time slot overlaps with an existing meeting on the shared calendar', { conflicts });
      const { rows } = await client.query(
        `INSERT INTO meetings (business_contact_id, meeting_owner_id, created_by, business_name, meeting_type, meeting_date, start_time, end_time, starts_at, ends_at, contact_person, phone_number, location, online_link, notes, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [contactId, ownerId, user.id, businessName, type, t.date, t.start, t.end, t.startsAt, t.endsAt, fields.contact_person, fields.phone_number, fields.location, fields.online_link, fields.notes, idem],
      );
      id = rows[0].id;
      if (contactId) await client.query("UPDATE contacts SET meeting_status = 'booked' WHERE id = $1", [contactId]);
      await activity.log('meeting_created', { userId: user.id, contactId, details: { meeting_id: id, date: t.date, start_time: t.start, end_time: t.end, type, owner_id: ownerId } }, client);
    });
  } catch (err) {
    if (err && err.code === '23P01') throw new ConflictError('That time slot was just booked by someone else. Pick another time.');
    if (err && err.code === '23505' && /idempotency/.test(err.constraint || '')) {
      const { rows } = await db.query('SELECT id FROM meetings WHERE idempotency_key = $1', [idem]);
      return getById(rows[0].id);
    }
    throw err;
  }
  return getById(id);
}

async function update(user, id, payload) {
  const meeting = await getById(v.uuid(id, { field: 'id' }));
  if (!meeting) throw new NotFoundError('Meeting not found');
  if (!canManage(user, meeting)) throw new ForbiddenError('Only the meeting owner or the administrator can change this meeting');
  const p = payload || {};
  const sets = [];
  const params = [meeting.id];
  const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  let times = null;
  if (p.meeting_date !== undefined || p.start_time !== undefined || p.end_time !== undefined) {
    times = await parseTimes({ meeting_date: p.meeting_date || meeting.meeting_date, start_time: p.start_time || String(meeting.start_time).slice(0, 5), end_time: p.end_time || String(meeting.end_time).slice(0, 5) });
    set('meeting_date', times.date); set('start_time', times.start); set('end_time', times.end); set('starts_at', times.startsAt); set('ends_at', times.endsAt);
  }
  if (p.meeting_type !== undefined) set('meeting_type', v.oneOf(p.meeting_type, TYPES, { field: 'meeting_type', required: true }));
  if (p.meeting_status !== undefined) set('meeting_status', v.oneOf(p.meeting_status, STATUSES, { field: 'meeting_status', required: true }));
  for (const f of ['business_name', 'contact_person', 'phone_number', 'location', 'online_link', 'notes']) {
    if (p[f] !== undefined) set(f, v.str(p[f], { field: f, max: f === 'notes' ? 8000 : 500 }));
  }
  if (user.role === 'owner' && p.meeting_owner_id !== undefined) set('meeting_owner_id', v.uuid(p.meeting_owner_id, { field: 'meeting_owner_id' }));
  let outcome = null;
  if (p.outcome !== undefined) {
    outcome = v.objectOrEmpty(p.outcome, 'outcome');
    const clean = {};
    for (const k of ['interest_level', 'problems_identified', 'requirements', 'objections', 'desired_automation', 'budget_information', 'next_steps', 'follow_up_date', 'meeting_result']) {
      if (outcome[k] !== undefined && outcome[k] !== null) clean[k] = k === 'follow_up_date' ? v.dateStr(outcome[k], { field: 'outcome.follow_up_date' }) : String(outcome[k]).slice(0, 4000);
    }
    outcome = clean;
    set('outcome', JSON.stringify({ ...(meeting.outcome || {}), ...clean, recorded_by: user.display_name, recorded_at: new Date().toISOString() }));
  }
  if (!sets.length) throw new ValidationError('Nothing to update');
  try {
    await db.withTransaction(async (client) => {
      if (times) {
        const conflicts = await findConflicts(times.startsAt, times.endsAt, meeting.id, client);
        if (conflicts.length) throw new ConflictError('That time slot overlaps with an existing meeting on the shared calendar', { conflicts });
      }
      await client.query(`UPDATE meetings SET ${sets.join(', ')} WHERE id = $1`, params);
      const status = p.meeting_status || meeting.meeting_status;
      if (meeting.business_contact_id) {
        const contactStatus = status === 'cancelled' ? 'cancelled' : status === 'completed' ? 'completed' : 'booked';
        await client.query('UPDATE contacts SET meeting_status = $2 WHERE id = $1', [meeting.business_contact_id, contactStatus]);
        if (outcome && outcome.follow_up_date) {
          await client.query('INSERT INTO follow_ups (contact_id, owner_id, created_by, contact_person, follow_up_date, reason, notes) VALUES ($1, $2, $2, $3, $4, $5, $6)',
            [meeting.business_contact_id, meeting.meeting_owner_id, meeting.contact_person, outcome.follow_up_date, 'Follow-up after meeting', outcome.next_steps || null]);
          await client.query('UPDATE contacts SET follow_up_date = $2 WHERE id = $1', [meeting.business_contact_id, outcome.follow_up_date]);
          await activity.log('follow_up_created', { userId: user.id, contactId: meeting.business_contact_id, details: { from_meeting: meeting.id, date: outcome.follow_up_date } }, client);
        }
      }
      await activity.log(status === 'cancelled' ? 'meeting_cancelled' : 'meeting_updated', { userId: user.id, contactId: meeting.business_contact_id, details: { meeting_id: meeting.id, fields: sets.map((s) => s.split(' ')[0]), outcome_recorded: !!outcome } }, client);
    });
  } catch (err) {
    if (err && err.code === '23P01') throw new ConflictError('That time slot was just booked by someone else. Pick another time.');
    throw err;
  }
  return getById(meeting.id);
}

/** DELETE = cancel (history is preserved). */
async function cancel(user, id) {
  const meeting = await getById(v.uuid(id, { field: 'id' }));
  if (!meeting) throw new NotFoundError('Meeting not found');
  if (!canManage(user, meeting)) throw new ForbiddenError('Only the meeting owner or the administrator can cancel this meeting');
  await db.withTransaction(async (client) => {
    await client.query("UPDATE meetings SET meeting_status = 'cancelled' WHERE id = $1", [meeting.id]);
    if (meeting.business_contact_id) await client.query("UPDATE contacts SET meeting_status = 'cancelled' WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM meetings WHERE business_contact_id = $1 AND meeting_status IN ('scheduled','rescheduled'))", [meeting.business_contact_id]);
    await activity.log('meeting_cancelled', { userId: user.id, contactId: meeting.business_contact_id, details: { meeting_id: meeting.id } }, client);
  });
  return getById(meeting.id);
}

module.exports = { TYPES, STATUSES, list, create, update, cancel, getById, checkAvailability };
