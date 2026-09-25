'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ValidationError } = require('../lib/errors');
const contacts = require('../services/contacts.service');
const calls = require('../services/calls.service');
const followups = require('../services/followups.service');
const lists = require('../services/lists.service');
const generation = require('../services/generation.service');
const ai = require('../services/ai.service');
const activity = require('../services/activity.service');
const config = require('../config');

const router = express.Router();
router.use('/leads', requireAuth);

router.get('/leads', async (req, res) => res.json(await contacts.list(req.user, req.query)));
router.get('/leads/filters', async (req, res) => res.json(await contacts.filterOptions(req.user)));

// Generate: creates/continues this cycle's list for the panel and runs the first batch.
router.post('/leads/generate', async (req, res) => {
  const body = req.body || {};
  const { list, job_id, created } = await lists.createOrContinue(req.user, body);
  let batch = null;
  if (body.run_first_batch !== false && job_id) batch = await generation.runBatch(req.user, job_id);
  res.json({ list: await lists.getById(list.id), job: batch ? batch.job : null, batch: batch ? batch.batch : null, created });
});

router.get('/leads/:id', async (req, res) => res.json(await contacts.getDetail(req.user, req.params.id)));
router.get('/leads/:id/calls', async (req, res) => res.json({ items: await calls.listForContact(req.user, req.params.id) }));
router.post('/leads/:id/call', async (req, res) => res.status(201).json(await calls.recordCall(req.user, req.params.id, req.body || {})));
router.post('/leads/:id/follow-up', async (req, res) => res.status(201).json(await followups.create(req.user, req.params.id, req.body || {})));
router.post('/leads/:id/skip', async (req, res) => res.status(201).json({ record: await contacts.skip(req.user, req.params.id, (req.body || {}).reason) }));
router.patch('/leads/:id/notes', async (req, res) => res.json({ contact: await contacts.updateNotes(req.user, req.params.id, (req.body || {}).notes) }));

// Claude-powered research: meeting preparation / automation analysis (service) or booking analysis (strategy)
router.post('/leads/:id/research', async (req, res) => {
  const detail = await contacts.getDetail(req.user, req.params.id);
  const kind = (req.body || {}).kind || (detail.contact.contact_type === 'service' ? 'meeting_prep' : 'booking_analysis');
  if (!['meeting_prep', 'automation_analysis', 'business_profile', 'booking_analysis'].includes(kind)) throw new ValidationError('Unknown research kind');
  const webSearch = (req.body || {}).web_search === undefined ? ai.webSearchDefault() : !!(req.body || {}).web_search;
  let result;
  if (kind === 'booking_analysis') result = await ai.generateBookingAnalysis({ userId: req.user.id, contact: detail.contact, calls: detail.call_history });
  else result = await ai.generateBusinessProfile({ userId: req.user.id, contact: detail.contact, calls: detail.call_history, previousResearch: detail.research[0] ? detail.research[0].content : null, webSearch });
  const saved = await contacts.saveResearch(req.user, detail.contact.id, kind, result.data, result.model, result.sources);
  if (kind !== 'booking_analysis' && result.data && Array.isArray(result.data.automation_opportunities) && result.data.automation_opportunities.length) {
    const db = require('../db');
    await db.query('UPDATE contacts SET automation_opportunities = $2, business_operations = business_operations || $3::jsonb WHERE id = $1', [detail.contact.id, JSON.stringify(result.data.automation_opportunities), JSON.stringify({ team_size_estimate: result.data.team_size_estimate, departments_researched: result.data.departments, operational_processes: result.data.operational_processes, repetitive_tasks: result.data.repetitive_tasks })]);
  }
  await activity.log('research_generated', { userId: req.user.id, contactId: detail.contact.id, details: { kind, provider: ai.activeName(), model: result.model, sources: result.sources.length, usage: result.usage } });
  res.status(201).json({ research: saved, usage: result.usage });
});

module.exports = router;
