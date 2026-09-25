'use strict';
const db = require('../db');
const { NotFoundError, ForbiddenError, ValidationError } = require('../lib/errors');
const v = require('../lib/validate');
const activity = require('./activity.service');
const cycle = require('./cycle.service');

const TERMINAL_STATUSES = ['not_interested', 'wrong_number', 'business_closed'];
const CALL_STATUSES = ['not_called', 'no_answer', 'call_back_later', 'interested', 'not_interested', 'meeting_booked', 'wrong_number', 'business_closed', 'follow_up_required'];
const INTEREST_LEVELS = ['interested', 'not_interested', 'maybe_follow_up', 'meeting_requested', 'meeting_booked', 'no_clear_interest'];

function assertAccess(user, contact) {
  if (!contact) throw new NotFoundError('Contact not found');
  if (user.role === 'owner') return;
  if (contact.current_owner_id !== user.id) throw new ForbiddenError('This contact is not in your active workspace');
}

const CONTACT_SELECT = `c.*, cu.display_name AS current_owner_name, ou.display_name AS original_owner_name,
  l.list_name, l.list_code, l.list_status, l.cycle_number AS list_cycle_number,
  (SELECT count(*) FROM follow_ups f WHERE f.contact_id = c.id AND f.status = 'pending') AS pending_follow_ups,
  (SELECT count(*) FROM meetings m WHERE m.business_contact_id = c.id AND m.meeting_status IN ('scheduled','rescheduled')) AS upcoming_meetings`;
const CONTACT_FROM = `FROM contacts c
  LEFT JOIN users cu ON cu.id = c.current_owner_id
  LEFT JOIN users ou ON ou.id = c.original_owner_id
  LEFT JOIN contact_lists l ON l.id = c.contact_list_id`;

async function getById(id, client) {
  const { rows } = await db.q(client)(`SELECT ${CONTACT_SELECT} ${CONTACT_FROM} WHERE c.id = $1`, [id]);
  return rows[0] || null;
}

async function getForUser(user, id, client) {
  const contact = await getById(v.uuid(id), client);
  assertAccess(user, contact);
  return contact;
}

