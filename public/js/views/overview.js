import { api } from '../api.js';
import { el, esc, html, raw, join, tileHtml, progressBar, fmtDate, fmtTime, num, emptyState, badge, panelBadge, telHref, MEETING_TYPES } from '../ui.js';
import { state, updateCyclePill } from '../app.js';

function listCard(l) {
  const s = l.stats || {};
  const gen = l.generation_progress || {};
  const generating = l.list_status === 'generating';
  return html`<div class="card tight">
    <div class="flex-between"><div><b>${l.list_code}</b> ${raw(panelBadge(l.contact_type))} ${l.is_current_cycle ? raw(badge('Current cycle', 'primary')) : raw(badge(`Received · cycle ${l.cycle_number}`, 'info'))}</div><a class="btn xs" href="#/${l.contact_type}">Open panel</a></div>
    <div class="small muted mt-1">${l.contact_count}/${l.target_size} contacts · ${s.processed_this_cycle || 0} processed this cycle · ${s.remaining || 0} remaining${generating ? raw(` · <span class="badge warning">generating ${gen.saved || 0}/${gen.target || l.target_size}</span>`) : raw('')}</div>
    <div class="mt-1">${raw(progressBar(s.processed_this_cycle || 0, s.total || 1, l.contact_type))}</div>
  </div>`;
}

