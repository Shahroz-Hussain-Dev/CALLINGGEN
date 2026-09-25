import { api } from '../api.js';
import { el, esc, html, raw, join, toast, badge, panelBadge, progressBar, tileHtml, num, emptyState, setBusy, fmtDate, timeAgo, statusBadge, interestBadge, dataStatusBadge, websiteBadge, listToText, telHref, waHref, confirmDialog, promptDialog, STATUS_LABELS, PANEL_LABEL } from '../ui.js';
import { state } from '../app.js';
import { contactTableHtml, bindRowLinks, openRecordCallModal, openFollowUpModal, openMeetingModal, contactActionsHtml, bindContactActions } from './shared.js';

const PANEL_INFO = {
  strategy: {
    title: 'Strategy Leads', icon: '✦', tagline: 'Pakistani appointment-based businesses without a website or online booking. Approach as a customer first, understand the booking process, then introduce LATechS.',
    steps: ['Identify the business (confirm no official website)', 'Initial customer inquiry — ask how bookings work', 'Identify the need — current process and its problems', 'Introduce LATechS websites & booking systems (only after step 2)', 'Record the real interest level'],
    goal: 'Business problem → Website / Booking opportunity → LATechS meeting',
  },
  service: {
    title: 'Service Sales Leads', icon: '⚙', tagline: 'Pakistani non-technical businesses with repetitive manual work. Reach the decision-maker, book a meeting, and present a customized automation proposal.',
    steps: ['Identify the business and its repetitive processes', 'Initial contact — reach a decision-maker', 'Book the meeting and save it immediately', 'Prepare with Claude: business profile & automation opportunities', 'Present the proposal and record the meeting outcome'],
    goal: 'Business process → Repetitive work → Automation opportunity → Decision-maker → Meeting → Proposal',
  },
};

