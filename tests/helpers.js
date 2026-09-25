'use strict';
/**
 * Test harness: runs the real Express app against TEST_DATABASE_URL with a
 * fake Claude client (no network calls). Requires a reachable PostgreSQL.
 */
process.env.NODE_ENV = 'test';
require('dotenv').config();
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must point to an empty PostgreSQL database for tests');
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-encryption-key';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real-0000000000000';
process.env.AI_PROVIDER = 'anthropic'; // the integration suite drives the fake Anthropic client; Gemini has its own unit tests
process.env.LOG_LEVEL = 'error';

const db = require('../server/db');
const { runMigrations } = require('../scripts/migrate');
const app = require('../server/app');
const claude = require('../server/services/claude.service');
const { hashPassword } = require('../server/lib/password');
const { normalizeBusinessName, normalizePhone } = require('../server/lib/normalize');

const USERS = [
  { username: 'Amman', display_name: 'Amman', password: 'Amman@latechs', role: 'employee', rotation_order: 1 },
  { username: 'fizza', display_name: 'Fizza', password: 'fizza@123', role: 'employee', rotation_order: 2 },
  { username: 'shahroz', display_name: 'Shahroz', password: 'shezi', role: 'owner', rotation_order: 3 },
];

class FakeClaude {
  constructor() {
    this.queue = []; this.calls = [];
    this.messages = { stream: (p) => this._stream(p), create: (p) => this._create(p) };
    this.beta = { messages: { stream: (p) => this._stream(p), create: (p) => this._create(p) } };
  }
  queueLeads(leads, { notes = '', webSearch = true } = {}) { this.queue.push({ type: 'leads', leads, notes, webSearch }); }
  queueJson(obj) { this.queue.push({ type: 'json', obj }); }
  queueError(error) { this.queue.push({ type: 'error', error }); }
  _next(params) {
    this.calls.push(params);
    const item = this.queue.shift();
    if (!item) return { id: 'msg', model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 } };
    if (item.type === 'error') throw item.error;
    if (item.type === 'json') return { id: 'msg', model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(item.obj) }], usage: { input_tokens: 1, output_tokens: 1 } };
    const content = [];
    if (item.webSearch) content.push({ type: 'web_search_tool_result', tool_use_id: 'srv1', content: [{ type: 'web_search_result', url: 'https://example.com/source', title: 'Source', encrypted_content: '', page_age: null }] });
    content.push({ type: 'tool_use', id: 'tu1', name: 'submit_leads', input: { search_notes: item.notes, leads: item.leads } });
    return { id: 'msg', model: 'claude-test', stop_reason: 'tool_use', content, usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: item.webSearch ? 2 : 0 } } };
  }
  _stream(p) { return { finalMessage: async () => this._next(p) }; }
  async _create(p) { return this._next(p); }
}

const fake = new FakeClaude();
claude.setClientFactory(() => fake);

let server = null;
let base = null;