export async function renderOverview(root) {
  const data = await api.get('/api/overview');
  updateCyclePill(data.cycle);
  const me = data.me;
  const c = data.cycle;
  const isOwner = state.user.role === 'owner';
  const cycleText = c.started ? `Cycle ${c.current_cycle_number} · Day ${c.day_of_cycle} of ${c.rotation_interval_days} · ${c.rotation_due ? 'rotation due now' : `${c.days_remaining} day(s) until rotation`}` : 'No cycle yet — generate your first list to start the three-day cycle';
  root.innerHTML = html`
    <div class="flex-between mb-3"><div><h1>Welcome back, ${state.user.display_name}</h1><div class="muted">${cycleText}${c.next_rotation_at ? ` · next rotation ${fmtDate(c.next_rotation_at, { weekday: 'short', day: '2-digit', month: 'short' })}` : ''}</div></div>
      <div class="flex flex-wrap"><a class="btn strategy" href="#/strategy">✦ Strategy Leads</a><a class="btn service" href="#/service">⚙ Service Sales</a><a class="btn" href="#/meetings">📅 Calendar</a></div></div>
    <div class="grid grid-4 mb-3">
      ${raw(tileHtml("Today's calls", num(me.calls_today), `${num(me.total_calls)} calls in total`, 'accent-primary'))}
      ${raw(tileHtml('Contacts completed', num(me.processed_this_cycle), 'processed this cycle', 'accent-success'))}
      ${raw(tileHtml('Contacts remaining', num(me.remaining), `of ${num(me.assigned)} assigned`, 'accent-warning'))}
      ${raw(tileHtml('Interested leads', num(me.interested), 'from your calls', 'accent-success'))}
      ${raw(tileHtml('Meetings booked', num(me.meetings_booked), `${num(me.meetings_upcoming)} upcoming`))}
      ${raw(tileHtml('Follow-ups due', num(me.follow_ups.today + me.follow_ups.overdue), `${num(me.follow_ups.overdue)} overdue · ${num(me.follow_ups.upcoming)} upcoming`, me.follow_ups.overdue ? 'accent-danger' : ''))}
      ${raw(tileHtml('Rotation cycle', c.started ? `#${c.current_cycle_number}` : '—', c.started ? `Day ${c.day_of_cycle} of ${c.rotation_interval_days}` : 'not started'))}
      ${raw(tileHtml('Days remaining', c.started ? String(c.days_remaining) : '—', c.started ? (c.rotation_due ? 'rotation due now' : 'in current cycle') : 'start by generating a list'))}
    </div>
    <div class="grid grid-2">
      <div class="card"><div class="card-head"><h2>My active lists</h2><span class="small muted">${data.my_lists.length} list(s)</span></div>
        ${data.my_lists.length ? raw('<div class="col">' + data.my_lists.map(listCard).join('') + '</div>') : raw(emptyState('📋', 'No active lists yet', 'Open a panel and click Generate Contacts to build your first 50-contact list.'))}
      </div>
      <div class="col">
        <div class="card"><div class="card-head"><h2>Follow-ups due</h2><a class="small" href="#/followups">View all</a></div>
          ${data.due_follow_ups.length ? html`<div class="table-wrap"><table><tbody>${join(data.due_follow_ups, (f) => html`<tr><td><a href="#/contact/${f.contact_id}"><b>${f.business_name}</b></a><span class="sub">${f.reason || ''}</span></td><td class="nowrap">${fmtDate(f.follow_up_date)} ${fmtTime(f.follow_up_time)}</td><td>${f.phone ? raw(`<a class="btn xs" href="${telHref(f.phone)}">Call</a>`) : raw('')}</td></tr>`)}</tbody></table></div>` : raw(emptyState('✅', 'Nothing due today'))}
        </div>
        <div class="card"><div class="card-head"><h2>Upcoming meetings (team)</h2><a class="small" href="#/meetings">Calendar</a></div>
          ${data.upcoming_meetings.length ? html`<div class="table-wrap"><table><tbody>${join(data.upcoming_meetings, (m) => html`<tr><td><b>${m.business_name}</b><span class="sub">${MEETING_TYPES[m.meeting_type] || m.meeting_type} · ${m.owner_name}</span></td><td class="nowrap">${fmtDate(m.meeting_date, { weekday: 'short', day: '2-digit', month: 'short' })}<span class="sub">${fmtTime(m.start_time)}–${fmtTime(m.end_time)}</span></td></tr>`)}</tbody></table></div>` : raw(emptyState('📅', 'No upcoming meetings'))}
        </div>
      </div>
    </div>
    ${isOwner && data.team ? raw(ownerSection(data)) : raw('')}`;
}

function ownerSection(data) {
  const t = data.team.totals;
  const bp = data.team.by_panel;
  return html`<div class="section-title"><h2>Team overview</h2><div class="line"></div><a class="btn sm" href="#/analytics">Full analytics</a></div>
    <div class="grid grid-4 mb-3">
      ${raw(tileHtml('Leads generated', num(t.contacts_generated), `${num(bp.strategy.generated)} strategy · ${num(bp.service.generated)} service`))}
      ${raw(tileHtml('Leads called', num(t.contacts_called), `${num(t.calls_today)} calls today`))}
      ${raw(tileHtml('Meetings', num(t.meetings_booked), `${num(bp.strategy.meetings)} strategy · ${num(bp.service.meetings)} service`))}
      ${raw(tileHtml('Follow-ups pending', num(t.follow_ups_pending), `${num(t.contacts_remaining)} contacts remaining`))}
    </div>
    <div class="grid grid-3 mb-3">${join(data.team.employees, (e) => html`<div class="card tight"><div class="flex-between"><b>${e.user.display_name}</b>${raw(badge(e.user.role === 'owner' ? 'Owner' : 'Employee', e.user.role === 'owner' ? 'primary' : 'neutral'))}</div>
      <div class="grid grid-2 mt-2 small"><div><span class="muted">Assigned</span><br><b>${num(e.stats.assigned)}</b></div><div><span class="muted">Called</span><br><b>${num(e.stats.called)}</b></div><div><span class="muted">Remaining</span><br><b>${num(e.stats.remaining)}</b></div><div><span class="muted">Interested</span><br><b>${num(e.stats.interested)}</b></div><div><span class="muted">Meetings</span><br><b>${num(e.stats.meetings_booked)}</b></div><div><span class="muted">Follow-ups</span><br><b>${num(e.stats.follow_ups_pending)}</b></div></div></div>`)}</div>
    <div class="card"><div class="card-head"><h2>Active lists (all employees)</h2><a class="small" href="#/rotation">Rotation management</a></div>
      ${data.all_lists.length ? html`<div class="table-wrap"><table><thead><tr><th>List</th><th>Panel</th><th>Owner</th><th>Cycle</th><th>Contacts</th><th>Progress</th><th>Status</th></tr></thead><tbody>${join(data.all_lists, (l) => html`<tr><td><b>${l.list_code}</b></td><td>${raw(panelBadge(l.contact_type))}</td><td>${l.current_owner_name}<span class="sub">from ${l.original_owner_name}</span></td><td>${l.cycle_number}</td><td>${l.contact_count}/${l.target_size}</td><td style="min-width:140px">${raw(progressBar(l.stats.processed_this_cycle, l.stats.total || 1, l.contact_type))}<span class="sub">${l.stats.completion_pct}% processed</span></td><td>${raw(badge(l.list_status, l.list_status === 'active' ? 'success' : 'warning'))}</td></tr>`)}</tbody></table></div>` : raw(emptyState('📋', 'No active lists'))}
    </div>`;
}
