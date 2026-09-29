'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const config = require('../server/config');

before(async () => { await h.setup(); });
after(async () => { await h.teardown(); });
beforeEach(async () => { await h.resetDb(); });

async function nicheIds(cookie, panel, n = 1) {
  const r = await h.request('GET', `/api/niches?panel=${panel}`, { cookie });
  return r.body.items.slice(0, n).map((x) => x.id);
}

test('generates leads through Claude, saves verified fields and source URLs, and starts the cycle', async () => {
  const { amman } = await h.loginAll();
  h.fake.queueLeads([h.makeLead(), h.makeLead({ website: 'https://www.instagram.com/some.page' }), h.makeLead({ phone: '+92 321 1234567' })], { notes: 'Found 3 businesses' });
  const r = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'strategy', niche_ids: await nicheIds(amman.cookie, 'strategy', 2), count: 3 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.job.status, 'completed');
  assert.equal(r.body.job.saved_count, 3);
  assert.equal(r.body.batch.web_search_used, true);
  assert.equal(r.body.list.contact_type, 'strategy');
  assert.equal(r.body.list.current_owner_id, amman.user.id);
  const { rows } = await h.db.query('SELECT * FROM contacts ORDER BY created_at');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].data_status, 'verified');
  assert.deepEqual(rows[0].source_urls.length, 2);
  assert.equal(rows[0].normalized_phone.startsWith('92300'), true);
  assert.equal(rows[0].field_verification.phone, 'verified');
  assert.equal(rows[0].current_owner_id, amman.user.id);
  assert.equal(rows[0].generation_source, 'anthropic+web_search');
  // a social page passed as "website" is moved to social profiles, not stored as a website
  assert.equal(rows[1].website, null);
  assert.equal(rows[1].normalized_website_domain, null);
  assert.equal(rows[2].normalized_phone, '923211234567');
  const state = await h.db.query('SELECT * FROM rotation_state WHERE id = 1');
  assert.ok(state.rows[0].cycle_started_at, 'cycle starts when the first list is generated');
  const { rows: logs } = await h.db.query("SELECT count(*) AS n FROM activity_logs WHERE action = 'lead_generated'");
  assert.equal(Number(logs[0].n), 3);
  // the Claude prompt carried the panel rules and the requested niche
  const params = h.fake.calls[0];
  assert.match(params.system[0].text, /STRATEGY LEADS/);
  assert.ok(params.tools.some((t) => t.name === 'submit_leads'));
});

test('rejects duplicates by phone, name+city, fuzzy name and social handle across all employees and panels', async () => {
  const { amman, fizza } = await h.loginAll();
  h.fake.queueLeads([h.makeLead({ business_name: 'Glow Beauty Studio', city: 'Lahore', phone: '0300-5550001', social_profiles: { instagram: 'https://instagram.com/glowstudio.pk', facebook: null, tiktok: null, linkedin: null, youtube: null, other: null } })]);
  let r = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'strategy', niche_ids: await nicheIds(amman.cookie, 'strategy'), count: 1 } });
  assert.equal(r.body.job.saved_count, 1);
  // Fizza, other panel: same phone under a different name; same name with city suffix; near-identical spelling; same instagram handle; plus one genuinely new
  h.fake.queueLeads([
    h.makeLead({ business_name: 'Totally Different Name', phone: '+92 300 5550001', social_profiles: { instagram: null, facebook: null, tiktok: null, linkedin: null, youtube: null, other: null } }),
    h.makeLead({ business_name: 'Glow Beauty Studio Lahore', city: 'Lahore', phone: '0300-7770002', social_profiles: { instagram: null, facebook: null, tiktok: null, linkedin: null, youtube: null, other: null } }),
    h.makeLead({ business_name: 'Glo Beauty Studio', city: 'Lahore', phone: '0300-7770003', social_profiles: { instagram: null, facebook: null, tiktok: null, linkedin: null, youtube: null, other: null } }),
    h.makeLead({ business_name: 'Glow Studio Official', city: 'Karachi', phone: '0300-7770004', social_profiles: { instagram: 'https://www.instagram.com/GlowStudio.pk/', facebook: null, tiktok: null, linkedin: null, youtube: null, other: null } }),
    h.makeLead({ business_name: 'Rose Petal Salon', city: 'Karachi', phone: '0300-7770005' }),
  ]);
  r = await h.request('POST', '/api/leads/generate', { cookie: fizza.cookie, body: { contact_type: 'service', niche_ids: await nicheIds(fizza.cookie, 'service'), count: 5 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.batch.duplicates, 4, JSON.stringify(r.body.batch));
  assert.equal(r.body.batch.saved, 1);
  const { rows } = await h.db.query('SELECT business_name FROM contacts ORDER BY created_at');
  assert.deepEqual(rows.map((x) => x.business_name), ['Glow Beauty Studio', 'Rose Petal Salon']);
  const { rows: rej } = await h.db.query("SELECT reason, details->>'match_reason' AS why FROM generation_rejections ORDER BY id");
  assert.deepEqual(rej.map((x) => x.why), ['same_phone', 'same_name_and_city', 'similar_name_same_city', 'same_instagram']);
  const { rows: logs } = await h.db.query("SELECT count(*) AS n FROM activity_logs WHERE action = 'lead_rejected_duplicate'");
  assert.equal(Number(logs[0].n), 4);
});

