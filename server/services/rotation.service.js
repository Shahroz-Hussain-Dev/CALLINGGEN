'use strict';
/**
 * Automatic three-day rotation engine.
 * - Idempotent: the rotation_state row is locked FOR UPDATE, the due-check is
 *   re-evaluated under the lock, and one completed run per cycle is enforced by
 *   a unique index, so a scheduler firing twice can never rotate twice.
 * - Every list rotates along the chain (Amman -> Fizza -> Shahroz -> Amman),
 *   incomplete or not. Nothing is deleted or reset.
 * - After rotating, fresh lists are created for every participant and panel.
 */
const db = require('../db');
const logger = require('../logger');
const { ValidationError, NotFoundError, AppError } = require('../lib/errors');
const v = require('../lib/validate');
const activity = require('./activity.service');
const settings = require('./settings.service');
const users = require('./users.service');
const cycle = require('./cycle.service');
const listsService = require('./lists.service');
const generation = require('./generation.service');
const auth = require('./auth.service');
const { startOfDayInTz, addDays } = require('../lib/dates');

async function runRotation({ trigger = 'manual', user = null, force = false } = {}) {
  const all = await settings.getAll();
  const actor = user || { id: null, role: 'owner', display_name: 'System' };
  let runId = null;
  try {
    return await db.withTransaction(async (client) => {
      const state = await cycle.getStateForUpdate(client);
      const now = new Date();
      if (!state.cycle_started_at) return { rotated: false, reason: 'no_cycle_started', message: 'No rotation cycle has started yet. It starts automatically when the first list is generated.' };
      if (!force && all.rotation_enabled === false) return { rotated: false, reason: 'rotation_disabled', message: 'Automatic rotation is disabled in system settings.' };
      if (!force && (!state.next_rotation_at || now < new Date(state.next_rotation_at))) {
        return { rotated: false, reason: 'not_due', next_rotation_at: state.next_rotation_at, message: 'Rotation is not due yet.' };
      }
      const cycleNumber = state.current_cycle_number;
      const { rows: done } = await client.query("SELECT id FROM rotation_runs WHERE cycle_number = $1 AND status = 'completed'", [cycleNumber]);
      if (done[0]) return { rotated: false, reason: 'already_rotated', run_id: done[0].id, message: 'This cycle has already been rotated.' };

      const { rows: runRows } = await client.query(
        "INSERT INTO rotation_runs (cycle_number, status, trigger_source, triggered_by) VALUES ($1, 'running', $2, $3) RETURNING id",
        [cycleNumber, trigger === 'cron' ? 'cron' : trigger === 'test' ? 'test' : 'manual', user ? user.id : null],
      );
      runId = runRows[0].id;
      const chain = await users.rotationChain(client);
      if (chain.length < 2) throw new AppError('At least two active participants are required for rotation', 409, 'rotation_chain_too_short');
      const maxRotations = Number(all.list_max_rotations) || 2;
      const interval = Number(all.rotation_interval_days) || 3;
      const tz = all.timezone;

      // New cycle boundaries: keep aligned to the scheduled moment unless it is stale.
      let cycleStart = new Date(state.next_rotation_at);
      if (now < cycleStart || now.getTime() - cycleStart.getTime() > interval * 86400000) cycleStart = startOfDayInTz(now, tz);
      const nextRotation = addDays(cycleStart, interval);
      const newCycle = cycleNumber + 1;

      const { rows: lists } = await client.query(
        "SELECT * FROM contact_lists WHERE list_status IN ('generating', 'active') AND (last_rotated_cycle IS NULL OR last_rotated_cycle < $1) ORDER BY contact_type, created_at FOR UPDATE",
        [cycleNumber],
      );
      const events = [];
      let rotated = 0, completed = 0;
      for (const list of lists) {
        if (list.rotation_count >= maxRotations) {
          await client.query("UPDATE contact_lists SET list_status = 'completed', last_rotated_cycle = $2, rotation_date = NULL WHERE id = $1", [list.id, cycleNumber]);
          await client.query("INSERT INTO rotation_history (list_id, previous_owner_id, new_owner_id, cycle_number, rotation_run_id, event_type) VALUES ($1, $2, NULL, $3, $4, 'completed')", [list.id, list.current_owner_id, cycleNumber, runId]);
          await client.query("UPDATE generation_jobs SET status = 'cancelled', locked_at = NULL WHERE list_id = $1 AND status IN ('pending', 'running', 'failed', 'exhausted')", [list.id]);
          await activity.log('list_completed', { userId: actor.id, listId: list.id, details: { cycle: cycleNumber, rotation_count: list.rotation_count, last_owner_id: list.current_owner_id, run_id: runId } }, client);
          events.push({ list_id: list.id, list_code: list.list_code, event: 'completed', owner_id: list.current_owner_id });
          completed++;
          continue;
        }
        const newOwner = users.nextInChain(chain, list.current_owner_id);
        if (!newOwner || newOwner.id === list.current_owner_id) continue;
        await client.query(
          'UPDATE contact_lists SET current_owner_id = $2, rotation_count = rotation_count + 1, last_rotated_cycle = $3, last_rotated_at = now(), rotation_date = $4 WHERE id = $1',
          [list.id, newOwner.id, cycleNumber, nextRotation],
        );
        await client.query('UPDATE contacts SET current_owner_id = $2 WHERE id IN (SELECT contact_id FROM list_contacts WHERE list_id = $1)', [list.id, newOwner.id]);
        await client.query(
          "UPDATE follow_ups SET previous_owner_id = owner_id, owner_id = $2 WHERE status = 'pending' AND owner_id = $3 AND contact_id IN (SELECT contact_id FROM list_contacts WHERE list_id = $1)",
          [list.id, newOwner.id, list.current_owner_id],
        );
        await client.query(
          "INSERT INTO rotation_history (list_id, previous_owner_id, new_owner_id, cycle_number, rotation_run_id, event_type) VALUES ($1, $2, $3, $4, $5, 'rotated')",
          [list.id, list.current_owner_id, newOwner.id, cycleNumber, runId],
        );
        await activity.log('list_rotated', { userId: actor.id, listId: list.id, details: { cycle: cycleNumber, from_owner_id: list.current_owner_id, to_owner_id: newOwner.id, to_owner: newOwner.display_name, run_id: runId } }, client);
        await activity.log('ownership_transferred', { userId: actor.id, listId: list.id, details: { from_owner_id: list.current_owner_id, to_owner_id: newOwner.id, contacts: 'all', run_id: runId } }, client);
        events.push({ list_id: list.id, list_code: list.list_code, event: 'rotated', from_owner_id: list.current_owner_id, to_owner_id: newOwner.id });
        rotated++;
      }

      await client.query(
        'UPDATE rotation_state SET current_cycle_number = $1, cycle_started_at = $2, next_rotation_at = $3, last_rotation_at = now(), last_rotation_run_id = $4, updated_at = now() WHERE id = 1',
        [newCycle, cycleStart, nextRotation, runId],
      );

      let created = 0;
      const createdListIds = [];
      if (all.auto_generate_after_rotation !== false) {
        for (const u of chain) {
          for (const type of ['strategy', 'service']) {
            const res = await listsService.createOrContinue({ id: actor.id, role: 'owner', display_name: actor.display_name }, { contact_type: type, niche_ids: [], count: all.list_size }, { forUserId: u.id, client, source: trigger === 'cron' ? 'rotation_cron' : 'rotation_manual' });
            if (res.created) { created++; createdListIds.push(res.list.id); }
          }
        }
      }
      await client.query(
        "UPDATE rotation_runs SET status = 'completed', finished_at = now(), lists_rotated = $2, lists_completed = $3, lists_created = $4, details = $5 WHERE id = $1",
        [runId, rotated, completed, created, JSON.stringify({ events, new_cycle: newCycle, cycle_started_at: cycleStart, next_rotation_at: nextRotation, force, trigger })],
      );
      await activity.log('rotation_completed', { userId: actor.id, details: { run_id: runId, cycle_from: cycleNumber, cycle_to: newCycle, lists_rotated: rotated, lists_completed: completed, lists_created: created, trigger, force } }, client);
      return { rotated: true, run_id: runId, cycle_from: cycleNumber, cycle_to: newCycle, lists_rotated: rotated, lists_completed: completed, lists_created: created, created_list_ids: createdListIds, next_rotation_at: nextRotation, events };
    });
  } catch (err) {
    logger.error('Rotation failed', { error: err.message, runId });
    try {
      await db.query("INSERT INTO rotation_runs (cycle_number, status, trigger_source, triggered_by, finished_at, error) VALUES ((SELECT current_cycle_number FROM rotation_state WHERE id = 1), 'failed', $1, $2, now(), $3)", [trigger === 'cron' ? 'cron' : trigger === 'test' ? 'test' : 'manual', user ? user.id : null, String(err.message).slice(0, 1000)]);
      await activity.log('rotation_failed', { userId: actor.id, details: { error: String(err.message).slice(0, 300), trigger } });
    } catch (_) { /* ignore secondary failure */ }
    throw err;
  }
}

