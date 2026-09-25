import { api } from '../api.js';
import { el, esc, html, raw, join, modal, toast, setBusy, formValues, statusBadge, interestBadge, dataStatusBadge, websiteBadge, panelBadge, badge, fmtDate, fmtDateTime, todayStr, addDaysStr, telHref, waHref, MEETING_TYPES, MEETING_STATUS, STATUS_LABELS, INTEREST_LABELS } from '../ui.js';
import { state } from '../app.js';

export function contactRowHtml(c, { showOwner = false, showPanel = false } = {}) {
  const followUp = Number(c.pending_follow_ups) ? badge(`${c.pending_follow_ups} follow-up${Number(c.pending_follow_ups) > 1 ? 's' : ''}`, 'warning') : raw('');
  const meeting = c.meeting_status && c.meeting_status !== 'none' ? badge(`Meeting ${c.meeting_status}`, c.meeting_status === 'booked' ? 'primary' : 'neutral') : raw('');
  return html`<tr class="clickable" data-id="${c.id}">
    <td><div><b>${c.business_name}</b>${c.is_demo ? ' ' : ''}${c.is_demo ? badge('DEMO', 'warning') : raw('')}</div><span class="sub">${c.niche || '—'}${showPanel ? raw(' · ' + panelBadge(c.contact_type)) : raw('')}</span></td>
    <td>${c.city || '—'}</td>
    <td>${c.phone ? raw(`<a href="${telHref(c.phone)}">${esc(c.phone)}</a>`) : raw('<span class="faint">no phone</span>')}<span class="sub">${raw(websiteBadge(c.website_available))}</span></td>
    <td>${c.company_size || '—'}</td>
    ${showOwner ? html`<td>${c.current_owner_name || '—'}<span class="sub">from ${c.original_owner_name || '—'}</span></td>` : raw('')}
    <td>${raw(statusBadge(c.contact_status))}<span class="sub">${raw(interestBadge(c.interest_level))}</span></td>
    <td>${followUp} ${meeting}</td>
    <td>${raw(dataStatusBadge(c.data_status))}</td>
  </tr>`;
}

export function contactTableHtml(items, opts = {}) {
  return html`<div class="table-wrap"><table><thead><tr><th>Business</th><th>City</th><th>Contact</th><th>Size</th>${opts.showOwner ? raw('<th>Assignee</th>') : raw('')}<th>Status / Interest</th><th>Follow-up / Meeting</th><th>Data</th></tr></thead>
    <tbody>${join(items, (c) => contactRowHtml(c, opts))}</tbody></table></div>`;
}

export function bindRowLinks(container) {
  container.querySelectorAll('tr.clickable[data-id]').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.closest('a,button')) return; location.hash = `#/contact/${tr.dataset.id}`; }));
}

function triHtml(name, label, value = null) {
  return `<div class="field"><span class="small muted">${esc(label)}</span><div class="tri" data-tri="${name}"><input type="hidden" name="${name}" value="${value === true ? 'true' : value === false ? 'false' : ''}"><button type="button" data-v="true" class="${value === true ? 'on yes' : ''}">Yes</button><button type="button" data-v="false" class="${value === false ? 'on no' : ''}">No</button><button type="button" data-v="" class="${value === null ? 'on' : ''}">Unknown</button></div></div>`;
}
function bindTri(container) {
  container.querySelectorAll('[data-tri]').forEach((box) => {
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      box.querySelector('input').value = b.dataset.v;
      box.querySelectorAll('button').forEach((x) => x.classList.remove('on', 'yes', 'no'));
      b.classList.add('on'); if (b.dataset.v === 'true') b.classList.add('yes'); if (b.dataset.v === 'false') b.classList.add('no');
    }));
  });
}

const STRATEGY_GUIDE = [
  'How do customers currently book appointments?', 'Is online booking available?', 'Can customers book through WhatsApp?', 'Do customers call for appointments?',
  'Do they use Instagram/Facebook messages for bookings?', 'Do customers face booking difficulties?', 'Do missed calls or delays happen because of scheduling?', 'Has the business considered online appointments?',
];
const SERVICE_GUIDE = ['Reach the owner, founder, director, general manager, operations manager or sales manager.', 'Record the person\'s name, designation, phone and email where available.', 'Understand the repetitive work (inquiries, follow-ups, scheduling, data entry) before pitching.', 'Ask for a meeting with the decision-maker and save the meeting immediately.'];