test('similar names in different cities are NOT merged', async () => {
  const { amman } = await h.loginAll();
  h.fake.queueLeads([h.makeLead({ business_name: 'Glow Beauty Studio', city: 'Lahore', phone: '0300-1110001' }), h.makeLead({ business_name: 'Glow Beauty Studio', city: 'Karachi', phone: '0300-1110002', social_profiles: { instagram: null, facebook: null, tiktok: null, linkedin: null, youtube: null, other: null } })]);
  const r = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'strategy', niche_ids: await nicheIds(amman.cookie, 'strategy'), count: 2 } });
  assert.equal(r.body.job.saved_count, 2);
});

test('preserves incomplete data honestly and rejects candidates without any public contact channel or off-target', async () => {
  const { amman } = await h.loginAll();
  h.fake.queueLeads([
    h.makeLead({ phone: null, whatsapp: null, field_verification: { business_name: 'verified', phone: 'unknown', website: 'unknown', address: 'unknown', social_profiles: 'verified', people: 'unknown' }, confidence: 'partially_verified' }),
    h.makeLead({ phone: null, whatsapp: null, social_profiles: { instagram: null, facebook: null, tiktok: null, linkedin: null, youtube: null, other: null } }),
    h.makeLead({ website: 'https://www.fancysalon.pk', website_status: 'has_website', online_booking_status: 'full' }),
  ], { webSearch: false });
  const r = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'strategy', niche_ids: await nicheIds(amman.cookie, 'strategy'), count: 3 } });
  assert.equal(r.body.batch.saved, 1);
  assert.equal(r.body.batch.rejected, 2);
  const { rows } = await h.db.query('SELECT phone, data_status, social_profiles FROM contacts');
  assert.equal(rows[0].phone, null);
  assert.equal(rows[0].data_status, 'needs_verification', 'no web search + no provider => needs verification');
  assert.ok(rows[0].social_profiles.instagram_handle);
  const { rows: rej } = await h.db.query('SELECT reason FROM generation_rejections ORDER BY id');
  assert.deepEqual(rej.map((x) => x.reason), ['no_public_contact_channel', 'has_website_and_online_booking']);
});

test('stops honestly when the source is exhausted instead of fabricating', async () => {
  const { amman } = await h.loginAll();
  await h.db.query("UPDATE system_settings SET value = '2' WHERE key = 'generation_batch_size'");
  h.fake.queueLeads([h.makeLead()]);
  const first = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'strategy', niche_ids: await nicheIds(amman.cookie, 'strategy'), count: 6 } });
  assert.equal(first.body.job.status, 'pending');
  const listId = first.body.list.id;
  let last = first.body.job;
  for (let i = 0; i < 12 && ['pending', 'running'].includes(last.status); i++) {
    h.fake.queueLeads([]);
    const r = await h.request('POST', `/api/lists/${listId}/generate`, { cookie: amman.cookie, body: {} });
    assert.equal(r.status, 200, r.text);
    last = r.body.job;
  }
  assert.equal(last.status, 'exhausted');
  assert.equal(last.saved_count, 1);
  const { rows } = await h.db.query('SELECT count(*) AS n FROM contacts');
  assert.equal(Number(rows[0].n), 1);
  const list = await h.request('GET', `/api/lists/${listId}`, { cookie: amman.cookie });
  assert.equal(list.body.list.generation_progress.status, 'exhausted');
});

