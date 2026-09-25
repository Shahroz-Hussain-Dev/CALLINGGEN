'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ids;
before(async () => { await h.setup(); });
after(async () => { await h.teardown(); });
beforeEach(async () => { ids = await h.resetDb(); });

test('valid login sets an httpOnly session cookie and /api/me works', async () => {
  const r = await h.request('POST', '/api/auth/login', { body: { username: 'Amman', password: 'Amman@latechs' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'employee');
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  const me = await h.request('GET', '/api/me', { cookie: r.setCookie.split(';')[0] });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'Amman');
});

test('usernames are case-insensitive', async () => {
  for (const name of ['AMMAN', 'amman', 'FiZzA', 'SHAHROZ']) {
    const r = await h.request('POST', '/api/auth/login', { body: { username: name, password: name.toLowerCase().startsWith('amman') ? 'Amman@latechs' : name.toLowerCase().startsWith('fizza') ? 'fizza@123' : 'shezi' } });
    assert.equal(r.status, 200, name);
  }
});

test('invalid login is rejected and passwords are never stored in plain text', async () => {
  const r = await h.request('POST', '/api/auth/login', { body: { username: 'Amman', password: 'wrong' } });
  assert.equal(r.status, 401);
  const { rows } = await h.db.query('SELECT password_hash FROM users');
  for (const row of rows) { assert.match(row.password_hash, /^scrypt\$/); assert.doesNotMatch(row.password_hash, /shezi|Amman@latechs|fizza@123/); }
});

test('unauthenticated and cross-site requests are rejected', async () => {
  assert.equal((await h.request('GET', '/api/leads')).status, 401);
  assert.equal((await h.request('GET', '/api/meetings')).status, 401);
  const noMarker = await fetch((await h.setup()).base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Amman', password: 'Amman@latechs' }) });
  assert.equal(noMarker.status, 403);
});

test('employees cannot reach admin routes; the owner can', async () => {
  const { amman, shahroz } = await h.loginAll();
  for (const path of ['/api/admin/analytics', '/api/admin/contacts', '/api/admin/activity', '/api/rotation/overview', '/api/admin/users']) {
    assert.equal((await h.request('GET', path, { cookie: amman.cookie })).status, 403, path);
    assert.equal((await h.request('GET', path, { cookie: shahroz.cookie })).status, 200, path);
  }
  assert.equal((await h.request('POST', '/api/rotation/run', { cookie: amman.cookie, body: {} })).status, 403);
  assert.equal((await h.request('PATCH', '/api/settings/system', { cookie: amman.cookie, body: { list_size: 10 } })).status, 403);
});

test('an employee cannot access another employee\'s private contact, list or call history by ID', async () => {
  const { amman, fizza, shahroz } = await h.loginAll();
  const { listId, contactIds } = await h.createListWithContacts(amman.user, 'strategy', 2);
  const cid = contactIds[0];
  assert.equal((await h.request('GET', `/api/leads/${cid}`, { cookie: fizza.cookie })).status, 403);
  assert.equal((await h.request('GET', `/api/leads/${cid}/calls`, { cookie: fizza.cookie })).status, 403);
  assert.equal((await h.request('POST', `/api/leads/${cid}/call`, { cookie: fizza.cookie, body: { call_status: 'no_answer' } })).status, 403);
  assert.equal((await h.request('GET', `/api/lists/${listId}`, { cookie: fizza.cookie })).status, 403);
  assert.equal((await h.request('GET', `/api/lists/${listId}/next`, { cookie: fizza.cookie })).status, 403);
  assert.equal((await h.request('GET', `/api/leads/${cid}`, { cookie: amman.cookie })).status, 200);
  assert.equal((await h.request('GET', `/api/leads/${cid}`, { cookie: shahroz.cookie })).status, 200);
  // list endpoints only expose own contacts
  const fizzaLeads = await h.request('GET', '/api/leads', { cookie: fizza.cookie });
  assert.equal(fizzaLeads.body.total, 0);
  const ammanLeads = await h.request('GET', '/api/leads', { cookie: amman.cookie });
  assert.equal(ammanLeads.body.total, 2);
  // employee filter injection is ignored for employees
  const sneaky = await h.request('GET', `/api/leads?employee_id=${amman.user.id}`, { cookie: fizza.cookie });
  assert.equal(sneaky.body.total, 0);
});

test('logout revokes the session', async () => {
  const { amman } = await h.loginAll();
  assert.equal((await h.request('POST', '/api/auth/logout', { cookie: amman.cookie })).status, 200);
  assert.equal((await h.request('GET', '/api/me', { cookie: amman.cookie })).status, 401);
});

test('password change works and is audited', async () => {
  const { fizza } = await h.loginAll();
  assert.equal((await h.request('POST', '/api/me/password', { cookie: fizza.cookie, body: { current_password: 'wrong', new_password: 'newpass123' } })).status, 401);
  assert.equal((await h.request('POST', '/api/me/password', { cookie: fizza.cookie, body: { current_password: 'fizza@123', new_password: 'newpass123' } })).status, 200);
  assert.equal((await h.request('POST', '/api/auth/login', { body: { username: 'fizza', password: 'fizza@123' } })).status, 401);
  assert.equal((await h.request('POST', '/api/auth/login', { body: { username: 'fizza', password: 'newpass123' } })).status, 200);
  const { rows } = await h.db.query("SELECT count(*) AS n FROM activity_logs WHERE action = 'password_changed'");
  assert.equal(Number(rows[0].n), 1);
});