/** Guided "Record Call" modal. Calls onSaved(result) after a successful save. */
export function openRecordCallModal(contact, onSaved) {
  const isStrategy = contact.contact_type === 'strategy';
  const ops = contact.business_operations || {};
  const statuses = Object.entries(STATUS_LABELS).filter(([k]) => k !== 'not_called');
  const body = el(`<form class="col" id="callForm">
    <div class="step ${contact.contact_type}"><div class="grow"><b>Step 1 · Identify the business</b>
      <div class="small muted">${esc(contact.business_name)} · ${esc(contact.niche || '')} · ${esc(contact.city || '')} · ${contact.phone ? `<a href="${telHref(contact.phone)}">${esc(contact.phone)}</a>` : 'no phone on record'} · ${websiteBadge(contact.website_available)}</div>
      ${isStrategy ? `<div class="small muted mt-1">Booking method on record: <b>${esc(ops.current_booking_method || 'unknown')}</b> · Online booking: <b>${esc(ops.online_booking_status || 'unknown')}</b></div>` : `<div class="small muted mt-1">Decision-makers on record: ${(contact.decision_makers || []).length ? esc((contact.decision_makers || []).map((d) => `${d.name}${d.designation ? ' (' + d.designation + ')' : ''}`).join(', ')) : 'none yet'}</div>`}
    </div></div>
    <details class="acc"><summary>${isStrategy ? 'Step 2 · Initial customer inquiry — questions to ask (approach as a potential customer first)' : 'Step 2 · Initial contact — how to reach the decision-maker'}</summary><div class="acc-body"><ul class="small muted">${(isStrategy ? STRATEGY_GUIDE : SERVICE_GUIDE).map((q) => `<li>${esc(q)}</li>`).join('')}</ul>${isStrategy ? '<div class="warn-box small">Only introduce LATechS after you understand how booking currently works. Record the actual response — never assume interest.</div>' : ''}</div></details>
    <div class="form-grid">
      <label class="field"><span>Person contacted</span><input type="text" name="person_contacted" placeholder="Name of the person you spoke to"></label>
      <label class="field"><span>Designation</span><input type="text" name="person_designation" placeholder="Owner / Manager / Receptionist…"></label>
      <label class="field"><span class="req">Call status</span><select name="call_status" required><option value="">Select outcome…</option>${statuses.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>Interest level</span><select name="interest_level"><option value="">Not determined</option>${Object.entries(INTEREST_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      <label class="field span-2"><span class="req">Conversation summary</span><textarea name="conversation_summary" placeholder="What was discussed, in your own words. Required unless there was no conversation (no answer / wrong number)."></textarea></label>
      <label class="field span-2"><span>Customer response</span><textarea name="customer_response" placeholder="What the business actually said"></textarea></label>
    </div>
    <div class="step ${contact.contact_type}"><div class="grow"><b>Step 3 · ${isStrategy ? 'Identify the need (booking process)' : 'Decision-maker & meeting'}</b>
      <div class="form-grid mt-2" id="panelFields">
      ${isStrategy ? `
        ${triHtml('pf_asked_about_online_booking', 'Was the business asked about online booking?')}
        ${triHtml('pf_has_website', 'Does the business have a website?', contact.website_available)}
        <label class="field span-2"><span>How does the business currently accept bookings?</span><input type="text" name="pf_current_booking_method" value="${esc(ops.current_booking_method || '')}" placeholder="Phone calls, WhatsApp, Instagram DM, walk-in…"></label>
        ${triHtml('pf_offers_online_appointments', 'Does the business offer online appointments?')}
        ${triHtml('pf_latechs_introduced', 'Was LATechS introduced? (only after the inquiry stage)')}
        ${triHtml('pf_website_development_discussed', 'Was website development discussed?')}
        ${triHtml('pf_interested_in_website', 'Is the business interested in a website?')}
        ${triHtml('pf_interested_in_booking_system', 'Is the business interested in an online booking system?')}
      ` : `
        ${triHtml('pf_business_contacted', 'Was the business contacted?')}
        ${triHtml('pf_decision_maker_reached', 'Was the decision-maker reached?')}
        <label class="field"><span>Decision-maker name</span><input type="text" name="pf_decision_maker_name"></label>
        <label class="field"><span>Decision-maker designation</span><input type="text" name="pf_decision_maker_designation" placeholder="Owner / Director / GM / Ops Manager…"></label>
        ${triHtml('pf_meeting_requested', 'Was a meeting requested?')}
        ${triHtml('pf_meeting_booked', 'Was a meeting booked?')}
        <label class="field span-2"><span>Automation opportunities discussed</span><textarea name="pf_automation_opportunities_discussed" placeholder="Specific workflows discussed (e.g. WhatsApp inquiry handling, follow-up calls)"></textarea></label>
        <label class="field"><span>Services the business is interested in</span><input type="text" name="pf_services_interested"></label>
        <label class="field"><span>Meeting outcome (if a meeting happened)</span><input type="text" name="pf_meeting_outcome"></label>
      `}
      </div></div></div>
    <div class="step ${contact.contact_type}"><div class="grow"><b>Step 4 · Record the outcome</b>
      <div class="form-grid mt-2">
        <label class="field"><span>Services discussed</span><input type="text" name="services_discussed" placeholder="${isStrategy ? 'Website, online booking, reminders…' : 'AI receptionist, WhatsApp automation…'}"></label>
        <label class="field"><span>Problems identified</span><input type="text" name="problems_identified" placeholder="Missed calls, slow replies, manual data entry…"></label>
        <label class="field span-2"><span>Objections</span><input type="text" name="objections" placeholder="Cost, no need, already have something…"></label>
        <label class="check"><input type="checkbox" name="follow_up_required"> Follow-up required</label>
        <label class="field"><span>Next follow-up date</span><input type="date" name="next_follow_up_date" min="${todayStr()}"></label>
        <label class="check"><input type="checkbox" name="meeting_required"> Meeting required / requested</label>
        <label class="field span-2"><span>Additional notes</span><textarea name="additional_notes"></textarea></label>
      </div></div></div>
    <div class="error-text hidden" id="callErr"></div>
  </form>`);
  bindTri(body);
  const statusSel = body.querySelector('[name=call_status]');
  statusSel.addEventListener('change', () => {
    const s = statusSel.value;
    if (s === 'follow_up_required' || s === 'call_back_later') { body.querySelector('[name=follow_up_required]').checked = true; if (!body.querySelector('[name=next_follow_up_date]').value) body.querySelector('[name=next_follow_up_date]').value = addDaysStr(todayStr(), s === 'call_back_later' ? 1 : 3); }
    if (s === 'meeting_booked') body.querySelector('[name=meeting_required]').checked = true;
  });
  const foot = el(`<div class="flex"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="save">Save call record</button></div>`);
  const m = modal({ title: `Record call · ${contact.business_name}`, body, footer: foot, size: 'wide' });
  foot.querySelector('[data-x=cancel]').addEventListener('click', m.close);
  foot.querySelector('[data-x=save]').addEventListener('click', async () => {
    const v = formValues(body);
    const payload = { panel_fields: {} };
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith('pf_')) { if (val === '' || val === undefined) continue; payload.panel_fields[k.slice(3)] = val === 'true' ? true : val === 'false' ? false : val; }
      else payload[k] = val;
    }
    const err = body.querySelector('#callErr'); err.classList.add('hidden');
    const btn = foot.querySelector('[data-x=save]'); setBusy(btn, true, 'Saving…');
    try {
      const result = await api.post(`/api/leads/${contact.id}/call`, payload);
      toast('Call recorded', 'success');
      m.close();
      if (onSaved) onSaved(result);
      if (payload.meeting_required || payload.call_status === 'meeting_booked') {
        const mm = modal({ title: 'Schedule the meeting now?', body: '<p>You marked that a meeting is required. Book it on the shared calendar now so the slot is protected.</p>', footer: el('<div class="flex"><button class="btn" data-x="later">Later</button><button class="btn primary" data-x="now">Schedule meeting</button></div>'), size: 'narrow' });
        mm.foot.querySelector('[data-x=later]').addEventListener('click', mm.close);
        mm.foot.querySelector('[data-x=now]').addEventListener('click', () => { mm.close(); openMeetingModal({ contact: result.contact, onSaved }); });
      }
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); setBusy(btn, false); }
  });
}