test('generation is idempotent per cycle: one list per user/panel; retries continue the same list', async () => {
  const { amman } = await h.loginAll();
  h.fake.queueLeads([h.makeLead()]);
  const a = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'strategy', niche_ids: await nicheIds(amman.cookie, 'strategy'), count: 2 } });
  h.fake.queueLeads([h.makeLead()]);
  const b = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'strategy', niche_ids: await nicheIds(amman.cookie, 'strategy'), count: 2 } });
  assert.equal(a.body.list.id, b.body.list.id);
  assert.equal(b.body.created, false);
  assert.equal(b.body.job.status, 'completed');
  const { rows } = await h.db.query('SELECT count(*) AS n FROM contact_lists');
  assert.equal(Number(rows[0].n), 1);
});

test('clear error when no Claude API key is configured; the job is left retryable', async () => {
  const { amman } = await h.loginAll();
  const saved = config.claude.apiKey;
  config.claude.apiKey = '';
  try {
    const r = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'service', niche_ids: await nicheIds(amman.cookie, 'service'), count: 3 } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'claude_not_configured');
    assert.equal(r.body.error.details.job.status, 'failed');
  } finally { config.claude.apiKey = saved; }
  const test = await h.request('POST', '/api/claude/test', { cookie: amman.cookie });
  assert.equal(test.status, 200);
});

