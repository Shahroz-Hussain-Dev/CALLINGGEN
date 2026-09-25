#!/usr/bin/env node
/**
 * Versioned, repeatable migration runner.
 * Usage: node scripts/migrate.js            (applies pending migrations)
 *        node scripts/migrate.js --status   (shows applied / pending)
 * Every file in db/migrations is applied once, in filename order, inside a
 * transaction, and recorded in schema_migrations. Files are written with
 * IF NOT EXISTS guards so re-running is also safe.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createPool } = require('../server/db');

/** Applies pending migrations using the given pool. Returns the list of applied files. */
async function runMigrations(pool, { statusOnly = false, log = console.log } = {}) {
  const client = await pool.connect();
  const appliedNow = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const pending = files.filter((f) => !applied.has(f));
    if (statusOnly) {
      log('Applied migrations:');
      files.filter((f) => applied.has(f)).forEach((f) => log('  [x] ' + f));
      log('Pending migrations:');
      pending.forEach((f) => log('  [ ] ' + f));
      if (!pending.length) log('  (none)');
      return [];
    }
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`Applied ${file}`);
        appliedNow.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        log(`FAILED ${file}: ${err.message}`);
        throw err;
      }
    }
    if (!pending.length) log('Database is up to date.');
    return appliedNow;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = createPool();
  try { await runMigrations(pool, { statusOnly: process.argv.includes('--status') }); } finally { await pool.end(); }
}

module.exports = { runMigrations };
if (require.main === module) {
  main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
}
