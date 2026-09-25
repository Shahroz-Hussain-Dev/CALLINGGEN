'use strict';
const db = require('../db');
const { NotFoundError, ForbiddenError, ValidationError } = require('../lib/errors');
const v = require('../lib/validate');
const activity = require('./activity.service');
const settings = require('./settings.service');
const niches = require('./niches.service');
const cycle = require('./cycle.service');
const users = require('./users.service');
const { TERMINAL_STATUSES } = require('./contacts.service');

function assertAccess(user, list) {
  if (!list) throw new NotFoundError('List not found');
  if (user.role === 'owner') return;
  if (list.current_owner_id !== user.id) throw new ForbiddenError('This list is not in your active workspace');
}

const LIST_SELECT = `l.*, cu.display_name AS current_owner_name, cu.username AS current_owner_username, ou.display_name AS original_owner_name,
  (SELECT count(*) FROM list_contacts lc WHERE lc.list_id = l.id) AS contact_count,
  (SELECT row_to_json(j) FROM (SELECT id, status, requested_count, saved_count, duplicate_count, rejected_count, needs_verification_count, verified_count, attempts, last_error, last_batch_at, locked_at FROM generation_jobs g WHERE g.list_id = l.id ORDER BY created_at DESC LIMIT 1) j) AS generation_job`;
const LIST_FROM = 'FROM contact_lists l JOIN users cu ON cu.id = l.current_owner_id JOIN users ou ON ou.id = l.original_owner_id';

async function getById(id, client) {
  const { rows } = await db.q(client)(`SELECT ${LIST_SELECT} ${LIST_FROM} WHERE l.id = $1`, [id]);
  return rows[0] || null;
}

async function getForUser(user, id, client) {
  const list = await getById(v.uuid(id, { field: 'list_id' }), client);
  assertAccess(user, list);
  return list;
}

/** Per-list progress for the current cycle. */
async function statsFor(listIds, cycleNumber, client) {
  if (!listIds.length) return {};
  const { rows } = await db.q(client)(
    `SELECT lc.list_id,
            count(*) AS total,
            count(*) FILTER (WHERE c.processed_cycle = $2) AS processed_this_cycle,
            count(*) FILTER (WHERE (c.processed_cycle IS NULL OR c.processed_cycle < $2) AND NOT (c.contact_status = ANY($3::text[]))) AS remaining,
            count(*) FILTER (WHERE c.contact_status IN ('interested','meeting_booked') OR c.interest_level IN ('interested','meeting_requested','meeting_booked')) AS interested,
            count(*) FILTER (WHERE c.meeting_status = 'booked') AS meetings_booked,
            count(*) FILTER (WHERE c.contact_status = 'no_answer') AS no_answer,
            count(*) FILTER (WHERE c.contact_status = 'not_interested') AS not_interested,
            count(*) FILTER (WHERE c.call_count > 0) AS called,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM follow_ups f WHERE f.contact_id = c.id AND f.status = 'pending')) AS follow_ups_pending
       FROM list_contacts lc JOIN contacts c ON c.id = lc.contact_id
      WHERE lc.list_id = ANY($1::uuid[]) GROUP BY lc.list_id`,
    [listIds, cycleNumber, TERMINAL_STATUSES],
  );
  const out = {};
  for (const r of rows) {
    const total = Number(r.total);
    out[r.list_id] = {
      total, processed_this_cycle: Number(r.processed_this_cycle), remaining: Number(r.remaining), interested: Number(r.interested),
      meetings_booked: Number(r.meetings_booked), no_answer: Number(r.no_answer), not_interested: Number(r.not_interested), called: Number(r.called),
      follow_ups_pending: Number(r.follow_ups_pending), completion_pct: total ? Math.round((Number(r.processed_this_cycle) / total) * 100) : 0,
    };
  }
  return out;
}

