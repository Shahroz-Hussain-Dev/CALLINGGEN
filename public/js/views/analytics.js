import { api } from '../api.js';
import { esc, html, raw, join, badge, panelBadge, progressBar, tileHtml, num, pct, fmtDate, emptyState, STATUS_LABELS } from '../ui.js';

export async function renderAnalytics(root) {
  const d = await api.get('/api/admin/analytics');
  const t = d.totals; const bp = d.by_panel;
  const maxCalls = Math.max(1, ...d.daily_calls.map((x) => x.calls));
  const panelCard = (key, label) => html`<div class="card"><div class="card-head"><h2>${label}</h2>${raw(panelBadge(key))}</div><div class="grid grid-4 gap-6">${raw(tileHtml('Generated', num(bp[key].generated)))}${raw(tileHtml('Called', num(bp[key].called), `${pct(bp[key].called, bp[key].generated)}% of generated`))}${raw(tileHtml('Interested', num(bp[key].interested), `${pct(bp[key].interested, bp[key].called)}% of called`))}${raw(tileHtml('Meetings', num(bp[key].meetings)))}</div></div>`;
  root.innerHTML = html`
    <div class="grid grid-4 mb-3">
      ${raw(tileHtml('Total contacts generated', num(t.contacts_generated), `${num(t.duplicates_rejected)} duplicates rejected`, 'accent-primary'))}
      ${raw(tileHtml('Total contacts called', num(t.contacts_called), `${num(t.total_calls)} calls · ${num(t.calls_today)} today`))}
      ${raw(tileHtml('Interested leads', num(t.interested), `${pct(t.interested, t.contacts_called)}% of called`, 'accent-success'))}
      ${raw(tileHtml('Meetings booked', num(t.meetings_booked)))}
      ${raw(tileHtml('Follow-ups pending', num(t.follow_ups_pending)))}
      ${raw(tileHtml('Contacts remaining', num(t.contacts_remaining), 'in active lists this cycle', 'accent-warning'))}
      ${raw(tileHtml('Current rotation cycle', d.cycle.started ? `#${d.cycle.current_cycle_number}` : '—', d.cycle.started ? `day ${d.cycle.day_of_cycle} of ${d.cycle.rotation_interval_days}` : ''))}
      ${raw(tileHtml('Verified contacts', num(t.verified_contacts), `${num(t.needs_verification_contacts)} need verification`))}
    </div>
    <div class="grid grid-2 mb-3">${panelCard('strategy', 'Strategy Leads performance')}${panelCard('service', 'Service Sales performance')}</div>
    <div class="grid grid-2 mb-3">
      <div class="card"><div class="card-head"><h2>Calls per day (last 14 days)</h2></div><div class="bars">${join(d.daily_calls, (x) => html`<div class="bar" title="${fmtDate(x.day)}: ${x.calls} calls, ${x.interested} interested"><i style="height:${Math.round((x.calls / maxCalls) * 100)}%"></i><small>${fmtDate(x.day, { day: '2-digit' })}</small></div>`)}</div><div class="tiny faint">Hover a bar for details. Interested outcomes: ${num(d.daily_calls.reduce((a, x) => a + x.interested, 0))} in this window.</div></div>
      <div class="card"><div class="card-head"><h2>Employee-level activity</h2></div><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Assigned</th><th>Called</th><th>Remaining</th><th>Interested</th><th>Meetings</th><th>Follow-ups</th><th>No answer</th><th>Not interested</th></tr></thead><tbody>${join(d.employees, (e) => html`<tr><td><b>${e.user.display_name}</b></td><td>${num(e.stats.assigned)}</td><td>${num(e.stats.called)}</td><td>${num(e.stats.remaining)}</td><td>${num(e.stats.interested)}</td><td>${num(e.stats.meetings_booked)}</td><td>${num(e.stats.follow_ups_pending)}</td><td>${num(e.stats.no_answer)}</td><td>${num(e.stats.not_interested)}</td></tr>`)}</tbody></table></div></div>
    </div>
    <div class="grid grid-2 mb-3">
      <div class="card"><div class="card-head"><h2>Active lists & completion</h2></div>${d.active_lists.length ? raw(d.active_lists.map((l) => `<div class="hbar"><span class="truncate">${esc(l.list_code)} · ${esc(l.current_owner_name)}</span>${progressBar(l.stats.processed_this_cycle, l.stats.total || 1, l.contact_type)}<span>${l.stats.completion_pct}%</span></div>`).join('')) : raw(emptyState('📋', 'No active lists'))}</div>
      <div class="card"><div class="card-head"><h2>Status breakdown</h2></div><div class="table-wrap"><table><thead><tr><th>Status</th><th>Strategy</th><th>Service</th></tr></thead><tbody>${join(Object.keys(STATUS_LABELS), (s) => { const f = (tp) => (d.status_breakdown.find((x) => x.status === s && x.contact_type === tp) || { count: 0 }).count; return html`<tr><td>${STATUS_LABELS[s]}</td><td>${num(f('strategy'))}</td><td>${num(f('service'))}</td></tr>`; })}</tbody></table></div></div>
    </div>
    <div class="card"><div class="card-head"><h2>Niche performance</h2></div>${d.niche_performance.length ? html`<div class="table-wrap"><table><thead><tr><th>Niche</th><th>Panel</th><th>Contacts</th><th>Called</th><th>Interested</th><th>Meetings</th><th>Interest rate</th></tr></thead><tbody>${join(d.niche_performance, (n) => html`<tr><td>${n.niche}</td><td>${raw(panelBadge(n.contact_type))}</td><td>${num(n.contacts)}</td><td>${num(n.called)}</td><td>${num(n.interested)}</td><td>${num(n.meetings)}</td><td>${pct(n.interested, n.called)}%</td></tr>`)}</tbody></table></div>` : raw(emptyState('📈', 'No data yet'))}</div>`;
}
