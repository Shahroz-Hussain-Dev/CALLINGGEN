#!/usr/bin/env node
/**
 * Connectivity probe for deployment environments (run at build time or locally):
 *   node scripts/db-probe.js
 * Reports whether DATABASE_URL is reachable from this environment. For a Supabase
 * direct URL (db.<ref>.supabase.co) that is not reachable (IPv6-only hosts are common),
 * it also tries the Supavisor pooler endpoints across AWS regions and prints the one
 * that works so it can be used as DATABASE_URL. Passwords are never printed.
 */
require('dotenv').config();
const { Pool } = require('pg');

const REGIONS = ['ap-south-1', 'ap-southeast-1', 'us-east-1', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'us-west-1', 'us-east-2', 'ap-northeast-1', 'ap-southeast-2', 'ap-northeast-2', 'eu-west-3', 'ca-central-1', 'sa-east-1', 'eu-north-1', 'ap-south-2', 'us-west-2', 'eu-central-2', 'ap-northeast-3'];

function mask(url) { try { const u = new URL(url); return `${u.protocol}//${u.username}:***@${u.hostname}:${u.port}${u.pathname}`; } catch (_) { return '(invalid url)'; } }

async function tryConnect(connectionString, timeoutMs) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: timeoutMs, ssl: { rejectUnauthorized: false } });
  const started = Date.now();
  try {
    const { rows } = await pool.query('SELECT current_database() AS db, version() AS v');
    return { ok: true, ms: Date.now() - started, db: rows[0].db, version: rows[0].v.split(' on ')[0] };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: String(err.message || err.code).slice(0, 120) };
  } finally { await pool.end().catch(() => {}); }
}

(async () => {
  const configured = process.env.DATABASE_URL;
  if (!configured) { console.log('DB-PROBE: DATABASE_URL is not set'); process.exit(0); }
  console.log(`DB-PROBE: configured ${mask(configured)}`);
  const direct = await tryConnect(configured, 8000);
  console.log(`DB-PROBE: direct ${direct.ok ? 'OK' : 'FAILED'} (${direct.ms} ms) ${direct.ok ? direct.version : direct.error}`);
  if (direct.ok) { console.log(`DB-PROBE: RECOMMENDED ${mask(configured)}`); return; }
  let u; try { u = new URL(configured); } catch (_) { return; }
  const m = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(u.hostname);
  if (!m) return;
  const ref = m[1];
  const password = decodeURIComponent(u.password);
  const skip = (process.env.DB_PROBE_SKIP_POOLER || '') === 'true';
  if (skip) return;
  for (const region of (process.env.DB_PROBE_REGIONS ? process.env.DB_PROBE_REGIONS.split(',') : REGIONS)) {
    for (const prefix of ['aws-0', 'aws-1']) {
      for (const port of ['6543', '5432']) {
        const host = `${prefix}-${region}.pooler.supabase.com`;
        const url = `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:${port}/postgres`;
        const r = await tryConnect(url, 5000);
        console.log(`DB-PROBE: pooler ${host}:${port} ${r.ok ? 'OK' : 'failed'} (${r.ms} ms) ${r.ok ? '' : r.error}`);
        if (r.ok) { console.log(`DB-PROBE: RECOMMENDED postgresql://postgres.${ref}:<password>@${host}:${port}/postgres`); return; }
        if (/Tenant or user not found/i.test(r.error || '')) break; // right pooler host format, wrong region: next region
      }
    }
  }
  console.log('DB-PROBE: no working endpoint found');
})().catch((e) => { console.error('DB-PROBE error', e.message); process.exit(1); });
