'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const rotation = require('../server/services/rotation.service');

before(async () => { await h.setup(); });
after(async () => { await h.teardown(); });
beforeEach(async () => { await h.resetDb(); });

async function seedLists(users) {
  const out = {};
  for (const key of ['amman', 'fizza', 'shahroz']) {
    out[key] = { strategy: await h.createListWithContacts(users[key].user, 'strategy', 5), service: await h.createListWithContacts(users[key].user, 'service', 5) };
  }
  return out;
}
const makeDue = () => h.db.query("UPDATE rotation_state SET next_rotation_at = now() - interval '1 minute' WHERE id = 1");

test('cycle starts at the first list and schedules rotation three days later; rotation is refused before then', async () => {
  const users = await h.loginAll();
  await h.createListWithContacts(users.amman.user, 'strategy', 1);
  const { rows } = await h.db.query('SELECT cycle_started_at, next_rotation_at, current_cycle_number FROM rotation_state WHERE id = 1');
  const days = (new Date(rows[0].next_rotation_at) - new Date(rows[0].cycle_started_at)) / 86400000;
  assert.equal(days, 3);
  assert.equal(rows[0].current_cycle_number, 1);
  const r = await rotation.runRotation({ trigger: 'test' });
  assert.equal(r.rotated, false);
  assert.equal(r.reason, 'not_due');
  const status = await h.request('GET', '/api/rotation/status', { cookie: users.amman.cookie });
  assert.equal(status.body.cycle.days_remaining <= 3 && status.body.cycle.days_remaining >= 2, true);
});

test('day 4: every list transfers Amman -> Fizza -> Shahroz -> Amman with full history, incomplete or not, and new lists are generated', async () => {
  const users = await h.loginAll();
  const lists = await seedLists(users);
  // Amman worked only 2 of 5 strategy contacts, with a pending follow-up
  const worked = lists.amman.strategy.contactIds.slice(0, 2);
  await h.request('POST', `/api/leads/${worked[0]}/call`, { cookie: users.amman.cookie, body: { call_status: 'interested', conversation_summary: 'Good call', follow_up_required: true, next_follow_up_date: '2030-05-05' } });
  await h.request('POST', `/api/leads/${worked[1]}/call`, { cookie: users.amman.cookie, body: { call_status: 'no_answer' } });
  await makeDue();
  const r = await rotation.runRotation({ trigger: 'test' });
  assert.equal(r.rotated, true, JSON.stringify(r));
  assert.equal(r.lists_rotated, 6);
  assert.equal(r.lists_created, 6, 'fresh lists for 3 users x 2 panels');
  assert.equal(r.cycle_to, 2);
  const owner = async (listId) => (await h.db.query('SELECT current_owner_id, original_owner_id, rotation_count FROM contact_lists WHERE id = $1', [listId])).rows[0];
  const a = await owner(lists.amman.strategy.listId); assert.equal(a.current_owner_id, users.fizza.user.id); assert.equal(a.original_owner_id, users.amman.user.id); assert.equal(a.rotation_count, 1);
  const f = await owner(lists.fizza.service.listId); assert.equal(f.current_owner_id, users.shahroz.user.id);
  const s = await owner(lists.shahroz.strategy.listId); assert.equal(s.current_owner_id, users.amman.user.id);
  // all 5 contacts moved, including the 3 never called
  const { rows: moved } = await h.db.query('SELECT count(*) AS n FROM contacts WHERE contact_list_id = $1 AND current_owner_id = $2', [lists.amman.strategy.listId, users.fizza.user.id]);
  assert.equal(Number(moved[0].n), 5);
  // history preserved and visible to the new owner; previous owner loses access
  const asFizza = await h.request('GET', `/api/leads/${worked[0]}`, { cookie: users.fizza.cookie });
  assert.equal(asFizza.status, 200);
  assert.equal(asFizza.body.call_history.length, 1);
  assert.equal(asFizza.body.call_history[0].employee_name, 'Amman');
  assert.equal(asFizza.body.rotation_history.length, 1);
  assert.equal(asFizza.body.processed_this_cycle, false, 'new cycle: contact is workable again by the new owner');
  assert.equal((await h.request('GET', `/api/leads/${worked[0]}`, { cookie: users.amman.cookie })).status, 403);
  assert.equal((await h.request('GET', `/api/leads/${worked[0]}`, { cookie: users.shahroz.cookie })).status, 200, 'admin always keeps access');
  // pending follow-up reassigned
  const { rows: fu } = await h.db.query('SELECT owner_id, previous_owner_id FROM follow_ups');
  assert.equal(fu[0].owner_id, users.fizza.user.id); assert.equal(fu[0].previous_owner_id, users.amman.user.id);
  // rotation history + audit
  const { rows: hist } = await h.db.query("SELECT count(*) AS n FROM rotation_history WHERE event_type = 'rotated'");
  assert.equal(Number(hist[0].n), 6);
  const { rows: logs } = await h.db.query("SELECT action, count(*) AS n FROM activity_logs WHERE action IN ('list_rotated','ownership_transferred','rotation_completed','list_created') GROUP BY action ORDER BY action");
  assert.deepEqual(Object.fromEntries(logs.map((x) => [x.action, Number(x.n)])), { list_created: 12, list_rotated: 6, ownership_transferred: 6, rotation_completed: 1 });
  // the new lists belong to the current cycle and are awaiting generation
  const { rows: fresh } = await h.db.query("SELECT list_status, cycle_number, original_owner_id FROM contact_lists WHERE cycle_number = 2");
  assert.equal(fresh.length, 6);
  assert.ok(fresh.every((l) => l.list_status === 'generating'));
  const { rows: jobs } = await h.db.query("SELECT count(*) AS n FROM generation_jobs WHERE status = 'pending'");
  assert.equal(Number(jobs[0].n), 6);
  // nothing deleted
  const { rows: total } = await h.db.query('SELECT count(*) AS n FROM contacts');
  assert.equal(Number(total[0].n), 30);
  // new owner's panel shows both the received list and their own new list
  const fizzaLists = await h.request('GET', '/api/lists?contact_type=strategy', { cookie: users.fizza.cookie });
  assert.equal(fizzaLists.body.items.length, 2);
});

