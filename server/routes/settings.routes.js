'use strict';
const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const settings = require('../services/settings.service');
const apiKeys = require('../services/apiKeys.service');
const search = require('../services/search');
const ai = require('../services/ai.service');
const db = require('../db');
const config = require('../config');
const cycle = require('../services/cycle.service');

const router = express.Router();
router.use('/settings', requireAuth);

router.get('/settings', async (req, res) => {
  const userSettings = await settings.getUserSettings(req.user.id);
  const aiStatus = await apiKeys.getStatus(req.user.id);
  const out = { user: req.user, user_settings: userSettings, ai: { ...aiStatus, ...ai.describe(), search: search.describe() } };
  out.claude = out.ai; // backward compatibility
  if (req.user.role === 'owner') out.system = await settings.getAll();
  res.json(out);
});
router.patch('/settings/user', async (req, res) => res.json({ user_settings: await settings.updateUserSettings(req.user, req.body || {}) }));
router.patch('/settings/system', requireOwner, async (req, res) => res.json({ system: await settings.update(req.user, req.body || {}) }));

router.get('/settings/system/status', requireOwner, async (req, res) => {
  let database;
  try { database = await db.healthCheck(); } catch (err) { database = { ok: false, error: 'Database unreachable' }; }
  const counts = {};
  if (database.ok) {
    const { rows } = await db.query(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM contacts) AS contacts, (SELECT count(*) FROM contact_lists) AS lists,
      (SELECT count(*) FROM call_records) AS calls, (SELECT count(*) FROM meetings) AS meetings, (SELECT count(*) FROM follow_ups) AS follow_ups, (SELECT count(*) FROM activity_logs) AS activity,
      (SELECT count(*) FROM generation_jobs WHERE status IN ('pending','running')) AS active_generation_jobs, (SELECT max(version) FROM schema_migrations) AS latest_migration`);
    for (const [k, v] of Object.entries(rows[0])) counts[k] = k === 'latest_migration' ? v : Number(v);
  }
  const { rows: jobs } = await db.query(`SELECT g.id, g.list_id, l.list_code, l.contact_type, u.display_name AS owner_name, g.status, g.requested_count, g.saved_count, g.duplicate_count, g.rejected_count, g.needs_verification_count, g.attempts, g.last_error, g.last_batch_at
    FROM generation_jobs g JOIN contact_lists l ON l.id = g.list_id JOIN users u ON u.id = l.current_owner_id ORDER BY g.updated_at DESC LIMIT 20`);
  const state = await cycle.getState();
  const all = await settings.getAll();
  res.json({
    database, counts, generation_jobs: jobs, cycle: cycle.describe(state, all),
    environment: { node: process.version, vercel: !!process.env.VERCEL, region: process.env.VERCEL_REGION || null, ai_provider: ai.activeName(), ai_model: ai.describe().model, ai_fallback_models: ai.describe().fallback_models || [], ai_web_search: ai.describe().web_search, server_key_configured: ai.describe().server_key_configured, encryption_configured: !!config.security.encryptionKey, cron_secret_configured: !!config.security.cronSecret, search_provider: search.describe() },
  });
});

module.exports = router;
