'use strict';
/**
 * PostgreSQL access layer (Supabase). One pool per process; on Vercel each
 * serverless instance keeps a small pool. Use the Supabase connection pooler
 * (transaction mode, port 6543) URL as DATABASE_URL in production.
 */
const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings (not timezone-shifted Date objects).
types.setTypeParser(1082, (v) => v);
// Keep BIGINT counts numeric-friendly (they are converted with Number() where used).
const config = require('./config');
const logger = require('./logger');

let pool = null;

function buildConnectionConfig() {
  const db = config.database;
  const base = { max: db.poolMax, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 };
  let host = db.host;
  if (db.url) {
    base.connectionString = db.url;
    try { host = new URL(db.url).hostname; } catch (_) { /* ignore */ }
  } else {
    base.host = db.host;
    base.port = db.port;
    base.database = db.name;
    base.user = db.user;
    base.password = db.password;
  }
  const local = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (db.ssl === 'disable') {
    base.ssl = false;
  } else if (db.ssl === 'require' || !local) {
    // Supabase uses certificates issued by its own CA; verification against the
    // system store fails, so we keep TLS on and skip chain verification.
    base.ssl = { rejectUnauthorized: false };
  } else {
    base.ssl = false;
  }
  return base;
}

function createPool() {
  const p = new Pool(buildConnectionConfig());
  p.on('error', (err) => logger.error('Unexpected PG pool error', { error: err.message }));
  return p;
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Runs fn(client) inside a transaction. Rolls back on any throw.
 * Nested usage: pass an existing client to reuse it (no new transaction).
 */
async function withTransaction(fn, existingClient) {
  if (existingClient) return fn(existingClient);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Returns a query function bound to either a transaction client or the pool. */
function q(client) {
  return client ? (text, params) => client.query(text, params) : query;
}

async function healthCheck() {
  const started = Date.now();
  const { rows } = await query('SELECT now() AS now, current_database() AS db, version() AS version');
  return { ok: true, latencyMs: Date.now() - started, database: rows[0].db, serverTime: rows[0].now, version: rows[0].version.split(' on ')[0] };
}

async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { createPool, getPool, query, withTransaction, q, healthCheck, closePool };
