'use strict';
/** Rotation cycle state helpers shared by lists, calls, generation and rotation. */
const db = require('../db');
const settings = require('./settings.service');
const { startOfDayInTz, addDays } = require('../lib/dates');

async function getState(client) {
  const { rows } = await db.q(client)('SELECT * FROM rotation_state WHERE id = 1');
  return rows[0];
}

async function getStateForUpdate(client) {
  const { rows } = await client.query('SELECT * FROM rotation_state WHERE id = 1 FOR UPDATE');
  return rows[0];
}

/** Starts cycle 1 at the beginning of today (app timezone) if no cycle is running. Must run inside a transaction. */
async function ensureCycleStarted(client) {
  const state = await getStateForUpdate(client);
  if (state.cycle_started_at) return state;
  const all = await settings.getAll(client);
  const tz = all.timezone;
  const start = startOfDayInTz(new Date(), tz);
  const next = addDays(start, Number(all.rotation_interval_days) || 3);
  const { rows } = await client.query(
    'UPDATE rotation_state SET cycle_started_at = $1, next_rotation_at = $2, updated_at = now() WHERE id = 1 RETURNING *',
    [start, next],
  );
  return rows[0];
}

async function currentCycleNumber(client) {
  const s = await getState(client);
  return s ? s.current_cycle_number : 1;
}

function describe(state, all) {
  const now = new Date();
  const interval = Number(all.rotation_interval_days) || 3;
  const next = state.next_rotation_at ? new Date(state.next_rotation_at) : null;
  const started = state.cycle_started_at ? new Date(state.cycle_started_at) : null;
  const msLeft = next ? next.getTime() - now.getTime() : null;
  const daysRemaining = msLeft === null ? null : Math.max(0, Math.ceil(msLeft / 86400000));
  const dayOfCycle = started ? Math.min(interval, Math.max(1, Math.floor((now.getTime() - started.getTime()) / 86400000) + 1)) : null;
  return {
    current_cycle_number: state.current_cycle_number,
    cycle_started_at: started,
    next_rotation_at: next,
    last_rotation_at: state.last_rotation_at,
    rotation_interval_days: interval,
    rotation_enabled: all.rotation_enabled !== false,
    day_of_cycle: dayOfCycle,
    days_remaining: daysRemaining,
    hours_remaining: msLeft === null ? null : Math.max(0, Math.round(msLeft / 3600000)),
    rotation_due: !!(next && now >= next),
    started: !!started,
    timezone: all.timezone,
  };
}

module.exports = { getState, getStateForUpdate, ensureCycleStarted, currentCycleNumber, describe };
