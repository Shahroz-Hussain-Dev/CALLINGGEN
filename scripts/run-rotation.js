#!/usr/bin/env node
/** Runs the scheduled rotation process once (for external schedulers / manual runs). */
require('dotenv').config();
const rotation = require('../server/services/rotation.service');
const db = require('../server/db');

rotation.runScheduled({ trigger: 'cron', timeBudgetMs: parseInt(process.env.LEAD_GENERATION_TIME_BUDGET_MS || '120000', 10) })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); return db.closePool(); })
  .catch((err) => { console.error('Rotation run failed:', err.message); process.exit(1); });
