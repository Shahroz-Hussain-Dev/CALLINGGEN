'use strict';
/**
 * Batch lead generation. Each call to runBatch performs ONE controlled batch
 * (a single Claude research request + verification + duplicate checks + saves)
 * and returns real progress. The frontend (or the cron) calls it repeatedly
 * until the job completes or the source is exhausted.
 */
const db = require('../db');
const config = require('../config');
const logger = require('../logger');
const { NotFoundError, ForbiddenError, AppError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');
const norm = require('../lib/normalize');
const { randomToken } = require('../lib/crypto');
const activity = require('./activity.service');
const settings = require('./settings.service');
const ai = require('./ai.service');
const duplicates = require('./duplicates.service');
const search = require('./search');
const listsService = require('./lists.service');

const LOCK_TTL_MS = 2 * 60 * 1000;

async function getJob(jobId, client) {
  const { rows } = await db.q(client)('SELECT g.*, l.current_owner_id, l.original_owner_id, l.target_size, l.selected_niches, l.list_status FROM generation_jobs g JOIN contact_lists l ON l.id = g.list_id WHERE g.id = $1', [jobId]);
  return rows[0] || null;
}

function jobView(job) {
  if (!job) return null;
  return {
    id: job.id, list_id: job.list_id, status: job.status, requested_count: job.requested_count, saved_count: job.saved_count,
    duplicate_count: job.duplicate_count, rejected_count: job.rejected_count, needs_verification_count: job.needs_verification_count,
    verified_count: job.verified_count, attempts: job.attempts, empty_attempts: job.empty_attempts, last_error: job.last_error, last_batch_at: job.last_batch_at,
    locked: !!(job.locked_at && Date.now() - new Date(job.locked_at).getTime() < LOCK_TTL_MS),
  };
}

/** Normalizes and validates a raw candidate from Claude. Returns {ok, contact, reason}. */
function prepareCandidate(raw, { panel, nicheRows, city }) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid_candidate' };
  const businessName = String(raw.business_name || '').trim();
  if (businessName.length < 2) return { ok: false, reason: 'missing_business_name' };
  const normalizedName = norm.normalizeBusinessName(businessName);
  if (!normalizedName) return { ok: false, reason: 'missing_business_name' };

  const social = {};
  const handles = {};
  const sp = raw.social_profiles && typeof raw.social_profiles === 'object' ? raw.social_profiles : {};
  for (const k of ['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube', 'other']) {
    if (sp[k]) {
      social[k] = String(sp[k]).trim();
      const c = norm.classifyUrl(social[k]);
      if (c.kind === 'social' && c.handle && ['instagram', 'facebook', 'tiktok'].includes(k)) { handles[k] = c.handle; social[`${k}_handle`] = c.handle; }
    }
  }
  // A "website" that is actually a social page is moved to social profiles.
  let website = raw.website ? String(raw.website).trim() : null;
  let websiteAvailable = null;
  if (website) {
    const c = norm.classifyUrl(website);
    if (c.kind === 'social') { if (c.platform && !social[c.platform]) social[c.platform] = c.url; website = null; }
    else if (c.kind === 'invalid') website = null;
  }
  const domain = norm.normalizeDomain(website);
  if (domain) websiteAvailable = true;
  else if (raw.website_status === 'no_website') websiteAvailable = false;
  else websiteAvailable = null;

  if (panel === 'strategy' && websiteAvailable === true && (raw.online_booking_status === 'full')) return { ok: false, reason: 'has_website_and_online_booking' };

  const phone = raw.phone ? String(raw.phone).trim() : null;
  const whatsapp = raw.whatsapp ? String(raw.whatsapp).trim() : null;
  const normalizedPhone = norm.normalizePhone(phone) || norm.normalizePhone(whatsapp);
  if (whatsapp) social.whatsapp = whatsapp;
  const hasChannel = !!(normalizedPhone || Object.keys(handles).length || social.facebook || social.instagram || social.linkedin || social.tiktok);
  if (!hasChannel) return { ok: false, reason: 'no_public_contact_channel' };

  const nicheName = String(raw.niche || '').trim();
  const nicheMatch = nicheRows.find((n) => n.name.toLowerCase() === nicheName.toLowerCase()) || nicheRows.find((n) => nicheName && (n.name.toLowerCase().includes(nicheName.toLowerCase()) || nicheName.toLowerCase().includes(n.name.toLowerCase()))) || nicheRows[0];
  const cityName = norm.normalizeCity(raw.city) || norm.normalizeCity(city);
  const people = (arr) => (Array.isArray(arr) ? arr.filter((p) => p && p.name).map((p) => ({ name: String(p.name).trim(), designation: p.designation ? String(p.designation) : null, source_url: p.source_url || null, contact: p.contact || null })) : []);
  const strs = (arr) => (Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
  const fv = raw.field_verification && typeof raw.field_verification === 'object' ? raw.field_verification : {};

  const contact = {
    business_name: businessName,
    normalized_business_name: normalizedName,
    industry: nicheMatch ? (nicheMatch.category || (panel === 'strategy' ? 'Women-focused appointment businesses' : 'Service businesses')) : null,
    niche: nicheMatch ? nicheMatch.name : (nicheName || null),
    niche_id: nicheMatch ? nicheMatch.id : null,
    business_description: raw.business_description ? String(raw.business_description).slice(0, 4000) : null,
    website: website,
    normalized_website_domain: domain,
    website_available: websiteAvailable,
    phone: phone || whatsapp || null,
    normalized_phone: normalizedPhone,
    public_email: norm.normalizeEmail(raw.public_email),
    address: raw.address ? String(raw.address).slice(0, 500) : null,
    city: cityName,
    country: 'Pakistan',
    social_profiles: social,
    company_size: raw.company_size && raw.company_size !== 'unknown' ? raw.company_size : null,
    employee_count_estimate: raw.employee_count_estimate ? String(raw.employee_count_estimate).slice(0, 60) : null,
    business_locations: strs(raw.business_locations),
    departments: strs(raw.departments),
    management_data: { owners: people(raw.owners), senior_management: people(raw.management) },
    decision_makers: people(raw.decision_makers),
    contact_type: panel,
    business_operations: panel === 'strategy'
      ? { services: strs(raw.services), current_booking_method: raw.current_booking_method || null, online_booking_status: raw.online_booking_status || 'unknown', website_status: raw.website_status || 'unknown', booking_problems: raw.booking_problems || null, website_opportunity: raw.website_opportunity || null, booking_automation_opportunity: raw.booking_automation_opportunity || null, social_presence: Object.keys(social).filter((k) => !k.endsWith('_handle')) }
      : { services: strs(raw.services), existing_software: strs(raw.existing_software), operational_challenges: strs(raw.operational_challenges), repetitive_processes: strs(raw.repetitive_processes), relevant_latechs_services: strs(raw.relevant_latechs_services) },
    automation_opportunities: Array.isArray(raw.automation_opportunities) ? raw.automation_opportunities.filter((o) => o && o.process).map((o) => ({ process: String(o.process), opportunity: String(o.opportunity || ''), latechs_service: String(o.latechs_service || '') })) : [],
    field_verification: { business_name: fv.business_name || 'unknown', phone: fv.phone || 'unknown', website: fv.website || 'unknown', address: fv.address || 'unknown', social_profiles: fv.social_profiles || 'unknown', people: fv.people || 'unknown' },
    source_urls: strs(raw.source_urls).slice(0, 25),
    claimed_confidence: raw.confidence || 'needs_verification',
    qualification_notes: raw.qualification_notes || null,
    handles,
  };
  return { ok: true, contact };
}

/** Determines the final data status from Claude's claims, web-search usage and the external provider. */
function computeDataStatus(contact, { webSearchUsed, providerResult }) {
  const fv = contact.field_verification;
  if (providerResult && providerResult.found) {
    if (providerResult.phone && contact.normalized_phone && norm.normalizePhone(providerResult.phone) === contact.normalized_phone) return 'verified';
    if (providerResult.phone || providerResult.address) return 'partially_verified';
  }
  if (webSearchUsed && contact.source_urls.length) {
    const verifiedCount = ['business_name', 'phone', 'website', 'address', 'social_profiles'].filter((k) => fv[k] === 'verified').length;
    if (fv.business_name === 'verified' && fv.phone === 'verified' && verifiedCount >= 3) return 'verified';
    if (verifiedCount >= 2) return 'partially_verified';
    if (contact.claimed_confidence === 'estimated') return 'estimated';
    return 'needs_verification';
  }
  return contact.claimed_confidence === 'estimated' ? 'estimated' : 'needs_verification';
}

function pickCityAndNiche(job, list, cities) {
  const nicheRows = Array.isArray(list.selected_niches) ? list.selected_niches : [];
  const attempt = job.attempts || 0;
  const niche = nicheRows.length ? nicheRows[attempt % nicheRows.length] : null;
  const city = cities.length ? cities[Math.floor(attempt / Math.max(1, nicheRows.length)) % cities.length] : 'Lahore';
  return { niche, city };
}

/** Runs a single batch for a job. Returns the updated job view plus batch summary. */
async function runBatch(user, jobId, { forceUnlock = false, timeBudgetMs } = {}) {
  const id = v.uuid(jobId, { field: 'job_id' });
  const all = await settings.getAll();
  const batchSize = Math.max(1, Math.min(15, Number(all.generation_batch_size) || config.generation.batchSize));
  const lockToken = randomToken(8);

  // ---- acquire lock -------------------------------------------------------
  const job = await db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT g.*, l.current_owner_id, l.original_owner_id, l.target_size, l.selected_niches FROM generation_jobs g JOIN contact_lists l ON l.id = g.list_id WHERE g.id = $1 FOR UPDATE', [id]);
    const j = rows[0];
    if (!j) throw new NotFoundError('Generation job not found');
    if (user.role !== 'owner' && j.current_owner_id !== user.id && j.original_owner_id !== user.id) throw new ForbiddenError('This generation job is not yours');
    if (['completed', 'cancelled'].includes(j.status)) return j;
    const lockedRecently = j.locked_at && Date.now() - new Date(j.locked_at).getTime() < LOCK_TTL_MS;
    if (lockedRecently && !forceUnlock) throw new ConflictError('A generation batch is already running for this list. Please wait for it to finish.', { code: 'generation_busy' });
    if (j.status === 'exhausted' || j.status === 'failed') {
      // an explicit retry resets exhaustion counters
      await client.query("UPDATE generation_jobs SET status = 'running', empty_attempts = 0, last_error = NULL WHERE id = $1", [id]);
      j.empty_attempts = 0;
    }
    await client.query("UPDATE generation_jobs SET locked_at = now(), lock_token = $2, status = 'running' WHERE id = $1", [id, lockToken]);
    return { ...j, status: 'running' };
  });
  if (['completed', 'cancelled'].includes(job.status)) return { job: jobView(job), batch: null };

  const list = await listsService.getById(job.list_id);
  const remaining = Math.max(0, job.requested_count - Number(list.contact_count));
  if (remaining <= 0) {
    await finishJob(id, 'completed', null);
    return { job: jobView(await getJob(id)), batch: null };
  }
  const count = Math.min(batchSize, remaining);
  const { niche, city } = pickCityAndNiche(job, list, all.target_cities || []);
  const nicheRows = Array.isArray(list.selected_niches) ? list.selected_niches : [];
  const nicheNames = niche ? [niche.name] : nicheRows.map((n) => n.name);

  // Exclusions: businesses already known in this niche/city + rejected candidates for this job
  const { rows: known } = await db.query(
    `SELECT business_name FROM contacts WHERE (lower(city) = lower($1) OR $1 IS NULL) AND (niche = ANY($2::text[]) OR contact_type = $3) ORDER BY created_at DESC LIMIT 120`,
    [city, nicheNames, job.contact_type],
  );
  const { rows: rejected } = await db.query('SELECT business_name FROM generation_rejections WHERE job_id = $1 ORDER BY created_at DESC LIMIT 60', [id]);
  const excludeNames = [...new Set([...known.map((r) => r.business_name), ...rejected.map((r) => r.business_name)])];

  const summary = { requested: count, received: 0, saved: 0, duplicates: 0, rejected: 0, needs_verification: 0, verified: 0, niche: nicheNames.join(', '), city, web_search_used: false, search_notes: '', model: null, provider: ai.activeName(), errors: [] };
  let generated;
  try {
    generated = await ai.generateLeadCandidates({ userId: user.role === 'owner' && job.current_owner_id !== user.id ? job.current_owner_id : user.id, panel: job.contact_type, niches: nicheNames, city, count, excludeNames, ...(timeBudgetMs ? { timeBudgetMs } : {}) });
  } catch (err) {
    const mapped = ai.mapError(err);
    logger.warn('Lead generation batch failed', { jobId: id, code: mapped.code, message: mapped.message });
    await db.query("UPDATE generation_jobs SET status = 'failed', last_error = $2, attempts = attempts + 1, last_batch_at = now(), locked_at = NULL, lock_token = NULL WHERE id = $1", [id, `${mapped.code}: ${mapped.message}`.slice(0, 500)]);
    await syncListProgress(job.list_id);
    await activity.log('generation_failed', { userId: user.id, listId: job.list_id, details: { code: mapped.code, message: mapped.message.slice(0, 200) } });
    const e = new AppError(mapped.message, mapped.status, mapped.code); e.expose = true; e.details = { job: jobView(await getJob(id)) };
    throw e;
  }
  summary.received = generated.leads.length + ((generated.rejected || []).length);
  summary.web_search_used = generated.webSearchUsed;
  summary.model = generated.model || null;
  summary.warnings = generated.warnings || [];
  summary.research_mode = generated.researchMode || null;
  summary.sources = (generated.sources || []).length;
  for (const rj of generated.rejected || []) {
    summary.rejected++;
    await db.query('INSERT INTO generation_rejections (job_id, list_id, business_name, normalized_name, reason, details) VALUES ($1, $2, $3, $4, $5, $6)', [id, job.list_id, String(rj.business_name || 'unknown').slice(0, 200), null, rj.reason || 'not_in_evidence', JSON.stringify({ city, stage: 'evidence_verification' })]);
  }
  summary.search_notes = String(generated.searchNotes || '').slice(0, 1000);
  const provider = search.getProvider();

  for (const raw of generated.leads) {
    if (summary.saved >= count) break;
    const prepared = prepareCandidate(raw, { panel: job.contact_type, nicheRows, city });
    if (!prepared.ok) {
      summary.rejected++;
      await db.query('INSERT INTO generation_rejections (job_id, list_id, business_name, normalized_name, reason, details) VALUES ($1, $2, $3, $4, $5, $6)', [id, job.list_id, String((raw && raw.business_name) || 'unknown').slice(0, 200), null, prepared.reason, JSON.stringify({ city })]);
      continue;
    }
    const c = prepared.contact;
    let providerResult = null;
    if (provider.enabled()) providerResult = await provider.lookupBusiness({ business_name: c.business_name, city: c.city, phone: c.phone });
    if (providerResult && providerResult.found) {
      if (!c.normalized_phone && providerResult.phone) { c.phone = providerResult.phone; c.normalized_phone = norm.normalizePhone(providerResult.phone); c.field_verification.phone = 'verified'; }
      if (!c.website && providerResult.website) { c.website = providerResult.website; c.normalized_website_domain = providerResult.website_domain; c.website_available = true; c.field_verification.website = 'verified'; }
      if (!c.address && providerResult.address) { c.address = providerResult.address; c.field_verification.address = 'verified'; }
      if (providerResult.source_url) c.source_urls.push(providerResult.source_url);
      c.field_verification.business_name = 'verified';
      c.provider_verification = { provider: provider.name, rating: providerResult.rating, reviews: providerResult.reviews, matched_title: providerResult.title, score: providerResult.score };
    }
    const dataStatus = computeDataStatus(c, { webSearchUsed: generated.webSearchUsed, providerResult });

    try {
      const outcome = await db.withTransaction(async (client) => {
        const dup = await duplicates.findDuplicate({ normalized_business_name: c.normalized_business_name, normalized_phone: c.normalized_phone, normalized_website_domain: c.normalized_website_domain, city: c.city, handles: c.handles }, client);
        if (dup) {
          await client.query('INSERT INTO generation_rejections (job_id, list_id, business_name, normalized_name, reason, matched_contact_id, details) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, job.list_id, c.business_name, c.normalized_business_name, 'duplicate', dup.contact.id, JSON.stringify({ match_reason: dup.reason, score: dup.score, matched_name: dup.contact.business_name })]);
          await activity.log('lead_rejected_duplicate', { userId: user.id, listId: job.list_id, contactId: dup.contact.id, details: { candidate: c.business_name, reason: dup.reason, score: Number(dup.score.toFixed(2)) } }, client);
          return 'duplicate';
        }
        const { rows: posRows } = await client.query('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM list_contacts WHERE list_id = $1', [job.list_id]);
        const { rows } = await client.query(
          `INSERT INTO contacts (business_name, normalized_business_name, industry, niche, niche_id, business_description, website, normalized_website_domain, website_available,
             phone, normalized_phone, public_email, address, city, country, social_profiles, company_size, employee_count_estimate, business_locations, departments,
             management_data, decision_makers, contact_type, contact_list_id, current_owner_id, original_owner_id, business_operations, automation_opportunities,
             data_status, field_verification, source_urls, generation_source, generation_timestamp, generation_job_id, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,now(),$33,$34)
           ON CONFLICT DO NOTHING RETURNING id`,
          [c.business_name, c.normalized_business_name, c.industry, c.niche, c.niche_id, c.business_description, c.website, c.normalized_website_domain, c.website_available,
            c.phone, c.normalized_phone, c.public_email, c.address, c.city, c.country, JSON.stringify(c.social_profiles), c.company_size, c.employee_count_estimate, JSON.stringify(c.business_locations), JSON.stringify(c.departments),
            JSON.stringify(c.management_data), JSON.stringify(c.decision_makers), job.contact_type, job.list_id, job.current_owner_id, job.original_owner_id, JSON.stringify({ ...c.business_operations, provider_verification: c.provider_verification || null }), JSON.stringify(c.automation_opportunities),
            dataStatus, JSON.stringify(c.field_verification), JSON.stringify([...new Set(c.source_urls)]), `${ai.activeName()}${generated.webSearchUsed ? '+web_search' : ''}`, id, c.qualification_notes ? `Qualification: ${c.qualification_notes}` : null],
        );
        if (!rows[0]) {
          await client.query('INSERT INTO generation_rejections (job_id, list_id, business_name, normalized_name, reason, details) VALUES ($1, $2, $3, $4, $5, $6)', [id, job.list_id, c.business_name, c.normalized_business_name, 'duplicate', JSON.stringify({ match_reason: 'unique_index' })]);
          return 'duplicate';
        }
        await client.query('INSERT INTO list_contacts (list_id, contact_id, position) VALUES ($1, $2, $3)', [job.list_id, rows[0].id, posRows[0].pos]);
        await activity.log('lead_generated', { userId: user.id, listId: job.list_id, contactId: rows[0].id, details: { business_name: c.business_name, city: c.city, niche: c.niche, data_status: dataStatus } }, client);
        return dataStatus;
      });
      if (outcome === 'duplicate') summary.duplicates++;
      else { summary.saved++; if (outcome === 'needs_verification' || outcome === 'estimated') summary.needs_verification++; if (outcome === 'verified') summary.verified++; }
    } catch (err) {
      if (err && err.code === '23505') { summary.duplicates++; continue; }
      logger.error('Failed to save candidate', { error: err.message, business: c.business_name });
      summary.rejected++;
      summary.errors.push(err.message);
    }
  }

  // ---- update counters -----------------------------------------------------
  const emptyIncrement = summary.saved === 0 ? 1 : 0;
  const { rows: cntRows } = await db.query('SELECT count(*) AS n FROM list_contacts WHERE list_id = $1', [job.list_id]);
  const have = Number(cntRows[0].n);
  let newStatus = 'pending';
  const emptyAttempts = (job.empty_attempts || 0) + emptyIncrement;
  const nicheCount = Math.max(1, nicheRows.length);
  const cityCount = Math.max(1, (all.target_cities || []).length);
  const maxEmpty = Math.min(config.generation.maxEmptyAttempts * 2, Math.max(config.generation.maxEmptyAttempts, nicheCount * Math.min(cityCount, 3)));
  if (have >= job.requested_count) newStatus = 'completed';
  else if (emptyAttempts >= maxEmpty) newStatus = 'exhausted';
  await db.query(
    `UPDATE generation_jobs SET saved_count = $2, duplicate_count = duplicate_count + $3, rejected_count = rejected_count + $4, needs_verification_count = needs_verification_count + $5,
       verified_count = verified_count + $6, attempts = attempts + 1, empty_attempts = $7, status = $8, last_error = NULL, last_batch_at = now(), locked_at = NULL, lock_token = NULL WHERE id = $1`,
    [id, have, summary.duplicates, summary.rejected, summary.needs_verification, summary.verified, emptyAttempts, newStatus],
  );
  await syncListProgress(job.list_id);
  await activity.log('generation_batch', { userId: user.id, listId: job.list_id, details: { ...summary, errors: undefined, status: newStatus, usage: generated.usage, report_excerpt: generated.report ? String(generated.report).slice(0, 4000) : undefined } });
  if (newStatus === 'exhausted') await activity.log('generation_exhausted', { userId: user.id, listId: job.list_id, details: { have, requested: job.requested_count } });
  return { job: jobView(await getJob(id)), batch: summary };
}