async function setup() {
  await runMigrations(db.getPool(), { log: () => {} });
  await resetDb();
  if (!server) {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  return { base };
}

async function teardown() {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  await db.closePool();
}

async function resetDb() {
  // No CASCADE: niches and system_settings reference users (ON DELETE SET NULL) and must survive a reset.
  await db.query('TRUNCATE activity_logs, rotation_history, rotation_runs, generation_rejections, list_contacts, lead_research, meetings, follow_ups, call_records, contacts, generation_jobs, contact_lists, user_api_keys, user_settings, sessions RESTART IDENTITY');
  await db.query('DELETE FROM users');
  await db.query('UPDATE rotation_state SET current_cycle_number = 1, cycle_started_at = NULL, next_rotation_at = NULL, last_rotation_at = NULL, last_rotation_run_id = NULL');
  await db.query("UPDATE system_settings SET value = '3' WHERE key = 'rotation_interval_days'");
  await db.query("UPDATE system_settings SET value = '2' WHERE key = 'list_max_rotations'");
  await db.query("UPDATE system_settings SET value = 'true' WHERE key = 'rotation_enabled'");
  await db.query("UPDATE system_settings SET value = 'true' WHERE key = 'auto_generate_after_rotation'");
  await db.query("UPDATE system_settings SET value = '50' WHERE key = 'list_size'");
  await db.query("UPDATE system_settings SET value = '5' WHERE key = 'generation_batch_size'");
  const ids = {};
  for (const u of USERS) {
    const { rows } = await db.query('INSERT INTO users (username, display_name, password_hash, role, rotation_order) VALUES ($1, $2, $3, $4, $5) RETURNING id', [u.username, u.display_name, hashPassword(u.password), u.role, u.rotation_order]);
    ids[u.username.toLowerCase()] = rows[0].id;
  }
  fake.queue.length = 0; fake.calls.length = 0;
  return ids;
}

async function request(method, path, { body, cookie, headers = {} } = {}) {
  const h = { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  return { status: res.status, body: json, text, setCookie: res.headers.get('set-cookie') };
}

async function login(username, password) {
  const r = await request('POST', '/api/auth/login', { body: { username, password } });
  if (r.status !== 200) throw new Error(`Login failed for ${username}: ${r.status} ${r.text}`);
  const cookie = r.setCookie.split(';')[0];
  return { cookie, user: r.body.user };
}

async function loginAll() {
  return { amman: await login('Amman', 'Amman@latechs'), fizza: await login('fizza', 'fizza@123'), shahroz: await login('shahroz', 'shezi') };
}

let leadCounter = 0;
function makeLead(overrides = {}) {
  leadCounter += 1;
  const n = leadCounter;
  return {
    business_name: `Test Beauty Studio ${n}`, niche: "Ladies' Beauty Salons", city: 'Lahore', address: `${n} Main Boulevard, Gulberg`,
    phone: `0300-${String(1000000 + n).slice(-7)}`, whatsapp: null, public_email: null, website: null, website_status: 'no_website', online_booking_status: 'none',
    social_profiles: { instagram: `https://instagram.com/testbeauty${n}`, facebook: null, tiktok: null, linkedin: null, youtube: null, other: null },
    business_description: 'A women-run beauty studio taking bookings over WhatsApp.', services: ['Bridal makeup', 'Facials'], company_size: 'medium', employee_count_estimate: '5-10',
    business_locations: ['Gulberg, Lahore'], departments: [], owners: [{ name: 'Sana Khan', designation: 'Owner', source_url: 'https://instagram.com/testbeauty' }], management: [], decision_makers: [],
    current_booking_method: 'WhatsApp and phone', booking_problems: 'Reviews mention slow replies', website_opportunity: 'No website; bookings by DM', booking_automation_opportunity: 'Online booking would reduce missed calls',
    existing_software: [], operational_challenges: [], repetitive_processes: [], automation_opportunities: [], relevant_latechs_services: ['Online Booking Systems'],
    field_verification: { business_name: 'verified', phone: 'verified', website: 'verified', address: 'verified', social_profiles: 'verified', people: 'estimated' },
    source_urls: [`https://instagram.com/testbeauty${n}`, 'https://maps.google.com/?cid=123'], confidence: 'verified', qualification_notes: 'Appointment-based, no website, WhatsApp bookings.',
    ...overrides,
  };
}

/** Inserts a contact directly (bypassing Claude) into a list owned by ownerId. */
async function insertContact({ listId, ownerId, type = 'strategy', name, city = 'Lahore', phone = null, status = 'not_called' }) {
  const { rows } = await db.query(
    `INSERT INTO contacts (business_name, normalized_business_name, niche, phone, normalized_phone, city, contact_type, contact_list_id, current_owner_id, original_owner_id, contact_status, data_status, generation_source, generation_timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, 'estimated', 'test', now()) RETURNING id`,
    [name, normalizeBusinessName(name), type === 'strategy' ? "Ladies' Beauty Salons" : 'Travel Agencies', phone, normalizePhone(phone), city, type, listId, ownerId, status],
  );
  await db.query('INSERT INTO list_contacts (list_id, contact_id, position) VALUES ($1, $2, (SELECT COALESCE(MAX(position), 0) + 1 FROM list_contacts WHERE list_id = $1))', [listId, rows[0].id]);
  return rows[0].id;
}

/** Creates a list for a user (via the real service) and fills it with n direct contacts. */
async function createListWithContacts(user, type, n, prefix = 'Biz') {
  const lists = require('../server/services/lists.service');
  const { list } = await lists.createOrContinue({ id: user.id, role: user.role, display_name: user.display_name }, { contact_type: type, niche_ids: [], count: Math.max(n, 1) });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(await insertContact({ listId: list.id, ownerId: user.id, type, name: `${prefix} ${type} ${user.display_name} ${i + 1}`, phone: `03${String(10000000 + Math.floor(Math.random() * 89999999))}` }));
  await db.query("UPDATE generation_jobs SET status = 'completed' WHERE list_id = $1", [list.id]);
  await db.query("UPDATE contact_lists SET list_status = 'active' WHERE id = $1", [list.id]);
  return { listId: list.id, contactIds: ids };
}

module.exports = { db, fake, setup, teardown, resetDb, request, login, loginAll, makeLead, insertContact, createListWithContacts, USERS, claude };
