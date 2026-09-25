import { api } from '../api.js';
import { el, esc, html, raw, join, toast, badge, panelBadge, dataStatusBadge, websiteBadge, statusBadge, interestBadge, fmtDate, fmtDateTime, fmtTime, timeAgo, listToText, telHref, waHref, setBusy, emptyState, confirmDialog, MEETING_TYPES, MEETING_STATUS, MEETING_STATUS_CLASS, FOLLOWUP_STATUS_CLASS, DATA_STATUS_LABELS } from '../ui.js';
import { state } from '../app.js';
import { openRecordCallModal, openFollowUpModal, openMeetingModal, meetingDetailsModal, contactActionsHtml, bindContactActions } from './shared.js';

function renderValue(v, depth = 0) {
  if (v === null || v === undefined || v === '') return '<span class="faint">—</span>';
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="faint">none</span>';
    return '<ul style="margin:4px 0;padding-left:18px">' + v.map((x) => `<li>${typeof x === 'object' ? renderValue(x, depth + 1) : esc(x)}</li>`).join('') + '</ul>';
  }
  if (typeof v === 'object') return '<dl class="kv small" style="grid-template-columns:150px 1fr">' + Object.entries(v).map(([k, x]) => `<dt>${esc(k.replace(/_/g, ' '))}</dt><dd>${renderValue(x, depth + 1)}</dd>`).join('') + '</dl>';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return esc(String(v));
}