async function finishJob(jobId, status, error) {
  await db.query('UPDATE generation_jobs SET status = $2, last_error = $3, locked_at = NULL, lock_token = NULL WHERE id = $1', [jobId, status, error]);
  const job = await getJob(jobId);
  if (job) await syncListProgress(job.list_id);
}

/** Mirrors job counters into contact_lists.generation_progress and flips list_status when done. */
async function syncListProgress(listId) {
  const { rows } = await db.query('SELECT * FROM generation_jobs WHERE list_id = $1 ORDER BY created_at DESC LIMIT 1', [listId]);
  const j = rows[0];
  const { rows: cnt } = await db.query('SELECT count(*) AS n FROM list_contacts WHERE list_id = $1', [listId]);
  const have = Number(cnt[0].n);
  const progress = j ? { target: j.requested_count, saved: have, duplicates: j.duplicate_count, rejected: j.rejected_count, needs_verification: j.needs_verification_count, verified: j.verified_count, attempts: j.attempts, status: j.status, last_error: j.last_error, last_batch_at: j.last_batch_at } : { target: 0, saved: have, status: 'none' };
  const listStatus = !j || ['completed', 'cancelled', 'exhausted', 'failed'].includes(j.status) ? 'active' : 'generating';
  await db.query("UPDATE contact_lists SET generation_progress = $2, list_status = CASE WHEN list_status IN ('generating','active') THEN $3 ELSE list_status END WHERE id = $1", [listId, JSON.stringify(progress), listStatus]);
}

