import { api } from '../api.js';
import { esc, html, raw, join, toast, badge, emptyState, statusBadge, interestBadge, dataStatusBadge, panelBadge, fmtDateTime, STATUS_LABELS, INTEREST_LABELS, DATA_STATUS_LABELS } from '../ui.js';
import { state } from '../app.js';
import { contactTableHtml, bindRowLinks } from './shared.js';

export async function renderContacts(root) {
  const f = { employee_id: '', contact_type: '', niche: '', city: '', status: '', interest_level: '', meeting_status: '', follow_up: '', data_status: '', cycle: '', generated_from: '', generated_to: '', website_available: '', company_size: '', search: '', sort: 'created' };
  let page = 0; const limit = 30;
  const opts = await api.get('/api/leads/filters');
  const sel = (name, label, options, current) => html`<label class="field"><span>${label}</span><select name="${name}"><option value="">Any</option>${join(options, ([k, v]) => html`<option value="${k}" ${current === k ? 'selected' : ''}>${v}</option>`)}</select></label>`;
  root.innerHTML = html`<div class="card mb-3"><div class="card-head"><h2>Global business search</h2><span class="small muted">Shahroz sees every record: owner, history, rotation, meetings, follow-ups</span></div>
      <div class="flex"><input type="search" id="gSearch" placeholder="Business name…" style="max-width:420px"><button class="btn primary" id="gBtn">Search</button></div><div id="gOut" class="mt-2"></div></div>
    <div class="card"><div class="card-head"><h2>All contacts</h2><span class="small muted" id="count"></span></div>
      <form id="filters" class="grid grid-4 mb-2">
        ${sel('employee_id', 'Employee (current owner)', state.users.map((u) => [u.id, u.display_name]), f.employee_id)}
        ${sel('contact_type', 'Panel', [['strategy', 'Strategy Leads'], ['service', 'Service Sales Leads']], f.contact_type)}
        ${sel('niche', 'Niche', opts.niches.map((n) => [n, n]), f.niche)}
        ${sel('city', 'City', opts.cities.map((c) => [c, c]), f.city)}
        ${sel('status', 'Contact status', Object.entries(STATUS_LABELS), f.status)}
        ${sel('interest_level', 'Interest level', Object.entries(INTEREST_LABELS), f.interest_level)}
        ${sel('meeting_status', 'Meeting status', [['none', 'None'], ['requested', 'Requested'], ['booked', 'Booked'], ['completed', 'Completed'], ['cancelled', 'Cancelled']], f.meeting_status)}
        ${sel('follow_up', 'Follow-up', [['pending', 'Has pending'], ['due', 'Due now'], ['none', 'None pending']], f.follow_up)}
        ${sel('data_status', 'Verification', Object.entries(DATA_STATUS_LABELS), f.data_status)}
        ${sel('website_available', 'Website', [['true', 'Has website'], ['false', 'No website'], ['unknown', 'Unknown']], f.website_available)}
        ${sel('company_size', 'Business size', [['solo', 'Solo'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], f.company_size)}
        ${sel('cycle', 'Rotation cycle', opts.cycles.map((c) => [String(c), 'Cycle ' + c]), f.cycle)}
        <label class="field"><span>Generated from</span><input type="date" name="generated_from"></label>
        <label class="field"><span>Generated to</span><input type="date" name="generated_to"></label>
        <label class="field"><span>Search</span><input type="search" name="search" placeholder="name, phone, city, niche"></label>
        <label class="field"><span>Sort</span><select name="sort"><option value="created">Newest first</option><option value="name">Name</option><option value="status">Status</option><option value="last_call">Last call</option></select></label>
      </form>
      <div class="flex mb-2"><button class="btn primary sm" id="apply">Apply filters</button><button class="btn sm" id="reset">Reset</button></div>
      <div id="tbl"></div></div>`;
  const form = root.querySelector('#filters');
  async function load() {
    for (const e of form.elements) if (e.name) f[e.name] = e.value;
    const tbl = root.querySelector('#tbl'); tbl.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    const r = await api.get('/api/admin/contacts' + api.qs({ ...f, limit, offset: page * limit }));
    root.querySelector('#count').textContent = `${r.total} contact(s)`;
    if (!r.items.length) { tbl.innerHTML = emptyState('🔍', 'No contacts match these filters').s; return; }
    const pages = Math.ceil(r.total / limit);
    tbl.innerHTML = contactTableHtml(r.items, { showOwner: true, showPanel: true }) + `<div class="flex-between mt-2 small muted"><span>Page ${page + 1} / ${pages}</span><div class="flex"><button class="btn xs" id="pPrev" ${page === 0 ? 'disabled' : ''}>Prev</button><button class="btn xs" id="pNext" ${page + 1 >= pages ? 'disabled' : ''}>Next</button></div></div>`;
    bindRowLinks(tbl);
    tbl.querySelector('#pPrev').addEventListener('click', () => { page--; load(); });
    tbl.querySelector('#pNext').addEventListener('click', () => { page++; load(); });
  }
  root.querySelector('#apply').addEventListener('click', () => { page = 0; load(); });
  root.querySelector('#reset').addEventListener('click', () => { form.reset(); page = 0; load(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); page = 0; load(); });
  const gs = root.querySelector('#gSearch');
  const gsearch = async () => {
    const q = gs.value.trim(); const out = root.querySelector('#gOut');
    if (q.length < 2) { out.innerHTML = '<div class="small muted">Type at least two characters.</div>'; return; }
    out.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    try {
      const r = await api.get('/api/admin/search' + api.qs({ q }));
      out.innerHTML = r.items.length ? html`<div class="table-wrap"><table><thead><tr><th>Business</th><th>Panel</th><th>Current owner</th><th>Original owner</th><th>Status</th><th>Calls</th><th>Meeting</th><th>Follow-ups</th><th>Data</th></tr></thead><tbody>${join(r.items, (c) => html`<tr class="clickable" data-id="${c.id}"><td><b>${c.business_name}</b><span class="sub">${c.niche || ''} · ${c.city || ''}</span></td><td>${raw(panelBadge(c.contact_type))}</td><td>${c.current_owner_name || '—'}</td><td>${c.original_owner_name || '—'}</td><td>${raw(statusBadge(c.contact_status))} ${raw(interestBadge(c.interest_level))}</td><td>${c.call_count}</td><td>${c.meeting_status}</td><td>${c.pending_follow_ups}</td><td>${raw(dataStatusBadge(c.data_status))}</td></tr>`)}</tbody></table></div>` : emptyState('🔍', 'No business matches that name').s;
      bindRowLinks(out);
    } catch (e) { out.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
  root.querySelector('#gBtn').addEventListener('click', gsearch);
  gs.addEventListener('keydown', (e) => { if (e.key === 'Enter') gsearch(); });
  await load();
}
