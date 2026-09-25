'use strict';
const db = require('../db');
const { ValidationError } = require('../lib/errors');
const activity = require('./activity.service');

const DEFAULTS = {
  rotation_interval_days: 3,
  list_size: 50,
  list_max_rotations: 2,
  rotation_enabled: true,
  auto_generate_after_rotation: true,
  generation_batch_size: 5,
  timezone: 'Asia/Karachi',
  target_cities: ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Gujranwala', 'Sialkot', 'Hyderabad', 'Bahawalpur', 'Abbottabad'],
  default_meeting_duration_minutes: 60,
};

const EDITABLE = {
  rotation_interval_days: (v) => { const n = parseInt(v, 10); if (!(n >= 1 && n <= 30)) throw new ValidationError('rotation_interval_days must be 1-30'); return n; },
  list_size: (v) => { const n = parseInt(v, 10); if (!(n >= 1 && n <= 50)) throw new ValidationError('list_size must be 1-50'); return n; },
  list_max_rotations: (v) => { const n = parseInt(v, 10); if (!(n >= 1 && n <= 10)) throw new ValidationError('list_max_rotations must be 1-10'); return n; },
  rotation_enabled: (v) => !!v,
  auto_generate_after_rotation: (v) => !!v,
  generation_batch_size: (v) => { const n = parseInt(v, 10); if (!(n >= 1 && n <= 15)) throw new ValidationError('generation_batch_size must be 1-15'); return n; },
  timezone: (v) => { try { new Intl.DateTimeFormat('en-US', { timeZone: String(v) }); } catch (_) { throw new ValidationError('Unknown timezone'); } return String(v); },
  target_cities: (v) => { if (!Array.isArray(v) || !v.length || v.some((c) => typeof c !== 'string' || !c.trim())) throw new ValidationError('target_cities must be a non-empty list of city names'); return v.map((c) => c.trim()).slice(0, 60); },
  default_meeting_duration_minutes: (v) => { const n = parseInt(v, 10); if (!(n >= 15 && n <= 480)) throw new ValidationError('default_meeting_duration_minutes must be 15-480'); return n; },
};

async function getAll(client) {
  const { rows } = await db.q(client)('SELECT key, value, updated_at FROM system_settings');
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function get(key, client) {
  const all = await getAll(client);
  return all[key];
}

async function update(user, patch) {
  const applied = {};
  await db.withTransaction(async (client) => {
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!EDITABLE[key]) throw new ValidationError(`Unknown setting: ${key}`);
      const value = EDITABLE[key](raw);
      await client.query(
        `INSERT INTO system_settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), user.id],
      );
      applied[key] = value;
    }
    await activity.log('settings_changed', { userId: user.id, details: { scope: 'system', keys: Object.keys(applied) } }, client);
  });
  return getAll();
}

// ---- per-user settings ----------------------------------------------------
async function getUserSettings(userId, client) {
  const run = db.q(client);
  await run('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const { rows } = await run('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
  return rows[0];
}

async function updateUserSettings(user, patch) {
  const allowed = ['selected_strategy_niches', 'selected_service_niches', 'lead_generation_preferences', 'notification_preferences'];
  const sets = [];
  const params = [user.id];
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    const v = patch[key];
    if (key.startsWith('selected_') && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) throw new ValidationError(`${key} must be a list of niche ids`);
    if (!key.startsWith('selected_') && (typeof v !== 'object' || v === null || Array.isArray(v))) throw new ValidationError(`${key} must be an object`);
    params.push(JSON.stringify(v));
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) return getUserSettings(user.id);
  await db.withTransaction(async (client) => {
    await client.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [user.id]);
    await client.query(`UPDATE user_settings SET ${sets.join(', ')} WHERE user_id = $1`, params);
    await activity.log('settings_changed', { userId: user.id, details: { scope: 'user', keys: sets.map((s) => s.split(' ')[0]) } }, client);
  });
  return getUserSettings(user.id);
}

module.exports = { DEFAULTS, getAll, get, update, getUserSettings, updateUserSettings };