test('running the scheduler twice (even concurrently) never rotates twice', async () => {
  const users = await h.loginAll();
  await seedLists(users);
  await makeDue();
  const results = await Promise.all([rotation.runRotation({ trigger: 'cron' }), rotation.runRotation({ trigger: 'cron' }), rotation.runRotation({ trigger: 'cron' })]);
  assert.equal(results.filter((r) => r.rotated).length, 1);
  const again = await rotation.runRotation({ trigger: 'cron' });
  assert.equal(again.rotated, false);
  const { rows } = await h.db.query("SELECT count(*) AS n FROM rotation_runs WHERE status = 'completed'");
  assert.equal(Number(rows[0].n), 1);
  const { rows: st } = await h.db.query('SELECT current_cycle_number FROM rotation_state');
  assert.equal(st[0].current_cycle_number, 2);
  const { rows: hist } = await h.db.query('SELECT list_id, count(*) AS n FROM rotation_history GROUP BY list_id HAVING count(*) > 1');
  assert.equal(hist.length, 0);
});

test('a list is archived (never deleted) after it has visited every employee; the cron endpoint is secured', async () => {
  const users = await h.loginAll();
  const lists = await seedLists(users);
  await h.db.query("UPDATE system_settings SET value = 'false' WHERE key = 'auto_generate_after_rotation'");
  await makeDue(); await rotation.runRotation({ trigger: 'test' });
  await makeDue(); await rotation.runRotation({ trigger: 'test' });
  await makeDue(); const third = await rotation.runRotation({ trigger: 'test' });
  assert.equal(third.lists_completed, 6, 'after 2 rotations each original list has been with all three people');
  const { rows } = await h.db.query('SELECT list_status, current_owner_id FROM contact_lists WHERE id = $1', [lists.amman.strategy.listId]);
  assert.equal(rows[0].list_status, 'completed');
  assert.equal(rows[0].current_owner_id, users.shahroz.user.id);
  const { rows: contacts } = await h.db.query('SELECT count(*) AS n FROM contacts');
  assert.equal(Number(contacts[0].n), 30);
  assert.equal((await h.request('GET', '/api/rotation/cron')).status, 401);
  assert.equal((await h.request('GET', '/api/rotation/cron', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await h.request('GET', '/api/rotation/cron', { headers: { Authorization: 'Bearer test-cron-secret' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rotation.rotated, false);
});

test('the owner can force a rotation from the API and it is audited with the trigger', async () => {
  const users = await h.loginAll();
  await seedLists(users);
  const r = await h.request('POST', '/api/rotation/run', { cookie: users.shahroz.cookie, body: { force: true } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.rotated, true);
  const { rows } = await h.db.query('SELECT trigger_source, triggered_by FROM rotation_runs ORDER BY started_at DESC LIMIT 1');
  assert.equal(rows[0].trigger_source, 'manual');
  assert.equal(rows[0].triggered_by, users.shahroz.user.id);
  const overview = await h.request('GET', '/api/rotation/overview', { cookie: users.shahroz.cookie });
  assert.equal(overview.body.cycle.current_cycle_number, 2);
  assert.equal(overview.body.history.length, 6);
});
