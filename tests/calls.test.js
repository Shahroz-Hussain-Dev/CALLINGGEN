'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(async () => { await h.setup(); });
after(async () => { await h.teardown(); });
beforeEach(async () => { await h.resetDb(); });

test('records a call with status, panel fields and follow-up, updates the contact and advances the workflow', async () => {
  const { amman } = await h.loginAll();
  const { listId, contactIds } = await h.createListWithContacts(amman.user, 'strategy', 3);
  let next = await h.request('GET', `/api/lists/${listId}/next`, { cookie: amman.cookie });
  assert.equal(next.body.contact.id, contactIds[0]);
  assert.equal(next.body.progress.remaining, 3);
  const bad = await h.request('POST', `/api/leads/${contactIds[0]}/call`, { cookie: amman.cookie, body: { call_status: 'interested' } });
  assert.equal(bad.status, 400, 'conversation summary is required for a real conversation');
  const r = await h.request('POST', `/api/leads/${contactIds[0]}/call`, { cookie: amman.cookie, body: {
    call_status: 'interested', person_contacted: 'Sana', person_designation: 'Owner', conversation_summary: 'Asked about bookings as a customer; they use WhatsApp only.',
    customer_response: 'Open to a website', interest_level: 'maybe_follow_up', follow_up_required: true, next_follow_up_date: '2030-01-10', problems_identified: 'Missed calls',
    panel_fields: { asked_about_online_booking: true, has_website: false, current_booking_method: 'WhatsApp DM', offers_online_appointments: false, latechs_introduced: true, interested_in_website: true },
  } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.call.call_status, 'interested');
  assert.equal(r.body.call.panel_fields.current_booking_method, 'WhatsApp DM');
  assert.ok(r.body.follow_up, 'follow-up created from the call');
  assert.equal(r.body.follow_up.follow_up_date, '2030-01-10');
  assert.equal(r.body.contact.contact_status, 'interested');
  assert.equal(r.body.contact.interest_level, 'maybe_follow_up');
  assert.equal(r.body.contact.website_available, false);
  assert.equal(r.body.contact.business_operations.current_booking_method, 'WhatsApp DM');
  assert.equal(r.body.contact.business_operations.latechs_introduced, true);
  assert.equal(r.body.contact.call_count, 1);
  assert.equal(r.body.contact.processed_cycle, 1);
  next = await h.request('GET', `/api/lists/${listId}/next`, { cookie: amman.cookie });
  assert.equal(next.body.contact.id, contactIds[1], 'next contact is the following unprocessed one');
  assert.equal(next.body.progress.processed, 1);
  const { rows } = await h.db.query("SELECT action FROM activity_logs WHERE action IN ('call_recorded','follow_up_created') ORDER BY id");
  assert.deepEqual(rows.map((x) => x.action), ['follow_up_created', 'call_recorded']);
});

test('call history is preserved chronologically across multiple calls and visible to the admin', async () => {
  const { fizza, shahroz } = await h.loginAll();
  const { contactIds } = await h.createListWithContacts(fizza.user, 'service', 1);
  const cid = contactIds[0];
  await h.request('POST', `/api/leads/${cid}/call`, { cookie: fizza.cookie, body: { call_status: 'no_answer' } });
  await h.request('POST', `/api/leads/${cid}/call`, { cookie: fizza.cookie, body: { call_status: 'call_back_later', conversation_summary: 'Receptionist asked to call tomorrow', next_follow_up_date: '2030-02-02', panel_fields: { business_contacted: true, decision_maker_reached: false } } });
  await h.request('POST', `/api/leads/${cid}/call`, { cookie: fizza.cookie, body: { call_status: 'meeting_booked', conversation_summary: 'Reached the director; meeting agreed', interest_level: 'meeting_booked', panel_fields: { decision_maker_reached: true, decision_maker_name: 'Ahmed Raza', decision_maker_designation: 'Director', meeting_booked: true } } });
  const detail = await h.request('GET', `/api/leads/${cid}`, { cookie: shahroz.cookie });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.call_history.map((c) => c.call_status), ['no_answer', 'call_back_later', 'meeting_booked']);
  assert.equal(detail.body.contact.meeting_status, 'booked');
  assert.equal(detail.body.contact.call_count, 3);
  assert.equal(detail.body.contact.decision_makers[0].name, 'Ahmed Raza');
  assert.equal(detail.body.follow_ups.length, 1);
  const own = await h.request('GET', `/api/leads/${cid}/calls`, { cookie: fizza.cookie });
  assert.equal(own.body.items.length, 3);
});

test('skipping requires a reason and never marks the contact as called', async () => {
  const { amman } = await h.loginAll();
  const { listId, contactIds } = await h.createListWithContacts(amman.user, 'strategy', 2);
  assert.equal((await h.request('POST', `/api/leads/${contactIds[0]}/skip`, { cookie: amman.cookie, body: {} })).status, 400);
  const r = await h.request('POST', `/api/leads/${contactIds[0]}/skip`, { cookie: amman.cookie, body: { reason: 'Business already contacted by phone yesterday' } });
  assert.equal(r.status, 201);
  const next = await h.request('GET', `/api/lists/${listId}/next`, { cookie: amman.cookie });
  assert.equal(next.body.contact.id, contactIds[1]);
  const { rows } = await h.db.query('SELECT contact_status, call_count, skip_reason FROM contacts WHERE id = $1', [contactIds[0]]);
  assert.equal(rows[0].contact_status, 'not_called');
  assert.equal(rows[0].call_count, 0);
  assert.match(rows[0].skip_reason, /already contacted/);
});

test('follow-ups can be created, completed and rescheduled without losing history', async () => {
  const { amman } = await h.loginAll();
  const { contactIds } = await h.createListWithContacts(amman.user, 'strategy', 1);
  const c = await h.request('POST', `/api/leads/${contactIds[0]}/follow-up`, { cookie: amman.cookie, body: { follow_up_date: '2030-03-03', reason: 'Send website examples', notes: 'Owner asked for samples' } });
  assert.equal(c.status, 201, c.text);
  const id = c.body.id;
  const re = await h.request('PATCH', `/api/follow-ups/${id}`, { cookie: amman.cookie, body: { status: 'rescheduled', follow_up_date: '2030-03-10' } });
  assert.equal(re.status, 200, re.text);
  assert.notEqual(re.body.follow_up.id, id);
  assert.equal(re.body.follow_up.follow_up_date, '2030-03-10');
  const { rows } = await h.db.query('SELECT status, rescheduled_to_id FROM follow_ups WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'rescheduled');
  assert.equal(rows[0].rescheduled_to_id, re.body.follow_up.id);
  const done = await h.request('PATCH', `/api/follow-ups/${re.body.follow_up.id}`, { cookie: amman.cookie, body: { status: 'completed', notes: 'Sent' } });
  assert.equal(done.body.follow_up.status, 'completed');
  const list = await h.request('GET', '/api/follow-ups?status=completed', { cookie: amman.cookie });
  assert.equal(list.body.total, 1);
  const all = await h.db.query('SELECT count(*) AS n FROM follow_ups');
  assert.equal(Number(all.rows[0].n), 2, 'old follow-up history is kept');
});