export async function renderPanel(root, type) {
  const info = PANEL_INFO[type];
  let alive = true;
  let generating = false;
  const view = { lists: [], niches: [], selectedListId: null, claude: null, settings: null, filters: { status: '', search: '' }, page: 0 };

  const [listsRes, nichesRes, claudeRes, settingsRes] = await Promise.all([
    api.get(`/api/lists?contact_type=${type}`), api.get(`/api/niches?panel=${type}`), api.get('/api/ai/status').catch(() => null), api.get('/api/settings').catch(() => null),
  ]);
  view.lists = listsRes.items; view.niches = nichesRes.items; view.claude = claudeRes; view.settings = settingsRes;
  const current = view.lists.find((l) => l.is_current_cycle && l.original_owner_id === state.user.id) || view.lists[0];
  view.selectedListId = current ? current.id : null;

  root.innerHTML = html`
    <div class="panel-banner ${type} mb-3"><div class="flex-between"><div><h1>${info.icon} ${info.title} ${raw(panelBadge(type))}</h1><p class="muted" style="max-width:820px">${info.tagline}</p><div class="small"><b>Goal:</b> ${info.goal}</div></div></div>
      <details class="acc mt-2"><summary>How this panel works (step by step)</summary><div class="acc-body"><div class="steps mt-2">${join(info.steps, (s) => html`<div class="step ${type}"><div>${s}</div></div>`)}</div></div></details>
    </div>
    ${view.claude && view.claude.active_source === 'none' ? raw(`<div class="warn-box mb-3">No ${esc(view.claude.provider_label || 'AI')} API key is configured, so contact generation is unavailable. Add your key in <a href="#/settings/claude">Settings → AI configuration</a> or ask the administrator to set the server key.</div>`) : raw('')}
    <div class="grid split" id="topGrid">
      <div class="card" id="listsCard"></div>
      <div class="card" id="genCard"></div>
    </div>
    <div id="workflow" class="mt-3"></div>
    <div id="contactsSection" class="mt-3"></div>`;

  const listsCard = root.querySelector('#listsCard');
  const genCard = root.querySelector('#genCard');
  const workflow = root.querySelector('#workflow');
  const contactsSection = root.querySelector('#contactsSection');

  async function reloadLists() {
    const r = await api.get(`/api/lists?contact_type=${type}`);
    view.lists = r.items;
    if (!view.lists.find((l) => l.id === view.selectedListId)) view.selectedListId = view.lists[0] ? view.lists[0].id : null;
    renderLists();
  }

  function renderLists() {
    const mine = view.lists;
    listsCard.innerHTML = html`<div class="card-head"><h2>Your ${info.title.toLowerCase()} lists</h2><span class="small muted">${mine.length} active</span></div>
      ${mine.length ? html`<div class="col">${join(mine, (l) => {
        const s = l.stats; const gp = l.generation_progress || {};
        return html`<div class="list-card ${l.id === view.selectedListId ? 'selected' : ''}" data-list="${l.id}">
          <div class="flex-between"><div><b>${l.list_code}</b> ${l.is_current_cycle && l.original_owner_id === state.user.id ? raw(badge('Current cycle · yours', 'primary')) : l.original_owner_id !== state.user.id ? raw(badge(`Received from ${l.original_owner_name}`, 'info')) : raw(badge(`Cycle ${l.cycle_number}`, 'neutral'))} ${l.list_status === 'generating' ? raw(badge(`generating ${gp.saved || l.contact_count}/${gp.target || l.target_size}`, 'warning')) : raw('')}</div><span class="small muted">rotates ${l.rotation_date ? fmtDate(l.rotation_date, { day: '2-digit', month: 'short' }) : '—'}</span></div>
          <div class="progress-row mt-1"><span>${s.processed_this_cycle}/${s.total} processed</span>${raw(progressBar(s.processed_this_cycle, s.total || 1, type))}<span>${s.remaining} left</span></div>
          <div class="small muted mt-1">${s.interested} interested · ${s.meetings_booked} meetings · ${s.follow_ups_pending} follow-ups · rotation ${l.rotation_count}× · original owner ${l.original_owner_name}</div>
        </div>`; })}</div>` : raw(emptyState('📋', 'No list for this panel yet', 'Generate contacts to create your list for the current cycle.'))}`;
    listsCard.querySelectorAll('[data-list]').forEach((c) => c.addEventListener('click', () => { view.selectedListId = c.dataset.list; view.page = 0; renderLists(); renderWorkflow(); renderContacts(); }));
  }

  // ---------------- generation ----------------
  function selectedNicheIds() { return [...genCard.querySelectorAll('input[name=niche]:checked')].map((i) => i.value); }
  function renderGen(job, batch, error) {
    const currentList = view.lists.find((l) => l.is_current_cycle && l.original_owner_id === state.user.id);
    const saved = view.settings ? (type === 'strategy' ? view.settings.user_settings.selected_strategy_niches : view.settings.user_settings.selected_service_niches) || [] : [];
    const groups = {};
    for (const n of view.niches) { const g = n.category || 'Niches'; (groups[g] = groups[g] || []).push(n); }
    const have = currentList ? Number(currentList.contact_count) : 0;
    const target = currentList ? currentList.target_size : 50;
    const remaining = Math.max(0, target - have);
    const jobStatus = job ? job.status : (currentList && currentList.generation_job ? currentList.generation_job.status : null);
    const j = job || (currentList ? currentList.generation_job : null);
    const canGenerate = view.claude && view.claude.active_source !== 'none';
    genCard.innerHTML = html`<div class="card-head"><h2>Generate contacts</h2>${currentList ? raw(`<span class="small muted">${have}/${target} in ${esc(currentList.list_code)}</span>`) : raw('<span class="small muted">creates this cycle\'s list</span>')}</div>
      ${!generating ? html`<div class="small muted mb-2">Select one or more niches (saved preferences are pre-selected), choose how many contacts, then generate. ${view.claude ? view.claude.provider_label || 'The AI' : 'The AI'} researches real Pakistani businesses${view.claude && view.claude.web_search ? ` with ${view.claude.search_label || 'live web search'}` : ''}, every candidate is verified where possible, and duplicates across the whole database are rejected automatically.</div>
        <div style="max-height:260px;overflow:auto;padding-right:4px">${join(Object.entries(groups), ([g, items]) => html`${Object.keys(groups).length > 1 ? html`<h4 class="mt-2">${g}</h4>` : raw('')}<div class="chips mb-2">${join(items, (n) => html`<label class="chip ${type} ${saved.includes(n.id) ? 'on' : ''}"><input type="checkbox" name="niche" value="${n.id}" ${saved.includes(n.id) ? 'checked' : ''}>${n.name}</label>`)}</div>`)}</div>
        <div class="flex flex-wrap mt-2"><label class="field"><span>Number of contacts (max 50)</span><input type="number" name="count" min="1" max="50" value="${currentList ? target : 50}" style="width:120px"></label><div class="grow"></div>
          <button class="btn ${type}" id="genBtn" ${!canGenerate ? 'disabled' : ''}>${currentList && have > 0 && remaining > 0 ? `Continue generating (${remaining} more)` : currentList && remaining === 0 ? 'List is full' : 'Generate Contacts'}</button></div>
        ${jobStatus === 'exhausted' ? html`<div class="warn-box mt-2 small">The source appears exhausted for the selected niches/cities: ${have}/${target} valid unique contacts were generated. Nothing was fabricated to fill the remaining slots. You can retry (the search rotates niches and cities), pick other niches, or ask the administrator to add cities.</div>` : raw('')}
        ${jobStatus === 'failed' && j && j.last_error ? html`<div class="error-box mt-2 small">Last attempt failed: ${j.last_error}. Click generate to retry.</div>` : raw('')}` : raw('')}
      <div id="genProgress" class="mt-2"></div>`;
    genCard.querySelectorAll('.chip input').forEach((i) => i.addEventListener('change', () => i.parentElement.classList.toggle('on', i.checked)));
    const btn = genCard.querySelector('#genBtn');
    if (btn) btn.addEventListener('click', startGeneration);
    renderGenProgress(job, batch, error);
  }

  function renderGenProgress(job, batch, error) {
    const box = genCard.querySelector('#genProgress');
    if (!box) return;
    if (!job && !error) { box.innerHTML = ''; return; }
    const j = job || {};
    const target = j.requested_count || 0; const saved = j.saved_count || 0;
    const running = generating;
    box.innerHTML = html`<div class="card tight" style="background:var(--bg)">
      <div class="flex-between"><b>${running ? raw('<span class="spinner"></span> ') : raw('')}${running ? `Generating ${saved} / ${target}` : j.status === 'completed' ? `Completed: ${saved} / ${target}` : j.status === 'exhausted' ? `Source exhausted: ${saved} / ${target}` : j.status === 'cancelled' ? `Cancelled at ${saved} / ${target}` : j.status === 'failed' ? `Failed at ${saved} / ${target}` : `${saved} / ${target}`}</b>${running ? raw('<button class="btn xs danger" id="genCancel">Stop</button>') : raw('')}</div>
      <div class="mt-1">${raw(progressBar(saved, target || 1, type))}</div>
      <div class="grid grid-4 mt-2 small"><div><span class="muted">Saved</span><br><b>${num(saved)}</b></div><div><span class="muted">Duplicates rejected</span><br><b>${num(j.duplicate_count || 0)}</b></div><div><span class="muted">Needs verification</span><br><b>${num(j.needs_verification_count || 0)}</b></div><div><span class="muted">Rejected / invalid</span><br><b>${num(j.rejected_count || 0)}</b></div></div>
      ${batch && batch.warnings && batch.warnings.includes('grounding_unavailable') ? raw('<div class="warn-box small mt-2">Web research (Google Search grounding) is not available on the current Gemini API key, so these contacts come from the model\'s own knowledge and are marked <b>Needs Verification</b>. Enable billing for the Gemini API key in Google AI Studio to unlock live web research and the Pro model.</div>') : raw('')}
      ${batch ? html`<div class="small muted mt-2">Last batch: ${batch.niche} · ${batch.city} · received ${batch.received}, saved ${batch.saved}, duplicates ${batch.duplicates}, rejected ${batch.rejected}${batch.web_search_used ? (batch.research_mode === 'evidence' ? ` · free web research (${batch.sources || 0} sources)` : ' · web research used') : ' · no web research'}${batch.model ? ` · ${batch.model}` : ''}${batch.search_notes ? raw(`<details class="mt-1"><summary class="small">Research notes</summary><div class="note-block mt-1">${esc(batch.search_notes)}</div></details>`) : raw('')}</div>` : raw('')}
      ${error ? html`<div class="error-box mt-2 small">${error}</div>` : raw('')}
      ${j.attempts ? html`<div class="tiny faint mt-1">${j.attempts} batch attempt(s)${j.last_batch_at ? ' · last ' + timeAgo(j.last_batch_at) : ''}</div>` : raw('')}
    </div>`;
    const cancel = box.querySelector('#genCancel');
    if (cancel) cancel.addEventListener('click', async () => { generating = false; if (j.id) { try { await api.post(`/api/generation/${j.id}/cancel`); } catch (_) { /* ignore */ } } toast('Generation stopped', 'warning'); });
  }

  async function startGeneration() {
    const btn = genCard.querySelector('#genBtn');
    const count = Math.max(1, Math.min(50, parseInt(genCard.querySelector('[name=count]').value, 10) || 50));
    const niche_ids = selectedNicheIds();
    if (!niche_ids.length) { toast('Select at least one niche', 'warning'); return; }
    setBusy(btn, true, 'Starting…');
    generating = true;
    let job = null, batch = null, error = null;
    try {
      const r = await api.post('/api/leads/generate', { contact_type: type, niche_ids, count, run_first_batch: true });
      job = r.job; batch = r.batch;
      await reloadLists();
      view.selectedListId = r.list.id;
      renderLists(); renderContacts(); renderWorkflow();
    } catch (e) {
      generating = false; error = e.message; job = e.details && e.details.job ? e.details.job : null;
      await reloadLists().catch(() => {});
      renderGen(job, batch, error);
      return;
    }
    renderGen(job, batch, null);
    // continue batches until done
    const listId = view.selectedListId;
    while (alive && generating && job && ['pending', 'running'].includes(job.status)) {
      try {
        const r = await api.post(`/api/lists/${listId}/generate`, {});
        job = r.job; batch = r.batch;
        renderGenProgress(job, batch, null);
        await reloadLists(); renderContacts();
      } catch (e) {
        if (e.code === 'conflict' || (e.details && e.details.code === 'generation_busy')) { await new Promise((r) => setTimeout(r, 4000)); continue; }
        error = e.message; job = e.details && e.details.job ? e.details.job : job; break;
      }
    }
    generating = false;
    await reloadLists().catch(() => {});
    renderGen(job, batch, error);
    renderWorkflow(); renderContacts();
    if (job && job.status === 'completed') toast(`List complete: ${job.saved_count} unique contacts saved`, 'success');
    else if (job && job.status === 'exhausted') toast(`Source exhausted at ${job.saved_count}/${job.requested_count}. Nothing was fabricated.`, 'warning', 7000);
  }

  // ---------------- workflow ----------------
  async function renderWorkflow() {
    const listId = view.selectedListId;
    if (!listId) { workflow.innerHTML = ''; return; }
    const list = view.lists.find((l) => l.id === listId);
    workflow.innerHTML = '<div class="card"><div class="loading"><span class="spinner"></span> Loading next contact…</div></div>';
    let r;
    try { r = await api.get(`/api/lists/${listId}/next`); } catch (e) { workflow.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; return; }
    const c = r.contact; const p = r.progress;
    if (!c) {
      workflow.innerHTML = html`<div class="card"><div class="card-head"><h2>Calling workflow · ${list ? list.list_code : ''}</h2><span class="badge success">All ${p.total} contacts processed for this cycle</span></div><div class="muted small">Every contact in this list has a recorded outcome for the current cycle. Use the table below to revisit follow-ups, or wait for rotation / generate more contacts.</div></div>`;
      return;
    }
    const ops = c.business_operations || {};
    const social = c.social_profiles || {};
    const socialLinks = Object.entries(social).filter(([k, v]) => v && !k.endsWith('_handle') && k !== 'whatsapp').map(([k, v]) => `<a href="${esc(/^https?:/.test(v) ? v : 'https://' + v)}" target="_blank" rel="noopener" class="badge outline">${esc(k)}</a>`).join(' ');
    workflow.innerHTML = html`<div class="card"><div class="card-head"><h2>Calling workflow · next contact</h2><div class="progress-row" style="min-width:220px"><span>${p.processed}/${p.total} processed</span>${raw(progressBar(p.processed, p.total || 1, type))}</div></div>
      <div class="grid split wide-left">
        <div>
          <div class="flex flex-wrap"><span class="badge ${type}">#${c.position}</span><span class="name" style="font-size:18px;font-weight:700">${c.business_name}</span>${raw(dataStatusBadge(c.data_status))}${raw(websiteBadge(c.website_available))}${c.call_count > 0 ? raw(badge(`${c.call_count} previous call(s)`, 'info')) : raw('')}</div>
          <div class="muted small mt-1">${c.niche || ''} · ${c.city || ''}${c.company_size ? ' · ' + c.company_size + ' business' : ''}${c.employee_count_estimate ? ' · ~' + c.employee_count_estimate + ' staff' : ''}</div>
          <p class="mt-2">${c.business_description || raw('<span class="faint">No description on record.</span>')}</p>
          <dl class="kv mt-2">
            <dt>Phone</dt><dd>${c.phone ? raw(`<a href="${telHref(c.phone)}"><b>${esc(c.phone)}</b></a> · <a href="${waHref(c.phone)}" target="_blank" rel="noopener">WhatsApp</a>`) : raw('<span class="faint">not on record — use social profiles</span>')} <span class="tiny faint">(${(c.field_verification || {}).phone || 'unknown'})</span></dd>
            <dt>Email</dt><dd>${c.public_email || '—'}</dd>
            <dt>Address</dt><dd>${c.address || '—'}</dd>
            <dt>Website</dt><dd>${c.website ? raw(`<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>`) : (c.website_available === false ? 'None found (qualifies)' : 'Unknown — confirm on the call')}</dd>
            <dt>Social media</dt><dd>${socialLinks ? raw(socialLinks) : '—'}</dd>
            <dt>Services</dt><dd>${listToText(ops.services)}</dd>
            ${type === 'strategy' ? html`<dt>Booking method</dt><dd>${ops.current_booking_method || 'unknown'} · online booking: ${ops.online_booking_status || 'unknown'}</dd><dt>Booking problems</dt><dd>${ops.booking_problems || '—'}</dd><dt>Opportunity</dt><dd>${ops.website_opportunity || ops.booking_automation_opportunity || '—'}</dd>` : html`<dt>Decision-makers</dt><dd>${listToText((c.decision_makers || []).map((d) => `${d.name}${d.designation ? ' (' + d.designation + ')' : ''}`))}</dd><dt>Repetitive processes</dt><dd>${listToText(ops.repetitive_processes)}</dd><dt>Automation opportunities</dt><dd>${(c.automation_opportunities || []).length ? raw('<ul class="small" style="margin:0;padding-left:16px">' + c.automation_opportunities.slice(0, 4).map((o) => `<li><b>${esc(o.process)}</b>: ${esc(o.opportunity)} <span class="faint">(${esc(o.latechs_service)})</span></li>`).join('') + '</ul>') : '—'}</dd>`}
            <dt>Sources</dt><dd>${(c.source_urls || []).length ? raw(c.source_urls.slice(0, 4).map((u) => `<a class="small" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, '').slice(0, 50))}</a>`).join(' · ')) : raw('<span class="faint">none recorded</span>')}</dd>
          </dl>
          ${c.call_count > 0 ? html`<div class="info-box small mt-2">This business was contacted before (last: ${statusBadge(c.contact_status)} ${c.last_call_at ? timeAgo(c.last_call_at) : ''}). <a href="#/contact/${c.id}">Review the full call history</a> before calling again.</div>` : raw('')}
        </div>
        <div>
          <h4>Guided steps</h4>
          <div class="steps">${join(info.steps, (s) => html`<div class="step ${type}"><div class="small">${s}</div></div>`)}</div>
          <div class="mt-3">${raw(contactActionsHtml(c))}</div>
          <div class="flex mt-2"><button class="btn sm ghost" id="skipBtn">Skip this contact (reason required)</button></div>
          <div class="tiny faint mt-2">"Next Contact" becomes available once you save a call record or a skip reason — contacts are never marked completed automatically.</div>
        </div>
      </div></div>`;
    bindContactActions(workflow, c, async () => { await reloadLists(); renderWorkflow(); renderContacts(); });
    workflow.querySelector('#skipBtn').addEventListener('click', async () => {
      const reason = await promptDialog({ title: `Skip ${c.business_name}`, label: 'Why are you skipping this contact?', placeholder: 'e.g. Duplicate of a business already handled, outside working hours for this niche…' });
      if (!reason) return;
      try { await api.post(`/api/leads/${c.id}/skip`, { reason }); toast('Contact skipped with reason', 'warning'); await reloadLists(); renderWorkflow(); renderContacts(); } catch (e) { toast(e.message, 'error'); }
    });
  }

  // ---------------- contacts table ----------------
  async function renderContacts() {
    const listId = view.selectedListId;
    if (!listId) { contactsSection.innerHTML = ''; return; }
    const list = view.lists.find((l) => l.id === listId);
    const limit = 25;
    const params = { list_id: listId, status: view.filters.status, search: view.filters.search, limit, offset: view.page * limit };
    contactsSection.innerHTML = html`<div class="card"><div class="card-head"><h2>Contacts in ${list ? list.list_code : ''}</h2>
      <div class="flex flex-wrap"><input type="search" id="fSearch" placeholder="Search business, phone, city…" value="${view.filters.search}" style="width:220px"><select id="fStatus" style="width:170px"><option value="">All statuses</option>${join(Object.entries(STATUS_LABELS), ([k, v]) => html`<option value="${k}" ${view.filters.status === k ? 'selected' : ''}>${v}</option>`)}</select></div></div>
      <div id="tbl"><div class="loading"><span class="spinner"></span></div></div></div>`;
    const search = contactsSection.querySelector('#fSearch'); let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { view.filters.search = search.value; view.page = 0; renderContacts(); }, 350); });
    contactsSection.querySelector('#fStatus').addEventListener('change', (e) => { view.filters.status = e.target.value; view.page = 0; renderContacts(); });
    let r;
    try { r = await api.get('/api/leads' + api.qs(params)); } catch (e) { contactsSection.querySelector('#tbl').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; return; }
    const tbl = contactsSection.querySelector('#tbl');
    if (!r.items.length) { tbl.innerHTML = emptyState('🔍', 'No contacts match', r.total === 0 && !view.filters.search && !view.filters.status ? 'This list has no contacts yet.' : 'Try another filter.').s; return; }
    const pages = Math.ceil(r.total / limit);
    tbl.innerHTML = contactTableHtml(r.items) + (pages > 1 ? `<div class="flex-between mt-2 small muted"><span>${r.total} contacts</span><div class="flex"><button class="btn xs" id="pPrev" ${view.page === 0 ? 'disabled' : ''}>Prev</button><span>Page ${view.page + 1} / ${pages}</span><button class="btn xs" id="pNext" ${view.page + 1 >= pages ? 'disabled' : ''}>Next</button></div></div>` : '');
    bindRowLinks(tbl);
    const pp = tbl.querySelector('#pPrev'); if (pp) pp.addEventListener('click', () => { view.page--; renderContacts(); });
    const pn = tbl.querySelector('#pNext'); if (pn) pn.addEventListener('click', () => { view.page++; renderContacts(); });
  }

  renderLists();
  renderGen(current && current.generation_job && ['pending', 'running'].includes(current.generation_job.status) ? current.generation_job : null, null, null);
  renderWorkflow();
  renderContacts();
  return () => { alive = false; generating = false; };
}