async function getDetail(user, id) {
  const contact = await getForUser(user, id);
  const [calls, followUps, meetings, rotations, research, lists, state] = await Promise.all([
    db.query(`SELECT r.*, u.display_name AS employee_name FROM call_records r JOIN users u ON u.id = r.employee_id WHERE r.contact_id = $1 ORDER BY r.call_datetime ASC`, [contact.id]),
    db.query(`SELECT f.*, u.display_name AS owner_name, cb.display_name AS created_by_name FROM follow_ups f JOIN users u ON u.id = f.owner_id JOIN users cb ON cb.id = f.created_by WHERE f.contact_id = $1 ORDER BY f.follow_up_date DESC, f.created_at DESC`, [contact.id]),
    db.query(`SELECT m.*, u.display_name AS owner_name FROM meetings m JOIN users u ON u.id = m.meeting_owner_id WHERE m.business_contact_id = $1 ORDER BY m.starts_at DESC`, [contact.id]),
    db.query(`SELECT h.*, pu.display_name AS previous_owner_name, nu.display_name AS new_owner_name, l.list_name, l.list_code FROM rotation_history h JOIN users pu ON pu.id = h.previous_owner_id LEFT JOIN users nu ON nu.id = h.new_owner_id JOIN contact_lists l ON l.id = h.list_id WHERE h.list_id IN (SELECT list_id FROM list_contacts WHERE contact_id = $1) ORDER BY h.rotation_date ASC`, [contact.id]),
    db.query(`SELECT r.id, r.kind, r.content, r.model, r.source_urls, r.created_at, u.display_name AS created_by_name FROM lead_research r LEFT JOIN users u ON u.id = r.created_by WHERE r.contact_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [contact.id]),
    db.query(`SELECT l.id, l.list_name, l.list_code, l.cycle_number, l.list_status, lc.position FROM list_contacts lc JOIN contact_lists l ON l.id = lc.list_id WHERE lc.contact_id = $1 ORDER BY lc.added_at`, [contact.id]),
    cycle.getState(),
  ]);
  return {
    contact,
    call_history: calls.rows,
    follow_ups: followUps.rows,
    meetings: meetings.rows,
    rotation_history: rotations.rows,
    research: research.rows,
    lists: lists.rows,
    current_cycle: state.current_cycle_number,
    processed_this_cycle: contact.processed_cycle === state.current_cycle_number,
  };
}

function buildFilters(user, f, params) {
  const where = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (user.role !== 'owner') add('c.current_owner_id = ?', user.id);
  else if (f.employee_id) add('c.current_owner_id = ?', v.uuid(f.employee_id, { field: 'employee_id' }));
  if (f.contact_type) add('c.contact_type = ?', v.oneOf(f.contact_type, ['strategy', 'service'], { field: 'contact_type' }));
  if (f.list_id) add('c.id IN (SELECT contact_id FROM list_contacts WHERE list_id = ?)', v.uuid(f.list_id, { field: 'list_id' }));
  if (f.status) add('c.contact_status = ?', v.oneOf(f.status, CALL_STATUSES, { field: 'status' }));
  if (f.interest_level) add('c.interest_level = ?', v.oneOf(f.interest_level, INTEREST_LEVELS, { field: 'interest_level' }));
  if (f.meeting_status) add('c.meeting_status = ?', v.oneOf(f.meeting_status, ['none', 'requested', 'booked', 'completed', 'cancelled'], { field: 'meeting_status' }));
  if (f.data_status) add('c.data_status = ?', v.oneOf(f.data_status, ['verified', 'partially_verified', 'estimated', 'needs_verification'], { field: 'data_status' }));
  if (f.city) add('lower(c.city) = lower(?)', v.str(f.city, { field: 'city', max: 80 }));
  if (f.niche) add('c.niche = ?', v.str(f.niche, { field: 'niche', max: 160 }));
  if (f.company_size) add('c.company_size = ?', v.str(f.company_size, { field: 'company_size', max: 20 }));
  if (f.website_available === 'true') where.push('c.website_available = true');
  if (f.website_available === 'false') where.push('c.website_available = false');
  if (f.website_available === 'unknown') where.push('c.website_available IS NULL');
  if (f.follow_up === 'pending') where.push("EXISTS (SELECT 1 FROM follow_ups f WHERE f.contact_id = c.id AND f.status = 'pending')");
  if (f.follow_up === 'due') where.push("EXISTS (SELECT 1 FROM follow_ups f WHERE f.contact_id = c.id AND f.status = 'pending' AND f.follow_up_date <= CURRENT_DATE)");
  if (f.follow_up === 'none') where.push("NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.contact_id = c.id AND f.status = 'pending')");
  if (f.cycle) add('l.cycle_number = ?', v.int(f.cycle, { field: 'cycle', min: 1 }));
  if (f.generated_from) add('c.created_at >= ?::date', v.dateStr(f.generated_from, { field: 'generated_from' }));
  if (f.generated_to) add("c.created_at < (?::date + interval '1 day')", v.dateStr(f.generated_to, { field: 'generated_to' }));
  if (f.search) {
    const s = v.str(f.search, { field: 'search', max: 120 });
    params.push(`%${s.toLowerCase()}%`);
    where.push(`(lower(c.business_name) LIKE $${params.length} OR c.normalized_business_name LIKE $${params.length} OR lower(COALESCE(c.phone,'')) LIKE $${params.length} OR lower(COALESCE(c.city,'')) LIKE $${params.length} OR lower(COALESCE(c.niche,'')) LIKE $${params.length})`);
  }
  return where;
}

async function list(user, filters = {}) {
  const params = [];
  const where = buildFilters(user, filters, params);
  const limit = v.int(filters.limit, { field: 'limit', min: 1, max: 200, fallback: 50 });
  const offset = v.int(filters.offset, { field: 'offset', min: 0, fallback: 0 });
  const sortMap = { created: 'c.created_at DESC', name: 'c.business_name ASC', status: 'c.contact_status ASC, c.business_name ASC', last_call: 'c.last_call_at DESC NULLS LAST', position: 'lc.position ASC NULLS LAST, c.created_at ASC' };
  const order = sortMap[filters.sort] || (filters.list_id ? sortMap.position : sortMap.created);
  let join = '';
  if (filters.list_id) {
    params.push(v.uuid(filters.list_id, { field: 'list_id' }));
    join = `LEFT JOIN list_contacts lc ON lc.contact_id = c.id AND lc.list_id = $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT ${CONTACT_SELECT}${filters.list_id ? ', lc.position' : ''}, count(*) OVER() AS total ${CONTACT_FROM} ${join}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = rows.length ? Number(rows[0].total) : 0;
  return { items: rows.map(({ total: _t, ...r }) => r), total, limit, offset };
}

/** Next unprocessed, non-terminal contact in a list for the current cycle. */
async function nextInList(user, listId) {
  const lists = require('./lists.service');
  const list_ = await lists.getForUser(user, listId);
  const state = await cycle.getState();
  const { rows } = await db.query(
    `SELECT ${CONTACT_SELECT}, lc.position ${CONTACT_FROM} JOIN list_contacts lc ON lc.contact_id = c.id AND lc.list_id = $1
      WHERE (c.processed_cycle IS NULL OR c.processed_cycle < $2) AND NOT (c.contact_status = ANY($3::text[]))
      ORDER BY lc.position ASC LIMIT 1`,
    [list_.id, state.current_cycle_number, TERMINAL_STATUSES],
  );
  const { rows: counts } = await db.query(
    `SELECT count(*) FILTER (WHERE c.processed_cycle = $2) AS processed,
            count(*) FILTER (WHERE (c.processed_cycle IS NULL OR c.processed_cycle < $2) AND NOT (c.contact_status = ANY($3::text[]))) AS remaining,
            count(*) AS total
       FROM list_contacts lc JOIN contacts c ON c.id = lc.contact_id WHERE lc.list_id = $1`,
    [list_.id, state.current_cycle_number, TERMINAL_STATUSES],
  );
  return { contact: rows[0] || null, progress: { processed: Number(counts[0].processed), remaining: Number(counts[0].remaining), total: Number(counts[0].total) }, list: list_ };
}

async function skip(user, id, reason) {
  const r = v.str(reason, { field: 'reason', required: true, min: 3, max: 500 });
  const contact = await getForUser(user, id);
  const state = await cycle.getState();
  let record;
  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO call_records (contact_id, employee_id, list_id, call_status, skipped, skip_reason, cycle_number, conversation_summary)
       VALUES ($1, $2, $3, 'not_called', true, $4, $5, $6) RETURNING *`,
      [contact.id, user.id, contact.contact_list_id, r, state.current_cycle_number, `Skipped: ${r}`],
    );
    record = rows[0];
    await client.query('UPDATE contacts SET processed_cycle = $2, last_processed_at = now(), skip_reason = $3 WHERE id = $1', [contact.id, state.current_cycle_number, r]);
    await activity.log('contact_skipped', { userId: user.id, contactId: contact.id, listId: contact.contact_list_id, details: { reason: r } }, client);
  });
  return record;
}

async function updateNotes(user, id, notes) {
  const contact = await getForUser(user, id);
  const n = v.str(notes, { field: 'notes', max: 20000 });
  await db.withTransaction(async (client) => {
    await client.query('UPDATE contacts SET notes = $2 WHERE id = $1', [contact.id, n]);
    await activity.log('notes_updated', { userId: user.id, contactId: contact.id }, client);
  });
  return getById(contact.id);
}

async function saveResearch(user, contactId, kind, content, model, sources) {
  const { rows } = await db.query(
    'INSERT INTO lead_research (contact_id, kind, content, model, source_urls, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [contactId, kind, JSON.stringify(content), model, JSON.stringify(sources || []), user.id],
  );
  return rows[0];
}

/** Admin global search by business name: returns complete records. */
async function adminSearch(user, term) {
  if (user.role !== 'owner') throw new ForbiddenError();
  const s = v.str(term, { field: 'q', required: true, min: 2, max: 120 });
  const { rows } = await db.query(
    `SELECT ${CONTACT_SELECT} ${CONTACT_FROM} WHERE lower(c.business_name) LIKE $1 OR c.normalized_business_name LIKE $1 ORDER BY c.business_name LIMIT 25`,
    [`%${s.toLowerCase()}%`],
  );
  return rows;
}

async function filterOptions(user) {
  const owner = user.role === 'owner';
  const params = owner ? [] : [user.id];
  const scope = owner ? '' : 'WHERE current_owner_id = $1';
  const [cities, niches, cycles] = await Promise.all([
    db.query(`SELECT DISTINCT city FROM contacts ${scope} ${scope ? 'AND' : 'WHERE'} city IS NOT NULL ORDER BY city`, params),
    db.query(`SELECT DISTINCT niche FROM contacts ${scope} ${scope ? 'AND' : 'WHERE'} niche IS NOT NULL ORDER BY niche`, params),
    db.query('SELECT DISTINCT cycle_number FROM contact_lists ORDER BY cycle_number DESC'),
  ]);
  return { cities: cities.rows.map((r) => r.city), niches: niches.rows.map((r) => r.niche), cycles: cycles.rows.map((r) => r.cycle_number), statuses: CALL_STATUSES, interest_levels: INTEREST_LEVELS };
}

module.exports = { TERMINAL_STATUSES, CALL_STATUSES, INTEREST_LEVELS, assertAccess, getById, getForUser, getDetail, list, nextInList, skip, updateNotes, saveResearch, adminSearch, filterOptions, CONTACT_SELECT, CONTACT_FROM };