export function openFollowUpModal(contact, onSaved) {
  const body = el(`<form class="col"><div class="form-grid">
    <label class="field"><span class="req">Follow-up date</span><input type="date" name="follow_up_date" value="${addDaysStr(todayStr(), 1)}" min="${todayStr()}" required></label>
    <label class="field"><span>Time</span><input type="time" name="follow_up_time"></label>
    <label class="field span-2"><span class="req">Reason</span><input type="text" name="reason" placeholder="Why are you following up?" required></label>
    <label class="field"><span>Contact person</span><input type="text" name="contact_person"></label>
    <label class="field span-2"><span>Notes</span><textarea name="notes"></textarea></label>
  </div><div class="error-text hidden" data-x="err"></div></form>`);
  const foot = el('<div class="flex"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="save">Add follow-up</button></div>');
  const m = modal({ title: `Add follow-up · ${contact.business_name}`, body, footer: foot });
  foot.querySelector('[data-x=cancel]').addEventListener('click', m.close);
  foot.querySelector('[data-x=save]').addEventListener('click', async () => {
    const btn = foot.querySelector('[data-x=save]'); setBusy(btn, true, 'Saving…');
    try { const r = await api.post(`/api/leads/${contact.id}/follow-up`, formValues(body)); toast('Follow-up added', 'success'); m.close(); if (onSaved) onSaved(r); }
    catch (e) { const er = body.querySelector('[data-x=err]'); er.textContent = e.message; er.classList.remove('hidden'); setBusy(btn, false); }
  });
}