function researchHtml(r) {
  const content = r.content || {};
  const order = Object.keys(content);
  return `<div class="card tight mt-2"><div class="flex-between"><b>${esc(r.kind.replace(/_/g, ' '))}</b><span class="small muted">${esc(fmtDateTime(r.created_at))} · ${esc(r.created_by_name || '')} · ${esc(r.model || '')}${content.data_confidence ? ' · ' + esc(DATA_STATUS_LABELS[content.data_confidence] || content.data_confidence) : ''}</span></div>
    ${order.map((k) => `<div class="mt-2"><h4>${esc(k.replace(/_/g, ' '))}</h4><div class="small">${renderValue(content[k])}</div></div>`).join('')}
    ${(r.source_urls || []).length ? `<div class="mt-2 small"><b>Sources:</b> ${r.source_urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, '').slice(0, 60))}</a>`).join(' · ')}</div>` : ''}
  </div>`;
}

export async function renderContactDetail(root, id) {
  let data;
  try { data = await api.get(`/api/leads/${id}`); } catch (e) {
    root.innerHTML = `<div class="error-box"><b>${esc(e.status === 403 ? 'Access denied' : 'Could not open contact')}.</b> ${esc(e.message)}<div class="mt-2"><a class="btn sm" href="#/overview">Back</a></div></div>`; return;
  }
  const c = data.contact;
  const type = c.contact_type;
  const ops = c.business_operations || {};
  const mgmt = c.management_data || {};
  const social = c.social_profiles || {};
  const fv = c.field_verification || {};
  const reload = () => renderContactDetail(root, id);
  document.getElementById('pageTitle').textContent = c.business_name;
  const socialLinks = Object.entries(social).filter(([k, v]) => v && !k.endsWith('_handle')).map(([k, v]) => `<a href="${esc(/^https?:/.test(v) ? v : k === 'whatsapp' ? waHref(v) : 'https://' + v)}" target="_blank" rel="noopener" class="badge outline">${esc(k)}: ${esc(String(v).replace(/^https?:\/\/(www\.)?/, '').slice(0, 40))}</a>`).join(' ');
  const verified = (k) => `<span class="tiny faint">(${esc(fv[k] || 'unknown')})</span>`;

  root.innerHTML = html`
    <div class="flex-between mb-3"><div><a class="small" href="#/${type}">← ${type === 'strategy' ? 'Strategy Leads' : 'Service Sales Leads'}</a>
      <h1 class="mt-1">${c.business_name} ${c.is_demo ? raw(badge('DEMO DATA', 'warning')) : raw('')}</h1>
      <div class="flex flex-wrap">${raw(panelBadge(type))}${raw(statusBadge(c.contact_status))}${raw(interestBadge(c.interest_level))}${raw(dataStatusBadge(c.data_status))}${raw(websiteBadge(c.website_available))}${c.meeting_status !== 'none' ? raw(badge(`Meeting ${c.meeting_status}`, c.meeting_status === 'booked' ? 'primary' : 'neutral')) : raw('')}${data.processed_this_cycle ? raw(badge('Processed this cycle', 'success')) : raw(badge('Not yet processed this cycle', 'neutral'))}</div></div>
      <div id="actions">${raw(contactActionsHtml(c))}</div></div>
    <div class="grid grid-2">
      <div class="col">
        <div class="card"><div class="card-head"><h2>1 · Business information</h2></div><dl class="kv">
          <dt>Business name</dt><dd>${c.business_name} ${raw(verified('business_name'))}</dd><dt>Industry</dt><dd>${c.industry || '—'}</dd><dt>Niche</dt><dd>${c.niche || '—'}</dd>
          <dt>Description</dt><dd>${c.business_description || '—'}</dd><dt>Website</dt><dd>${c.website ? raw(`<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>`) : (c.website_available === false ? 'No official website' : 'Unknown')} ${raw(verified('website'))}</dd>
          <dt>Services</dt><dd>${listToText(ops.services)}</dd><dt>Business size</dt><dd>${c.company_size || '—'}${c.employee_count_estimate ? ` · ~${c.employee_count_estimate} employees` : ''}</dd>
          <dt>Locations</dt><dd>${listToText(c.business_locations)}</dd></dl></div>
        <div class="card"><div class="card-head"><h2>2 · Contact information</h2></div><dl class="kv">
          <dt>Phone</dt><dd>${c.phone ? raw(`<a href="${telHref(c.phone)}"><b>${esc(c.phone)}</b></a> · <a href="${waHref(c.phone)}" target="_blank" rel="noopener">WhatsApp</a>`) : '—'} ${raw(verified('phone'))}</dd>
          <dt>Public email</dt><dd>${c.public_email || '—'}</dd><dt>Address</dt><dd>${c.address || '—'} ${raw(verified('address'))}</dd><dt>City / Country</dt><dd>${c.city || '—'}, ${c.country}</dd>
          <dt>Social media</dt><dd>${socialLinks ? raw(socialLinks) : '—'} ${raw(verified('social_profiles'))}</dd>
          <dt>Sources</dt><dd>${(c.source_urls || []).length ? raw(c.source_urls.map((u) => `<a class="small" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, '').slice(0, 60))}</a>`).join('<br>')) : raw('<span class="faint">No source URLs recorded — treat details as unverified.</span>')}</dd>
          <dt>Data status</dt><dd>${raw(dataStatusBadge(c.data_status))} <span class="small muted">generated ${fmtDateTime(c.generation_timestamp)} via ${c.generation_source || '—'}</span></dd></dl></div>
        <div class="card"><div class="card-head"><h2>3 · Company structure</h2></div><dl class="kv">
          <dt>Departments</dt><dd>${listToText(c.departments)}</dd>
          <dt>Owners</dt><dd>${raw(renderValue((mgmt.owners || []).map((p) => `${p.name}${p.designation ? ' — ' + p.designation : ''}`)))} ${raw(verified('people'))}</dd>
          <dt>Senior management</dt><dd>${raw(renderValue((mgmt.senior_management || []).map((p) => `${p.name}${p.designation ? ' — ' + p.designation : ''}`)))}</dd>
          <dt>Decision-makers</dt><dd>${raw(renderValue((c.decision_makers || []).map((p) => `${p.name}${p.designation ? ' — ' + p.designation : ''}${p.contact ? ' · ' + p.contact : ''}${p.source === 'call' ? ' (from call)' : ''}`)))}</dd>
          <dt>Hierarchy</dt><dd>${mgmt.hierarchy || raw('<span class="faint">not published</span>')}</dd></dl>
          <div class="tiny faint mt-1">Only publicly published names are stored. Nothing here is invented.</div></div>
        <div class="card"><div class="card-head"><h2>4 · Operations</h2></div>
          ${type === 'strategy' ? html`<dl class="kv"><dt>Current booking method</dt><dd>${ops.current_booking_method || 'unknown'}</dd><dt>Online booking</dt><dd>${ops.online_booking_status || 'unknown'}</dd><dt>Website status</dt><dd>${ops.website_status || 'unknown'}</dd><dt>Social presence</dt><dd>${listToText(ops.social_presence)}</dd><dt>Booking problems</dt><dd>${ops.booking_problems || ops.booking_problems_reported || '—'}</dd><dt>Website requirement</dt><dd>${ops.website_opportunity || '—'}</dd><dt>Booking automation opportunity</dt><dd>${ops.booking_automation_opportunity || '—'}</dd><dt>Interested in website</dt><dd>${listToText(ops.interested_in_website)}</dd><dt>Interested in booking system</dt><dd>${listToText(ops.interested_in_booking_system)}</dd><dt>LATechS introduced</dt><dd>${ops.latechs_introduced ? 'Yes' : 'Not yet'}</dd></dl>`
          : html`<dl class="kv"><dt>Team size</dt><dd>${ops.team_size_estimate || c.employee_count_estimate || '—'}</dd><dt>Existing software</dt><dd>${listToText(ops.existing_software)}</dd><dt>Operational challenges</dt><dd>${listToText(ops.operational_challenges)}</dd><dt>Repetitive processes</dt><dd>${raw(renderValue(ops.repetitive_processes))}</dd><dt>Automation opportunities</dt><dd>${(c.automation_opportunities || []).length ? raw('<ul style="margin:0;padding-left:16px">' + c.automation_opportunities.map((o) => `<li><b>${esc(o.process)}</b>: ${esc(o.opportunity || o.proposed_automation || '')} <span class="faint">(${esc(o.latechs_service || '')})</span></li>`).join('') + '</ul>') : '—'}</dd><dt>Relevant LATechS services</dt><dd>${listToText(ops.relevant_latechs_services)}</dd><dt>Discussed on calls</dt><dd>${ops.automation_opportunities_discussed || '—'}</dd><dt>Services interested in</dt><dd>${ops.services_interested || '—'}</dd></dl>`}</div>
        <div class="card"><div class="card-head"><h2>5 · Lead information</h2></div><dl class="kv">
          <dt>Panel</dt><dd>${raw(panelBadge(type))}</dd><dt>List</dt><dd>${c.list_code || '—'} <span class="muted small">${c.list_name || ''}</span></dd>
          <dt>Current owner</dt><dd>${c.current_owner_name || '—'}</dd><dt>Original owner</dt><dd>${c.original_owner_name || '—'}</dd>
          <dt>Generated</dt><dd>${fmtDateTime(c.generation_timestamp || c.created_at)}</dd><dt>Status</dt><dd>${raw(statusBadge(c.contact_status))}</dd><dt>Interest</dt><dd>${raw(interestBadge(c.interest_level))}</dd>
          <dt>Calls</dt><dd>${c.call_count} · last ${c.last_call_at ? timeAgo(c.last_call_at) : 'never'}</dd><dt>Next follow-up</dt><dd>${c.follow_up_date ? fmtDate(c.follow_up_date) : '—'}</dd><dt>Meeting status</dt><dd>${c.meeting_status}</dd>
          ${c.skip_reason ? html`<dt>Skip reason</dt><dd>${c.skip_reason}</dd>` : raw('')}</dl></div>
      </div>
      <div class="col">
        <div class="card"><div class="card-head"><h2>6 · Call history</h2><span class="small muted">${data.call_history.length} record(s), chronological</span></div>
          ${data.call_history.length ? html`<div class="timeline">${join(data.call_history, (r) => html`<div class="timeline-item"><div class="flex-between"><div><b>${r.employee_name}</b> ${r.skipped ? raw(badge('Skipped', 'neutral')) : raw(statusBadge(r.call_status))} ${raw(interestBadge(r.interest_level))}</div><span class="when">${fmtDateTime(r.call_datetime)} · cycle ${r.cycle_number}</span></div>
            ${r.person_contacted ? html`<div class="small">Spoke to <b>${r.person_contacted}</b>${r.person_designation ? ` (${r.person_designation})` : ''}</div>` : raw('')}
            ${r.conversation_summary ? html`<div class="small mt-1"><b>Summary:</b> ${r.conversation_summary}</div>` : raw('')}
            ${r.customer_response ? html`<div class="small"><b>Customer response:</b> ${r.customer_response}</div>` : raw('')}
            ${r.problems_identified ? html`<div class="small"><b>Problems:</b> ${r.problems_identified}</div>` : raw('')}
            ${r.objections ? html`<div class="small"><b>Objections:</b> ${r.objections}</div>` : raw('')}
            ${r.services_discussed ? html`<div class="small"><b>Services discussed:</b> ${r.services_discussed}</div>` : raw('')}
            ${Object.keys(r.panel_fields || {}).length ? html`<div class="small muted mt-1">${Object.entries(r.panel_fields).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v === true ? 'yes' : v === false ? 'no' : v}`).join(' · ')}</div>` : raw('')}
            <div class="small mt-1"><b>Next action:</b> ${r.follow_up_required ? `follow up ${fmtDate(r.next_follow_up_date)}` : ''}${r.meeting_required ? ' · meeting required' : ''}${!r.follow_up_required && !r.meeting_required ? 'none' : ''}</div>
            ${r.additional_notes ? html`<div class="small muted">${r.additional_notes}</div>` : raw('')}</div>`)}</div>` : raw(emptyState('☎', 'No calls recorded yet', 'Record the first call to start the history.'))}
        </div>
        <div class="card"><div class="card-head"><h2>7 · Notes</h2><button class="btn xs" id="saveNotes">Save notes</button></div><textarea id="notes" placeholder="Employee notes (kept permanently)…">${c.notes || ''}</textarea></div>
        <div class="card"><div class="card-head"><h2>8 · Follow-ups</h2><button class="btn xs" data-act="followup">Add</button></div>
          ${data.follow_ups.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Reason</th><th>Owner</th><th>Status</th><th></th></tr></thead><tbody>${join(data.follow_ups, (f) => html`<tr><td class="nowrap">${fmtDate(f.follow_up_date)} ${fmtTime(f.follow_up_time)}</td><td>${f.reason || '—'}<span class="sub">${f.notes || ''}</span></td><td>${f.owner_name}</td><td>${raw(badge(f.status, FOLLOWUP_STATUS_CLASS[f.status]))}</td><td>${f.status === 'pending' && (state.user.role === 'owner' || f.owner_id === state.user.id || c.current_owner_id === state.user.id) ? raw(`<button class="btn xs success" data-fu="${f.id}" data-s="completed">Done</button> <button class="btn xs" data-fu="${f.id}" data-s="cancelled">Cancel</button>`) : raw('')}</td></tr>`)}</tbody></table></div>` : raw(emptyState('⏰', 'No follow-ups'))}
        </div>
        <div class="card"><div class="card-head"><h2>9 · Meetings</h2><button class="btn xs" data-act="meeting">Schedule</button></div>
          ${data.meetings.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Owner</th><th>Status</th></tr></thead><tbody>${join(data.meetings, (m) => html`<tr class="clickable" data-m="${m.id}"><td class="nowrap">${fmtDate(m.meeting_date)} ${fmtTime(m.start_time)}–${fmtTime(m.end_time)}</td><td>${MEETING_TYPES[m.meeting_type] || m.meeting_type}</td><td>${m.owner_name}</td><td>${raw(badge(MEETING_STATUS[m.meeting_status] || m.meeting_status, MEETING_STATUS_CLASS[m.meeting_status]))}</td></tr>`)}</tbody></table></div>` : raw(emptyState('📅', 'No meetings yet'))}
        </div>
        <div class="card"><div class="card-head"><h2>10 · Rotation history</h2></div>
          ${data.rotation_history.length ? html`<div class="timeline">${join(data.rotation_history, (h) => html`<div class="timeline-item"><div><b>${h.event_type === 'completed' ? 'List completed' : h.event_type === 'manual_transfer' ? 'Manual transfer' : 'Rotated'}</b>: ${h.previous_owner_name} → ${h.new_owner_name || 'archive'} <span class="muted small">(${h.list_code}, cycle ${h.cycle_number})</span></div><div class="when">${fmtDateTime(h.rotation_date)}</div></div>`)}</div>` : raw('<div class="muted small">This list has not rotated yet. It was created for ' + esc(c.original_owner_name || '') + '.</div>')}
        </div>
        <div class="card"><div class="card-head"><h2>AI research & meeting preparation</h2><div class="flex"><button class="btn sm ${type}" id="researchBtn">${type === 'service' ? 'Prepare meeting profile' : 'Analyse booking need'}</button>${type === 'service' ? raw('<label class="check small"><input type="checkbox" id="rWeb" checked> web research</label>') : raw('')}</div></div>
          <div class="small muted">${type === 'service' ? 'Generates a business profile (services, team size estimate, departments, processes, repetitive tasks) and a customized automation proposal outline from the record and call history.' : 'Summarises the booking process learned so far, the real problems, whether a website or booking system is genuinely needed, and how to introduce LATechS.'} Estimates are marked; nothing is invented.</div>
          <div id="researchOut">${data.research.length ? raw(data.research.map(researchHtml).join('')) : raw('<div class="muted small mt-2">No research generated yet.</div>')}</div>
        </div>
      </div>
    </div>`;

  bindContactActions(root, c, reload);
  root.querySelector('#saveNotes').addEventListener('click', async (e) => { setBusy(e.target, true, 'Saving…'); try { await api.patch(`/api/leads/${c.id}/notes`, { notes: root.querySelector('#notes').value }); toast('Notes saved', 'success'); } catch (er) { toast(er.message, 'error'); } setBusy(e.target, false); });
  root.querySelectorAll('[data-fu]').forEach((b) => b.addEventListener('click', async () => { try { await api.patch(`/api/follow-ups/${b.dataset.fu}`, { status: b.dataset.s }); toast('Follow-up updated', 'success'); reload(); } catch (er) { toast(er.message, 'error'); } }));
  root.querySelectorAll('[data-m]').forEach((tr) => tr.addEventListener('click', () => { const m = data.meetings.find((x) => x.id === tr.dataset.m); if (m) meetingDetailsModal({ ...m, can_manage: state.user.role === 'owner' || m.meeting_owner_id === state.user.id, created_by_name: m.created_by_name || '' }, reload); }));
  root.querySelector('#researchBtn').addEventListener('click', async (e) => {
    const btn = e.target; setBusy(btn, true, 'Researching… this can take a minute or two');
    const out = root.querySelector('#researchOut');
    try {
      const webEl = root.querySelector('#rWeb');
      const r = await api.post(`/api/leads/${c.id}/research`, { kind: type === 'service' ? 'meeting_prep' : 'booking_analysis', web_search: webEl ? webEl.checked : false });
      out.insertAdjacentHTML('afterbegin', researchHtml({ ...r.research, created_by_name: state.user.display_name }));
      toast('Research saved to the contact record', 'success');
    } catch (er) { toast(er.message, 'error', 8000); }
    setBusy(btn, false);
  });
}
