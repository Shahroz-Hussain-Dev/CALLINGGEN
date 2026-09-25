'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(async () => { await h.setup(); });
after(async () => { await h.teardown(); });
beforeEach(async () => { await h.resetDb(); });

const meeting = (over = {}) => ({ business_name: 'Skyline Travels', meeting_type: 'automation_sales', meeting_date: '2030-06-10', start_time: '10:00', end_time: '11:00', contact_person: 'Ali', ...over });

test('creates a meeting visible to every user; only the owner or admin may edit it', async () => {
  const { amman, fizza, shahroz } = await h.loginAll();
  const c = await h.request('POST', '/api/meetings', { cookie: amman.cookie, body: meeting() });
  assert.equal(c.status, 201, c.text);
  const id = c.body.meeting.id;
  assert.equal(c.body.meeting.owner_name, 'Amman');
  for (const who of [amman, fizza, shahroz]) {
    const l = await h.request('GET', '/api/meetings?from=2030-06-01&to=2030-06-30', { cookie: who.cookie });
    assert.equal(l.body.items.length, 1, who.user.username);
    assert.equal(l.body.items[0].business_name, 'Skyline Travels');
    assert.equal(l.body.items[0].can_manage, who.user.username !== 'fizza');
  }
  assert.equal((await h.request('PATCH', `/api/meetings/${id}`, { cookie: fizza.cookie, body: { notes: 'x' } })).status, 403);
  assert.equal((await h.request('DELETE', `/api/meetings/${id}`, { cookie: fizza.cookie })).status, 403);
  const adminEdit = await h.request('PATCH', `/api/meetings/${id}`, { cookie: shahroz.cookie, body: { notes: 'Admin note', location: 'Client office' } });
  assert.equal(adminEdit.status, 200, adminEdit.text);
  assert.equal(adminEdit.body.meeting.notes, 'Admin note');
  const ownerEdit = await h.request('PATCH', `/api/meetings/${id}`, { cookie: amman.cookie, body: { meeting_status: 'completed', outcome: { interest_level: 'interested', meeting_result: 'Proposal requested', next_steps: 'Send proposal', follow_up_date: '2030-06-15' } } });
  assert.equal(ownerEdit.status, 200, ownerEdit.text);
  assert.equal(ownerEdit.body.meeting.outcome.meeting_result, 'Proposal requested');
});

test('prevents overlapping meetings team-wide but allows different / adjacent times', async () => {
  const { amman, fizza } = await h.loginAll();
  assert.equal((await h.request('POST', '/api/meetings', { cookie: amman.cookie, body: meeting() })).status, 201);
  const overlap = await h.request('POST', '/api/meetings', { cookie: fizza.cookie, body: meeting({ business_name: 'Other Co', start_time: '10:30', end_time: '11:30' }) });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.error.code, 'conflict');
  assert.equal(overlap.body.error.details.conflicts[0].owner_name, 'Amman');
  assert.equal((await h.request('POST', '/api/meetings', { cookie: fizza.cookie, body: meeting({ start_time: '09:00', end_time: '12:00' }) })).status, 409, 'containing slot');
  assert.equal((await h.request('POST', '/api/meetings', { cookie: fizza.cookie, body: meeting({ start_time: '10:15', end_time: '10:45' }) })).status, 409, 'inner slot');
  assert.equal((await h.request('POST', '/api/meetings', { cookie: fizza.cookie, body: meeting({ start_time: '11:00', end_time: '12:00' }) })).status, 201, 'adjacent slot');
  assert.equal((await h.request('POST', '/api/meetings', { cookie: fizza.cookie, body: meeting({ meeting_date: '2030-06-11' }) })).status, 201, 'another day');
  const check = await h.request('POST', '/api/meetings/check', { cookie: fizza.cookie, body: { meeting_date: '2030-06-10', start_time: '10:30', end_time: '10:45' } });
  assert.equal(check.body.available, false);
  assert.equal((await h.request('POST', '/api/meetings', { cookie: fizza.cookie, body: meeting({ start_time: '13:00', end_time: '12:00' }) })).status, 400, 'end before start');
});

test('simultaneous bookings of the same slot: exactly one succeeds (database exclusion constraint)', async () => {
  const { amman, fizza, shahroz } = await h.loginAll();
  const results = await Promise.all([amman, fizza, shahroz].map((u) => h.request('POST', '/api/meetings', { cookie: u.cookie, body: meeting({ business_name: 'Race ' + u.user.username }) })));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409]);
  const { rows } = await h.db.query("SELECT count(*) AS n FROM meetings WHERE meeting_status = 'scheduled'");
  assert.equal(Number(rows[0].n), 1);
});

test('cancelling frees the slot and keeps the record; idempotency keys prevent duplicate bookings on retry', async () => {
  const { amman } = await h.loginAll();
  const a = await h.request('POST', '/api/meetings', { cookie: amman.cookie, body: meeting({ idempotency_key: 'retry-1' }) });
  const b = await h.request('POST', '/api/meetings', { cookie: amman.cookie, body: meeting({ idempotency_key: 'retry-1' }) });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.equal(a.body.meeting.id, b.body.meeting.id);
  const { rows } = await h.db.query('SELECT count(*) AS n FROM meetings');
  assert.equal(Number(rows[0].n), 1);
  const del = await h.request('DELETE', `/api/meetings/${a.body.meeting.id}`, { cookie: amman.cookie });
  assert.equal(del.body.meeting.meeting_status, 'cancelled');
  assert.equal((await h.request('POST', '/api/meetings', { cookie: amman.cookie, body: meeting({ business_name: 'After cancel' }) })).status, 201);
  const { rows: all } = await h.db.query('SELECT count(*) AS n FROM meetings');
  assert.equal(Number(all[0].n), 2, 'cancelled meeting is kept as history');
});

test('booking from a contact updates the contact\'s meeting status and links the business', async () => {
  const { fizza } = await h.loginAll();
  const { contactIds } = await h.createListWithContacts(fizza.user, 'service', 1);
  const r = await h.request('POST', '/api/meetings', { cookie: fizza.cookie, body: meeting({ business_contact_id: contactIds[0], business_name: undefined }) });
  assert.equal(r.status, 201, r.text);
  assert.match(r.body.meeting.business_name, /service Fizza 1/);
  const { rows } = await h.db.query('SELECT meeting_status FROM contacts WHERE id = $1', [contactIds[0]]);
  assert.equal(rows[0].meeting_status, 'booked');
  const detail = await h.request('GET', `/api/leads/${contactIds[0]}`, { cookie: fizza.cookie });
  assert.equal(detail.body.meetings.length, 1);
});