async function cancel(user, jobId) {
  const job = await getJob(v.uuid(jobId, { field: 'job_id' }));
  if (!job) throw new NotFoundError('Generation job not found');
  if (user.role !== 'owner' && job.current_owner_id !== user.id) throw new ForbiddenError();
  await finishJob(job.id, 'cancelled', null);
  await activity.log('generation_cancelled', { userId: user.id, listId: job.list_id });
  return jobView(await getJob(job.id));
}

async function status(user, jobId) {
  const job = await getJob(v.uuid(jobId, { field: 'job_id' }));
  if (!job) throw new NotFoundError('Generation job not found');
  if (user.role !== 'owner' && job.current_owner_id !== user.id && job.original_owner_id !== user.id) throw new ForbiddenError();
  const { rows } = await db.query('SELECT business_name, reason, details, created_at FROM generation_rejections WHERE job_id = $1 ORDER BY created_at DESC LIMIT 30', [job.id]);
  return { job: jobView(job), recent_rejections: rows };
}

/** Cron helper: continues pending jobs (one batch each) within a time budget. */
async function continuePending({ timeBudgetMs = config.generation.timeBudgetMs, actor } = {}) {
  const started = Date.now();
  const { rows } = await db.query(
    `SELECT g.id, u.id AS user_id, u.username, u.display_name, u.role FROM generation_jobs g JOIN contact_lists l ON l.id = g.list_id JOIN users u ON u.id = l.current_owner_id
      WHERE g.status IN ('pending', 'running') AND (g.locked_at IS NULL OR g.locked_at < now() - interval '2 minutes') ORDER BY g.updated_at ASC LIMIT 12`,
  );
  const results = [];
  for (const r of rows) {
    if (Date.now() - started > timeBudgetMs) break;
    try {
      const res = await runBatch(actor || { id: r.user_id, role: r.role, display_name: r.display_name }, r.id, { timeBudgetMs: Math.max(60000, timeBudgetMs - (Date.now() - started)) });
      results.push({ job_id: r.id, status: res.job.status, saved: res.batch ? res.batch.saved : 0 });
    } catch (err) {
      results.push({ job_id: r.id, error: err.code || err.message });
    }
  }
  return results;
}

module.exports = { runBatch, cancel, status, getJob, jobView, prepareCandidate, computeDataStatus, continuePending, syncListProgress };