/** Lists visible to the user. Employees: lists they currently own. Owner: everything (optionally filtered). */
async function listForUser(user, { contact_type = null, status = null, owner_id = null, include_completed = false } = {}) {
  const params = [];
  const where = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (user.role !== 'owner') add('l.current_owner_id = ?', user.id);
  else if (owner_id) add('l.current_owner_id = ?', v.uuid(owner_id, { field: 'owner_id' }));
  if (contact_type) add('l.contact_type = ?', v.oneOf(contact_type, ['strategy', 'service'], { field: 'contact_type' }));
  if (status) add('l.list_status = ?', v.oneOf(status, ['generating', 'active', 'completed', 'archived'], { field: 'status' }));
  else if (!include_completed) where.push("l.list_status IN ('generating', 'active')");
  const { rows } = await db.query(`SELECT ${LIST_SELECT} ${LIST_FROM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.cycle_number DESC, l.contact_type, l.created_at DESC`, params);
  const state = await cycle.getState();
  const stats = await statsFor(rows.map((r) => r.id), state.current_cycle_number);
  return rows.map((r) => ({ ...r, stats: stats[r.id] || { total: 0, processed_this_cycle: 0, remaining: 0, interested: 0, meetings_booked: 0, no_answer: 0, not_interested: 0, called: 0, follow_ups_pending: 0, completion_pct: 0 }, is_current_cycle: r.cycle_number === state.current_cycle_number }));
}

async function makeListCode(client, contactType, cycleNumber, owner) {
  const prefix = contactType === 'strategy' ? 'S' : 'V';
  const initial = (owner.display_name || owner.username || 'X').trim()[0].toUpperCase();
  const base = `${prefix}-${String(cycleNumber).padStart(3, '0')}-${initial}`;
  const { rows } = await client.query('SELECT count(*) AS n FROM contact_lists WHERE list_code LIKE $1', [base + '%']);
  return Number(rows[0].n) ? `${base}${Number(rows[0].n) + 1}` : base;
}

/**
 * Creates (or returns) the user's list for the current cycle in a panel, and
 * ensures a generation job exists for the requested number of contacts.
 * Idempotent: one list per original owner / panel / cycle.
 */
async function createOrContinue(user, { contact_type, niche_ids, count }, { forUserId = null, client: existing = null, source = 'manual' } = {}) {
  const type = v.oneOf(contact_type, ['strategy', 'service'], { field: 'contact_type', required: true });
  const targetUserId = forUserId || user.id;
  if (targetUserId !== user.id && user.role !== 'owner') throw new ForbiddenError();
  const all = await settings.getAll();
  const maxSize = Number(all.list_size) || 50;
  const requested = v.int(count, { field: 'count', min: 1, max: 50, fallback: maxSize });
  const target = Math.min(requested, 50);
  const ids = v.arrayOf(niche_ids, (x, f) => v.uuid(x, { field: f }), { field: 'niche_ids', max: 100 });
  let nicheRows = ids.length ? await niches.getByIds(ids) : [];
  nicheRows = nicheRows.filter((n) => n.panel === type);
  if (ids.length && !nicheRows.length) throw new ValidationError('Select at least one valid niche for this panel');
  if (!nicheRows.length) {
    const us = await settings.getUserSettings(targetUserId);
    const saved = type === 'strategy' ? us.selected_strategy_niches : us.selected_service_niches;
    nicheRows = (await niches.getByIds(saved || [])).filter((n) => n.panel === type);
  }
  if (!nicheRows.length) nicheRows = await niches.list({ panel: type });

  const run = async (client) => {
    const state = await cycle.ensureCycleStarted(client);
    const owner = await users.getById(targetUserId, client);
    const { rows: existingRows } = await client.query(
      'SELECT id FROM contact_lists WHERE original_owner_id = $1 AND contact_type = $2 AND cycle_number = $3 FOR UPDATE',
      [targetUserId, type, state.current_cycle_number],
    );
    let listId;
    let created = false;
    if (existingRows[0]) {
      listId = existingRows[0].id;
      await client.query(
        `UPDATE contact_lists SET target_size = GREATEST(target_size, $2), selected_niches = $3, list_status = CASE WHEN list_status = 'completed' THEN 'active' ELSE list_status END WHERE id = $1`,
        [listId, target, JSON.stringify(nicheRows.map((n) => ({ id: n.id, name: n.name, category: n.category })))],
      );
    } else {
      const code = await makeListCode(client, type, state.current_cycle_number, owner);
      const name = `${type === 'strategy' ? 'Strategy' : 'Service Sales'} List ${code} · ${owner.display_name} · Cycle ${state.current_cycle_number}`;
      const { rows } = await client.query(
        `INSERT INTO contact_lists (list_name, list_code, contact_type, current_owner_id, original_owner_id, rotation_date, cycle_number, list_status, selected_niches, target_size, generation_progress)
         VALUES ($1, $2, $3, $4, $4, $5, $6, 'generating', $7, $8, $9) RETURNING id`,
        [name, code, type, targetUserId, state.next_rotation_at, state.current_cycle_number, JSON.stringify(nicheRows.map((n) => ({ id: n.id, name: n.name, category: n.category }))), target,
          JSON.stringify({ target, saved: 0, duplicates: 0, rejected: 0, needs_verification: 0, status: 'pending' })],
      );
      listId = rows[0].id;
      created = true;
      await activity.log('list_created', { userId: user.id, listId, details: { contact_type: type, owner_id: targetUserId, cycle: state.current_cycle_number, target, source } }, client);
    }
    // ensure a live generation job
    const { rows: jobs } = await client.query(
      "SELECT id, status, requested_count FROM generation_jobs WHERE list_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [listId],
    );
    const { rows: cnt } = await client.query('SELECT count(*) AS n FROM list_contacts WHERE list_id = $1', [listId]);
    const have = Number(cnt[0].n);
    let jobId = jobs[0] ? jobs[0].id : null;
    if (have >= target) {
      await client.query("UPDATE contact_lists SET list_status = 'active' WHERE id = $1 AND list_status = 'generating'", [listId]);
      if (jobs[0] && ['pending', 'running', 'exhausted', 'failed'].includes(jobs[0].status)) await client.query("UPDATE generation_jobs SET status = 'completed' WHERE id = $1", [jobs[0].id]);
    } else if (!jobs[0] || ['completed', 'cancelled', 'failed', 'exhausted'].includes(jobs[0].status)) {
      const { rows } = await client.query(
        'INSERT INTO generation_jobs (list_id, requested_by, contact_type, requested_count, saved_count) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [listId, user.id, type, target, have],
      );
      jobId = rows[0].id;
      await client.query("UPDATE contact_lists SET list_status = 'generating' WHERE id = $1", [listId]);
    } else {
      await client.query('UPDATE generation_jobs SET requested_count = GREATEST(requested_count, $2) WHERE id = $1', [jobs[0].id, target]);
    }
    return { listId, jobId, created };
  };
  const result = existing ? await run(existing) : await db.withTransaction(run);
  const list = await getById(result.listId, existing);
  return { list, job_id: result.jobId, created: result.created };
}