/** Scheduled entry point: rotate if due, then continue lead generation within a time budget. */
async function runScheduled({ trigger = 'cron', timeBudgetMs = 45000 } = {}) {
  const started = Date.now();
  const rotation = await runRotation({ trigger });
  let generationResults = [];
  const remaining = timeBudgetMs - (Date.now() - started);
  if (remaining > 8000) generationResults = await generation.continuePending({ timeBudgetMs: remaining - 3000 });
  await auth.cleanupExpiredSessions().catch(() => {});
  return { rotation, generation: generationResults, elapsed_ms: Date.now() - started };
}

async function status(user) {
  const state = await cycle.getState();
  const all = await settings.getAll();
  const lists = await listsService.listForUser(user, { include_completed: false });
  const { rows: runs } = await db.query('SELECT r.*, u.display_name AS triggered_by_name FROM rotation_runs r LEFT JOIN users u ON u.id = r.triggered_by ORDER BY r.started_at DESC LIMIT 5');
  return { cycle: cycle.describe(state, all), lists: lists.map((l) => ({ id: l.id, list_code: l.list_code, list_name: l.list_name, contact_type: l.contact_type, current_owner_name: l.current_owner_name, rotation_count: l.rotation_count, rotation_date: l.rotation_date, stats: l.stats })), recent_runs: runs };
}