test('per-user API keys are stored encrypted and only the last four characters are returned', async () => {
  const { fizza } = await h.loginAll();
  const r = await h.request('POST', '/api/claude/key', { cookie: fizza.cookie, body: { api_key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.user_key_last4, '7890');
  assert.equal(r.body.active_source, 'user');
  assert.equal(JSON.stringify(r.body).includes('abcdefghij'), false);
  const { rows } = await h.db.query('SELECT encrypted_key FROM user_api_keys');
  assert.match(rows[0].encrypted_key, /^v1\./);
  assert.equal(rows[0].encrypted_key.includes('abcdefghij'), false);
  assert.equal((await h.request('POST', '/api/claude/key', { cookie: fizza.cookie, body: { api_key: 'not-a-key' } })).status, 400);
});

test('owner targeting criteria reach the research prompt, are snapshotted on the list and enforced on candidates', async () => {
  const { shahroz, fizza } = await h.loginAll();
  const set = await h.request('PATCH', '/api/settings/system', { cookie: shahroz.cookie, body: { lead_criteria: { stage: 'startup', founded_from_year: 2026, max_employees: 10, leadership: 'female_preferred' }, target_cities: ['Karachi', 'Islamabad'] } });
  assert.equal(set.status, 200, set.text);
  const denied = await h.request('PATCH', '/api/settings/system', { cookie: fizza.cookie, body: { lead_criteria: { stage: 'any' } } });
  assert.equal(denied.status, 403);
  h.fake.queueLeads([
    h.makeLead({ city: 'Karachi', company_size: 'solo', founded_year: 2026, team_size_estimate: 3, female_led: true, startup_signals: ['newly opened studio'] }),
    h.makeLead({ city: 'Karachi', company_size: 'large', founded_year: 2012, team_size_estimate: 40, female_led: false, startup_signals: [] }),
  ]);
  const r = await h.request('POST', '/api/leads/generate', { cookie: fizza.cookie, body: { contact_type: 'strategy', niche_ids: await nicheIds(fizza.cookie, 'strategy', 1), count: 2 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.list.criteria.stage, 'startup');
  assert.equal(r.body.list.criteria.founded_from_year, 2026);
  assert.equal(r.body.batch.saved, 1, JSON.stringify(r.body.batch));
  assert.equal(r.body.batch.rejected, 1, 'the established business is rejected by the criteria');
  assert.match(r.body.batch.criteria, /started in 2026 or later/);
  const userText = h.fake.calls[0].messages[0].content;
  const text = typeof userText === 'string' ? userText : JSON.stringify(userText);
  assert.match(text, /TARGETING/); assert.match(text, /female-led/i); assert.match(text, /Karachi/);
  const { rows } = await h.db.query('SELECT business_operations, employee_count_estimate FROM contacts');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].business_operations.female_led, true);
  assert.equal(rows[0].business_operations.founded_year, 2026);
  assert.deepEqual(rows[0].business_operations.startup_signals, ['newly opened studio']);
  assert.equal(rows[0].business_operations.criteria_match, 'confirmed');
  const { rows: rej } = await h.db.query('SELECT reason FROM generation_rejections');
  assert.ok(rej.some((x) => x.reason === 'fails_criteria_founded_before'), JSON.stringify(rej));
});

test('lists export as a PDF for their owner and the business owner; the owner can delete never-called contacts', async () => {
  const { amman, fizza, shahroz } = await h.loginAll();
  const a = await h.createListWithContacts(amman.user, 'strategy', 3, 'PdfBiz');
  const b = await h.createListWithContacts(amman.user, 'service', 2, 'PdfSvc');
  const pdf = await fetch(`${h.baseUrl()}/api/export/lists.pdf?ids=${a.listId},${b.listId}&title=Lead%20list%201`, { headers: { Cookie: shahroz.cookie } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString(), '%PDF');
  assert.ok(buf.length > 2000, 'PDF has content');
  const own = await fetch(`${h.baseUrl()}/api/export/lists.pdf?ids=${a.listId}`, { headers: { Cookie: amman.cookie } });
  assert.equal(own.status, 200);
  const other = await fetch(`${h.baseUrl()}/api/export/lists.pdf?ids=${a.listId}`, { headers: { Cookie: fizza.cookie } });
  assert.equal(other.status, 403, 'an employee cannot export another employee\'s list');
  // deletion: owner only, never-called only
  const emp = await h.request('DELETE', `/api/leads/${a.contactIds[0]}`, { cookie: amman.cookie });
  assert.equal(emp.status, 403);
  const del = await h.request('DELETE', `/api/leads/${a.contactIds[0]}`, { cookie: shahroz.cookie });
  assert.equal(del.status, 200, del.text);
  await h.db.query('UPDATE contacts SET call_count = 1 WHERE id = $1', [a.contactIds[1]]);
  const called = await h.request('DELETE', `/api/leads/${a.contactIds[1]}`, { cookie: shahroz.cookie });
  assert.equal(called.status, 409);
  const { rows } = await h.db.query('SELECT count(*) AS n FROM contacts');
  assert.equal(Number(rows[0].n), 4);
  const { rows: logs } = await h.db.query("SELECT details FROM activity_logs WHERE action = 'contact_deleted'");
  assert.equal(logs.length, 1); assert.match(logs[0].details.business_name, /PdfBiz/);
});

test('the owner can create a list for an employee, and continuing a completed list keeps its niches', async () => {
  const { shahroz, amman } = await h.loginAll();
  const ids = await nicheIds(shahroz.cookie, 'service', 2);
  h.fake.queueLeads([h.makeLead({ niche: 'Travel Agencies' })]);
  const r = await h.request('POST', '/api/leads/generate', { cookie: shahroz.cookie, body: { contact_type: 'service', niche_ids: ids, count: 1, for_user_id: amman.user.id } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.list.original_owner_id, amman.user.id);
  assert.equal(r.body.list.current_owner_id, amman.user.id);
  assert.equal(r.body.job.status, 'completed');
  const forbidden = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'service', niche_ids: ids, count: 1, for_user_id: shahroz.user.id } });
  assert.equal(forbidden.status, 403);
  h.fake.queueLeads([h.makeLead({ niche: 'Travel Agencies' })]);
  const more = await h.request('POST', `/api/lists/${r.body.list.id}/generate`, { cookie: shahroz.cookie, body: { count: 2 } });
  assert.equal(more.status, 200, more.text);
  assert.deepEqual(more.body.list.selected_niches.map((n) => n.id).sort(), ids.sort(), 'niches preserved when the completed list is extended');
  assert.equal(more.body.list.target_size, 2);
});

test('when the search engines return nothing the batch pauses instead of failing: job stays pending, no attempt counted', async () => {
  const { amman } = await h.loginAll();
  const ai = require('../server/services/ai.service');
  const { AppError } = require('../server/lib/errors');
  const orig = ai.generateLeadCandidates;
  ai.generateLeadCandidates = async () => { throw new AppError('The search engines returned nothing for this search', 503, 'research_empty'); };
  try {
    const r = await h.request('POST', '/api/leads/generate', { cookie: amman.cookie, body: { contact_type: 'strategy', niche_ids: await nicheIds(amman.cookie, 'strategy', 1), count: 2 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.batch.warnings, ['search_busy']);
    assert.equal(r.body.batch.retry_after_ms, 30000);
    assert.equal(r.body.job.status, 'pending');
    assert.equal(r.body.job.attempts, 0);
    assert.equal(r.body.job.last_error, null);
    assert.equal(r.body.job.locked, false, 'lock released so the next call can run');
  } finally { ai.generateLeadCandidates = orig; }
  h.fake.queueLeads([h.makeLead()]);
  const again = await h.request('POST', `/api/lists/${(await h.request('GET', '/api/lists', { cookie: amman.cookie })).body.items[0].id}/generate`, { cookie: amman.cookie, body: {} });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.batch.saved, 1, 'generation continues normally afterwards');
});
