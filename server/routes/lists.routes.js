'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ConflictError } = require('../lib/errors');
const lists = require('../services/lists.service');
const contacts = require('../services/contacts.service');
const generation = require('../services/generation.service');
const db = require('../db');

const router = express.Router();
router.use(['/lists', '/generation'], requireAuth);

router.get('/lists', async (req, res) => res.json({ items: await lists.listForUser(req.user, req.query) }));
router.post('/lists/generate', async (req, res) => {
  const body = req.body || {};
  const { list, job_id, created } = await lists.createOrContinue(req.user, body);
  let batch = null;
  if (body.run_first_batch !== false && job_id) batch = await generation.runBatch(req.user, job_id);
  res.json({ list: await lists.getById(list.id), job: batch ? batch.job : null, batch: batch ? batch.batch : null, created });
});
router.get('/lists/:id', async (req, res) => {
  const list = await lists.getForUser(req.user, req.params.id);
  const state = await require('../services/cycle.service').getState();
  const stats = await lists.statsFor([list.id], state.current_cycle_number);
  res.json({ list: { ...list, stats: stats[list.id] || null, is_current_cycle: list.cycle_number === state.current_cycle_number } });
});
router.get('/lists/:id/next', async (req, res) => res.json(await contacts.nextInList(req.user, req.params.id)));

// Runs the next generation batch for a list (frontend polls this until done).
router.post('/lists/:id/generate', async (req, res) => {
  const list = await lists.getForUser(req.user, req.params.id);
  const { rows } = await db.query('SELECT id, status FROM generation_jobs WHERE list_id = $1 ORDER BY created_at DESC LIMIT 1', [list.id]);
  let jobId = rows[0] ? rows[0].id : null;
  if (!jobId || ['completed', 'cancelled'].includes(rows[0].status)) {
    const r = await lists.createOrContinue(req.user, { contact_type: list.contact_type, niche_ids: [], count: (req.body || {}).count || list.target_size }, { forUserId: list.original_owner_id });
    jobId = r.job_id;
    if (!jobId) throw new ConflictError('This list already has its full number of contacts');
  }
  const result = await generation.runBatch(req.user, jobId, { forceUnlock: !!(req.body || {}).force });
  res.json({ ...result, list: await lists.getById(list.id) });
});

router.get('/generation/:jobId', async (req, res) => res.json(await generation.status(req.user, req.params.jobId)));
router.post('/generation/:jobId/cancel', async (req, res) => res.json({ job: await generation.cancel(req.user, req.params.jobId) }));

module.exports = router;