/** Create / edit a meeting. opts: { contact, meeting, date, onSaved } */
export function openMeetingModal({ contact = null, meeting = null, date = null, start = null, onSaved } = {}) {
  const editing = !!meeting;
  const isOwner = state.user.role === 'owner';
  const mt = meeting || {};
  const defType = contact ? (contact.contact_type === 'strategy' ? 'website_development' : 'automation_sales') : 'other';
  const body = el(`<form class="col">
    <div class="form-grid">
      <label class="field span-2"><span class="req">Business name</span><input type="text" name="business_name" value="${esc(mt.business_name || (contact ? contact.business_name : ''))}" required></label>
      <label class="field"><span>Contact person</span><input type="text" name="contact_person" value="${esc(mt.contact_person || '')}"></label>
      <label class="field"><span>Phone number</span><input type="text" name="phone_number" value="${esc(mt.phone_number || (contact ? contact.phone || '' : ''))}"></label>
      <label class="field"><span class="req">Meeting type</span><select name="meeting_type">${Object.entries(MEETING_TYPES).map(([k, v]) => `<option value="${k}" ${(mt.meeting_type || defType) === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      ${isOwner ? `<label class="field"><span>Meeting owner</span><select name="meeting_owner_id">${state.users.map((u) => `<option value="${u.id}" ${(mt.meeting_owner_id || state.user.id) === u.id ? 'selected' : ''}>${esc(u.display_name)}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span class="req">Date</span><input type="date" name="meeting_date" value="${esc(mt.meeting_date || date || todayStr())}" required></label>
      <div class="flex"><label class="field grow"><span class="req">Start</span><input type="time" name="start_time" value="${esc(mt.start_time ? String(mt.start_time).slice(0, 5) : start || '11:00')}" required></label><label class="field grow"><span>End</span><input type="time" name="end_time" value="${esc(mt.end_time ? String(mt.end_time).slice(0, 5) : '')}"></label></div>
      <label class="field"><span>Location</span><input type="text" name="location" value="${esc(mt.location || '')}" placeholder="Office / client site / phone"></label>
      <label class="field"><span>Online meeting link</span><input type="url" name="online_link" value="${esc(mt.online_link || '')}" placeholder="https://meet.google.com/…"></label>
      ${editing ? `<label class="field"><span>Status</span><select name="meeting_status">${Object.entries(MEETING_STATUS).map(([k, v]) => `<option value="${k}" ${mt.meeting_status === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>` : ''}
      <label class="field span-2"><span>Meeting notes</span><textarea name="notes">${esc(mt.notes || '')}</textarea></label>
    </div>
    <div class="flex"><button type="button" class="btn sm" data-x="check">Check availability</button><span class="small muted" data-x="avail"></span></div>
    ${editing ? `<details class="acc"><summary>Record meeting outcome</summary><div class="acc-body form-grid">
      <label class="field"><span>Interest level</span><select name="o_interest_level"><option value="">—</option>${Object.entries(INTEREST_LABELS).map(([k, v]) => `<option value="${k}" ${(mt.outcome || {}).interest_level === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>Meeting result</span><input type="text" name="o_meeting_result" value="${esc((mt.outcome || {}).meeting_result || '')}" placeholder="Proposal requested / Not now / Closed…"></label>
      <label class="field span-2"><span>Problems identified</span><textarea name="o_problems_identified">${esc((mt.outcome || {}).problems_identified || '')}</textarea></label>
      <label class="field span-2"><span>Requirements</span><textarea name="o_requirements">${esc((mt.outcome || {}).requirements || '')}</textarea></label>
      <label class="field"><span>Objections</span><input type="text" name="o_objections" value="${esc((mt.outcome || {}).objections || '')}"></label>
      <label class="field"><span>Desired automation / solution</span><input type="text" name="o_desired_automation" value="${esc((mt.outcome || {}).desired_automation || '')}"></label>
      <label class="field"><span>Budget information (if volunteered)</span><input type="text" name="o_budget_information" value="${esc((mt.outcome || {}).budget_information || '')}"></label>
      <label class="field"><span>Follow-up date</span><input type="date" name="o_follow_up_date" value="${esc((mt.outcome || {}).follow_up_date || '')}"></label>
      <label class="field span-2"><span>Next steps</span><textarea name="o_next_steps">${esc((mt.outcome || {}).next_steps || '')}</textarea></label>
    </div></details>` : ''}
    <div class="error-text hidden" data-x="err"></div>
  </form>`);
  const foot = el(`<div class="flex"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="save">${editing ? 'Save changes' : 'Book meeting'}</button></div>`);
  const m = modal({ title: editing ? `Edit meeting · ${mt.business_name}` : 'Schedule meeting', body, footer: foot });
  foot.querySelector('[data-x=cancel]').addEventListener('click', m.close);
  const showErr = (msg) => { const er = body.querySelector('[data-x=err]'); er.textContent = msg; er.classList.remove('hidden'); };
  body.querySelector('[data-x=check]').addEventListener('click', async () => {
    const v = formValues(body); const out = body.querySelector('[data-x=avail]');
    out.textContent = 'Checking…';
    try {
      const r = await api.post('/api/meetings/check', { meeting_date: v.meeting_date, start_time: v.start_time, end_time: v.end_time, exclude_id: editing ? mt.id : undefined });
      out.innerHTML = r.available ? '<span class="badge success">Slot available</span>' : `<span class="badge danger">Conflict</span> ${esc(r.conflicts.map((c) => `${c.business_name} (${c.owner_name}, ${String(c.start_time).slice(0, 5)}–${String(c.end_time).slice(0, 5)})`).join('; '))}`;
      if (!v.end_time && r.end_time) body.querySelector('[name=end_time]').value = r.end_time;
    } catch (e) { out.textContent = e.message; }
  });
  foot.querySelector('[data-x=save]').addEventListener('click', async () => {
    const v = formValues(body);
    const payload = {};
    const outcome = {};
    for (const [k, val] of Object.entries(v)) { if (k.startsWith('o_')) { if (val) outcome[k.slice(2)] = val; } else payload[k] = val; }
    if (editing && Object.keys(outcome).length) payload.outcome = outcome;
    if (!editing && contact) payload.business_contact_id = contact.id;
    if (!editing) payload.idempotency_key = `ui-${state.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const btn = foot.querySelector('[data-x=save]'); setBusy(btn, true, 'Saving…');
    try {
      const r = editing ? await api.patch(`/api/meetings/${mt.id}`, payload) : await api.post('/api/meetings', payload);
      toast(editing ? 'Meeting updated' : 'Meeting booked on the shared calendar', 'success');
      m.close(); if (onSaved) onSaved(r.meeting);
    } catch (e) {
      let msg = e.message;
      if (e.code === 'conflict' && e.details && e.details.conflicts) msg += ' — ' + e.details.conflicts.map((c) => `${c.business_name} (${c.owner_name}, ${String(c.start_time).slice(0, 5)}–${String(c.end_time).slice(0, 5)})`).join('; ');
      showErr(msg); setBusy(btn, false);
    }
  });
}

export function meetingDetailsModal(meeting, onChanged) {
  const mt = meeting;
  const body = html`<dl class="kv">
    <dt>Business</dt><dd><b>${mt.business_name}</b> ${mt.business_contact_id ? raw(`<a href="#/contact/${mt.business_contact_id}" class="small">open contact</a>`) : raw('')}</dd>
    <dt>When</dt><dd>${fmtDate(mt.meeting_date, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })} · ${String(mt.start_time).slice(0, 5)}–${String(mt.end_time).slice(0, 5)}</dd>
    <dt>Type</dt><dd>${MEETING_TYPES[mt.meeting_type] || mt.meeting_type}</dd>
    <dt>Status</dt><dd>${raw(badge(MEETING_STATUS[mt.meeting_status] || mt.meeting_status, mt.meeting_status === 'cancelled' ? 'danger' : mt.meeting_status === 'completed' ? 'success' : 'primary'))}</dd>
    <dt>Meeting owner</dt><dd>${mt.owner_name} <span class="faint small">(created by ${mt.created_by_name})</span></dd>
    <dt>Contact person</dt><dd>${mt.contact_person || '—'}</dd>
    <dt>Phone</dt><dd>${mt.phone_number ? raw(`<a href="${telHref(mt.phone_number)}">${esc(mt.phone_number)}</a>`) : '—'}</dd>
    <dt>Location</dt><dd>${mt.location || '—'}</dd>
    <dt>Online link</dt><dd>${mt.online_link ? raw(`<a href="${esc(mt.online_link)}" target="_blank" rel="noopener">${esc(mt.online_link)}</a>`) : '—'}</dd>
    <dt>Notes</dt><dd>${mt.notes || '—'}</dd>
    ${mt.outcome && Object.keys(mt.outcome).length ? html`<dt>Outcome</dt><dd><div class="note-block">${Object.entries(mt.outcome).filter(([k]) => !['recorded_by', 'recorded_at'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('\n')}</div></dd>` : raw('')}
  </dl>`;
  const foot = el(`<div class="flex">${mt.can_manage && mt.meeting_status !== 'cancelled' ? '<button class="btn danger sm" data-x="cancelm">Cancel meeting</button>' : ''}${mt.can_manage ? '<button class="btn primary" data-x="edit">Edit / record outcome</button>' : ''}<button class="btn" data-x="close">Close</button></div>`);
  const m = modal({ title: 'Meeting details', body, footer: foot });
  foot.querySelector('[data-x=close]').addEventListener('click', m.close);
  const editBtn = foot.querySelector('[data-x=edit]'); if (editBtn) editBtn.addEventListener('click', () => { m.close(); openMeetingModal({ meeting: mt, onSaved: onChanged }); });
  const cBtn = foot.querySelector('[data-x=cancelm]'); if (cBtn) cBtn.addEventListener('click', async () => {
    const { confirmDialog } = await import('../ui.js');
    if (!(await confirmDialog({ title: 'Cancel meeting', message: `Cancel the meeting with ${mt.business_name}? The record is kept as cancelled.`, confirmText: 'Cancel meeting', danger: true }))) return;
    try { await api.del(`/api/meetings/${mt.id}`); toast('Meeting cancelled', 'success'); m.close(); if (onChanged) onChanged(); } catch (e) { toast(e.message, 'error'); }
  });
}

export function contactActionsHtml(c) {
  return `<div class="flex flex-wrap gap-6">
    <a class="btn sm" href="#/contact/${c.id}">Open</a>
    ${c.phone ? `<a class="btn sm success" href="${telHref(c.phone)}">📞 Call</a><a class="btn sm" href="${waHref(c.phone)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
    <button class="btn sm primary" data-act="call">Record Call</button>
    <button class="btn sm" data-act="followup">Add Follow-Up</button>
    <button class="btn sm" data-act="meeting">Schedule Meeting</button>
    <a class="btn sm ghost" href="#/contact/${c.id}">View History</a>
  </div>`;
}

export function bindContactActions(container, contact, onChanged) {
  container.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'call') openRecordCallModal(contact, onChanged);
    if (b.dataset.act === 'followup') openFollowUpModal(contact, onChanged);
    if (b.dataset.act === 'meeting') openMeetingModal({ contact, onSaved: onChanged });
  }));
}
