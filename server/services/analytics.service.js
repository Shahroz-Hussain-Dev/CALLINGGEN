'use strict';
const db = require('../db');
const settings = require('./settings.service');
const cycle = require('./cycle.service');
const users = require('./users.service');
const listsService = require('./lists.service');
const followups = require('./followups.service');
const { TERMINAL_STATUSES } = require('./contacts.service');

async function employeeStats(userId, cycleNumber) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM contacts c JOIN contact_lists l ON l.id = c.contact_list_id WHERE c.current_owner_id = $1 AND l.list_status IN ('generating','active')) AS assigned,
       (SELECT count(*) FROM contacts c JOIN contact_lists l ON l.id = c.contact_list_id WHERE c.current_owner_id = $1 AND l.list_status IN ('generating','active') AND (c.processed_cycle IS NULL OR c.processed_cycle < $2) AND NOT (c.contact_status = ANY($3::text[]))) AS remaining,
       (SELECT count(*) FROM contacts c JOIN contact_lists l ON l.id = c.contact_list_id WHERE c.current_owner_id = $1 AND l.list_status IN ('generating','active') AND c.processed_cycle = $2) AS processed_this_cycle,
       (SELECT count(DISTINCT contact_id) FROM call_records WHERE employee_id = $1 AND skipped = false) AS called,
       (SELECT count(*) FROM call_records WHERE employee_id = $1 AND skipped = false) AS total_calls,
       (SELECT count(*) FROM call_records WHERE employee_id = $1 AND skipped = false AND call_datetime >= CURRENT_DATE) AS calls_today,
       (SELECT count(DISTINCT contact_id) FROM call_records WHERE employee_id = $1 AND (call_status = 'interested' OR interest_level IN ('interested','meeting_requested','meeting_booked'))) AS interested,
       (SELECT count(*) FROM meetings WHERE meeting_owner_id = $1 AND meeting_status <> 'cancelled') AS meetings_booked,
       (SELECT count(*) FROM meetings WHERE meeting_owner_id = $1 AND meeting_status IN ('scheduled','rescheduled') AND starts_at >= now()) AS meetings_upcoming,
       (SELECT count(*) FROM follow_ups WHERE owner_id = $1 AND status = 'pending') AS follow_ups_pending,
       (SELECT count(*) FROM follow_ups WHERE owner_id = $1 AND status = 'pending' AND follow_up_date <= CURRENT_DATE) AS follow_ups_due,
       (SELECT count(*) FROM call_records WHERE employee_id = $1 AND call_status = 'no_answer') AS no_answer,
       (SELECT count(DISTINCT contact_id) FROM call_records WHERE employee_id = $1 AND call_status = 'not_interested') AS not_interested,
       (SELECT count(*) FROM call_records WHERE employee_id = $1 AND skipped = true) AS skipped,
       (SELECT max(call_datetime) FROM call_records WHERE employee_id = $1) AS last_call_at`,
    [userId, cycleNumber, TERMINAL_STATUSES],
  );
  const r = rows[0];
  const out = {};
  for (const [k, val] of Object.entries(r)) out[k] = k === 'last_call_at' ? val : Number(val);
  return out;
}

async function overview(user) {
  const state = await cycle.getState();
  const all = await settings.getAll();
  const cyc = cycle.describe(state, all);
  const me = await employeeStats(user.id, state.current_cycle_number);
  const lists = await listsService.listForUser(user, { include_completed: false });
  const myLists = lists.filter((l) => l.current_owner_id === user.id);
  const fu = await followups.summary(user);
  const { rows: upcoming } = await db.query(
    `SELECT m.id, m.business_name, m.meeting_date, m.start_time, m.end_time, m.meeting_type, m.meeting_status, u.display_name AS owner_name
       FROM meetings m JOIN users u ON u.id = m.meeting_owner_id WHERE m.meeting_status IN ('scheduled','rescheduled') AND m.ends_at >= now() ORDER BY m.starts_at ASC LIMIT 8`,
  );
  const { rows: dueFollowUps } = await db.query(
    `SELECT f.id, f.follow_up_date, f.follow_up_time, f.reason, c.business_name, c.id AS contact_id, c.phone, c.contact_type
       FROM follow_ups f JOIN contacts c ON c.id = f.contact_id WHERE f.status = 'pending' AND f.follow_up_date <= CURRENT_DATE ${user.role === 'owner' ? '' : 'AND (f.owner_id = $1 OR c.current_owner_id = $1)'}
      ORDER BY f.follow_up_date ASC, f.follow_up_time ASC NULLS LAST LIMIT 10`,
    user.role === 'owner' ? [] : [user.id],
  );
  const result = {
    user: { id: user.id, display_name: user.display_name, role: user.role },
    cycle: cyc,
    me: { ...me, follow_ups: fu },
    my_lists: myLists.map(summarizeList),
    upcoming_meetings: upcoming,
    due_follow_ups: dueFollowUps,
  };
  if (user.role === 'owner') {
    const team = await teamAnalytics(user);
    result.team = team;
    result.all_lists = lists.map(summarizeList);
  }
  return result;
}

function summarizeList(l) {
  return { id: l.id, list_code: l.list_code, list_name: l.list_name, contact_type: l.contact_type, list_status: l.list_status, cycle_number: l.cycle_number, is_current_cycle: l.is_current_cycle, current_owner_id: l.current_owner_id, current_owner_name: l.current_owner_name, original_owner_name: l.original_owner_name, rotation_count: l.rotation_count, rotation_date: l.rotation_date, target_size: l.target_size, contact_count: Number(l.contact_count), generation_progress: l.generation_progress, generation_job: l.generation_job, stats: l.stats };
}

async function teamAnalytics() {
  const state = await cycle.getState();
  const all = await settings.getAll();
  const allUsers = await users.listUsers();
  const perEmployee = [];
  for (const u of allUsers) perEmployee.push({ user: { id: u.id, display_name: u.display_name, role: u.role, account_status: u.account_status }, stats: await employeeStats(u.id, state.current_cycle_number) });
  const { rows: totals } = await db.query(
    `SELECT
       (SELECT count(*) FROM contacts) AS contacts_generated,
       (SELECT count(*) FROM contacts WHERE contact_type = 'strategy') AS strategy_generated,
       (SELECT count(*) FROM contacts WHERE contact_type = 'service') AS service_generated,
       (SELECT count(*) FROM contacts WHERE call_count > 0) AS contacts_called,
       (SELECT count(*) FROM contacts WHERE contact_type = 'strategy' AND call_count > 0) AS strategy_called,
       (SELECT count(*) FROM contacts WHERE contact_type = 'service' AND call_count > 0) AS service_called,
       (SELECT count(*) FROM contacts WHERE contact_status = 'interested' OR interest_level IN ('interested','meeting_requested','meeting_booked')) AS interested,
       (SELECT count(*) FROM contacts WHERE contact_type = 'strategy' AND (contact_status = 'interested' OR interest_level IN ('interested','meeting_requested','meeting_booked'))) AS strategy_interested,
       (SELECT count(*) FROM contacts WHERE contact_type = 'service' AND (contact_status = 'interested' OR interest_level IN ('interested','meeting_requested','meeting_booked'))) AS service_interested,
       (SELECT count(*) FROM meetings WHERE meeting_status <> 'cancelled') AS meetings_booked,
       (SELECT count(*) FROM meetings m JOIN contacts c ON c.id = m.business_contact_id WHERE m.meeting_status <> 'cancelled' AND c.contact_type = 'strategy') AS strategy_meetings,
       (SELECT count(*) FROM meetings m JOIN contacts c ON c.id = m.business_contact_id WHERE m.meeting_status <> 'cancelled' AND c.contact_type = 'service') AS service_meetings,
       (SELECT count(*) FROM follow_ups WHERE status = 'pending') AS follow_ups_pending,
       (SELECT count(*) FROM contacts c JOIN contact_lists l ON l.id = c.contact_list_id WHERE l.list_status IN ('generating','active') AND (c.processed_cycle IS NULL OR c.processed_cycle < $1) AND NOT (c.contact_status = ANY($2::text[]))) AS contacts_remaining,
       (SELECT count(*) FROM call_records WHERE skipped = false) AS total_calls,
       (SELECT count(*) FROM call_records WHERE skipped = false AND call_datetime >= CURRENT_DATE) AS calls_today,
       (SELECT count(*) FROM generation_rejections WHERE reason = 'duplicate') AS duplicates_rejected,
       (SELECT count(*) FROM contacts WHERE data_status = 'verified') AS verified_contacts,
       (SELECT count(*) FROM contacts WHERE data_status = 'needs_verification') AS needs_verification_contacts`,
    [state.current_cycle_number, TERMINAL_STATUSES],
  );
  const t = {};
  for (const [k, val] of Object.entries(totals[0])) t[k] = Number(val);
  const { rows: statusRows } = await db.query('SELECT contact_type, contact_status, count(*) AS n FROM contacts GROUP BY contact_type, contact_status');
  const { rows: daily } = await db.query(
    `SELECT d::date AS day, count(r.id) AS calls, count(r.id) FILTER (WHERE r.call_status = 'interested' OR r.interest_level IN ('interested','meeting_requested','meeting_booked')) AS interested
       FROM generate_series(CURRENT_DATE - interval '13 days', CURRENT_DATE, interval '1 day') d
       LEFT JOIN call_records r ON r.call_datetime::date = d::date AND r.skipped = false GROUP BY d ORDER BY d`,
  );
  const { rows: nicheRows } = await db.query(
    `SELECT contact_type, niche, count(*) AS contacts, count(*) FILTER (WHERE call_count > 0) AS called,
            count(*) FILTER (WHERE contact_status = 'interested' OR interest_level IN ('interested','meeting_requested','meeting_booked')) AS interested,
            count(*) FILTER (WHERE meeting_status IN ('booked','completed')) AS meetings
       FROM contacts WHERE niche IS NOT NULL GROUP BY contact_type, niche ORDER BY contacts DESC LIMIT 40`,
  );
  const lists = await listsService.listForUser({ role: 'owner' }, { include_completed: false });
  return {
    cycle: cycle.describe(state, all),
    totals: t,
    by_panel: {
      strategy: { generated: t.strategy_generated, called: t.strategy_called, interested: t.strategy_interested, meetings: t.strategy_meetings },
      service: { generated: t.service_generated, called: t.service_called, interested: t.service_interested, meetings: t.service_meetings },
    },
    employees: perEmployee,
    status_breakdown: statusRows.map((r) => ({ contact_type: r.contact_type, status: r.contact_status, count: Number(r.n) })),
    daily_calls: daily.map((r) => ({ day: r.day, calls: Number(r.calls), interested: Number(r.interested) })),
    niche_performance: nicheRows.map((r) => ({ contact_type: r.contact_type, niche: r.niche, contacts: Number(r.contacts), called: Number(r.called), interested: Number(r.interested), meetings: Number(r.meetings) })),
    active_lists: lists.map(summarizeList),
  };
}

module.exports = { employeeStats, overview, teamAnalytics };
