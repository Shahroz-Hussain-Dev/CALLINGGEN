'use strict';
/**
 * Owner-only reset of all business data (contacts, lists, generation jobs, calls, follow-ups, meetings,
 * research, rotation history and the activity log). Users, niches, system settings, user settings and
 * API keys are kept. The reset itself is the first entry of the fresh activity log.
 */
const db = require('../db');
const { ForbiddenError, ValidationError } = require('../lib/errors');
const activity = require('./activity.service');

const CONFIRMATION = 'DELETE ALL DATA';
const TABLES = ['activity_logs', 'rotation_history', 'rotation_runs', 'generation_rejections', 'list_contacts', 'lead_research', 'meetings', 'follow_ups', 'call_records', 'contacts', 'generation_jobs', 'contact_lists'];

async function resetAllData(user, { confirm } = {}) {
  if (!user || user.role !== 'owner') throw new ForbiddenError('Only the owner can reset the data');
  if (String(confirm || '').trim() !== CONFIRMATION) throw new ValidationError(`Type ${CONFIRMATION} to confirm`);
  const counts = {};
  await db.withTransaction(async (client) => {
    for (const t of ['contacts', 'contact_lists', 'call_records', 'meetings', 'follow_ups', 'activity_logs']) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts[t] = rows[0].n;
    }
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
    await client.query('UPDATE rotation_state SET current_cycle_number = 1, cycle_started_at = NULL, next_rotation_at = NULL, last_rotation_at = NULL, last_rotation_run_id = NULL, updated_at = now() WHERE id = 1');
    await activity.log('data_reset', { userId: user.id, details: { deleted: counts, kept: ['users', 'niches', 'system_settings', 'user_settings', 'user_api_keys'] } }, client);
  });
  return { ok: true, deleted: counts, cycle: 1 };
}

module.exports = { resetAllData, CONFIRMATION };