async function rotationOverview(user) {
  if (user.role !== 'owner') throw new ForbiddenError();
  const lists = await listForUser(user, { include_completed: false });
  const state = await cycle.getState();
  const all = await settings.getAll();
  const chain = await users.rotationChain();
  const { rows: history } = await db.query(
    `SELECT h.*, l.list_name, l.list_code, l.contact_type, pu.display_name AS previous_owner_name, nu.display_name AS new_owner_name
       FROM rotation_history h JOIN contact_lists l ON l.id = h.list_id JOIN users pu ON pu.id = h.previous_owner_id LEFT JOIN users nu ON nu.id = h.new_owner_id
      ORDER BY h.rotation_date DESC LIMIT 100`,
  );
  const { rows: runs } = await db.query('SELECT r.*, u.display_name AS triggered_by_name FROM rotation_runs r LEFT JOIN users u ON u.id = r.triggered_by ORDER BY r.started_at DESC LIMIT 20');
  const { rows: completed } = await db.query(`SELECT ${LIST_SELECT} ${LIST_FROM} WHERE l.list_status IN ('completed','archived') ORDER BY l.updated_at DESC LIMIT 30`);
  return {
    cycle: cycle.describe(state, all),
    settings: { rotation_interval_days: all.rotation_interval_days, list_max_rotations: all.list_max_rotations, list_size: all.list_size, rotation_enabled: all.rotation_enabled, auto_generate_after_rotation: all.auto_generate_after_rotation },
    chain: chain.map((u, i) => ({ id: u.id, display_name: u.display_name, role: u.role, passes_to: chain[(i + 1) % chain.length].display_name })),
    active_lists: lists,
    completed_lists: completed,
    history,
    runs,
  };
}

module.exports = { assertAccess, getById, getForUser, listForUser, statsFor, createOrContinue, rotationOverview, LIST_SELECT, LIST_FROM };