/** Admin: transfer a list to a specific user immediately (outside the schedule). */
async function manualTransfer(admin, listId, newOwnerId) {
  const list = await listsService.getById(v.uuid(listId, { field: 'list_id' }));
  if (!list) throw new NotFoundError('List not found');
  const newOwner = await users.getById(v.uuid(newOwnerId, { field: 'new_owner_id' }));
  if (newOwner.id === list.current_owner_id) throw new ValidationError('That user already owns this list');
  const state = await cycle.getState();
  await db.withTransaction(async (client) => {
    await client.query('UPDATE contact_lists SET current_owner_id = $2, last_rotated_at = now() WHERE id = $1', [list.id, newOwner.id]);
    await client.query('UPDATE contacts SET current_owner_id = $2 WHERE id IN (SELECT contact_id FROM list_contacts WHERE list_id = $1)', [list.id, newOwner.id]);
    await client.query("UPDATE follow_ups SET previous_owner_id = owner_id, owner_id = $2 WHERE status = 'pending' AND owner_id = $3 AND contact_id IN (SELECT contact_id FROM list_contacts WHERE list_id = $1)", [list.id, newOwner.id, list.current_owner_id]);
    await client.query("INSERT INTO rotation_history (list_id, previous_owner_id, new_owner_id, cycle_number, event_type) VALUES ($1, $2, $3, $4, 'manual_transfer')", [list.id, list.current_owner_id, newOwner.id, state.current_cycle_number]);
    await activity.log('ownership_transferred', { userId: admin.id, listId: list.id, details: { manual: true, from_owner_id: list.current_owner_id, to_owner_id: newOwner.id } }, client);
  });
  return listsService.getById(list.id);
}

module.exports = { runRotation, runScheduled, status, manualTransfer };
