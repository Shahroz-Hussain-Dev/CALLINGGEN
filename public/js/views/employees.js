import { api } from '../api.js';
import { esc, html, raw, join, badge, panelBadge, progressBar, num, fmtDateTime, timeAgo, emptyState } from '../ui.js';

export async function renderEmployees(root) {
  const [emp, lists, act] = await Promise.all([api.get('/api/admin/employees'), api.get('/api/lists'), api.get('/api/admin/activity?limit=40')]);
  const stat = (l, v) => html`<div><span class="muted small">${l}</span><br><b>${num(v)}</b></div>`; // html`` returns SafeHtml, nests safely
  root.innerHTML = html`<div class="grid grid-3 mb-3">${join(emp.items, (e) => {
      const s = e.stats; const my = lists.items.filter((l) => l.current_owner_id === e.user.id);
      return html`<div class="card"><div class="card-head"><div><h2 style="margin:0">${e.user.display_name}</h2><span class="small muted">${e.user.username} · ${e.user.role === 'owner' ? 'Owner' : 'Employee'} · last call ${s.last_call_at ? timeAgo(s.last_call_at) : 'never'}</span></div>${raw(badge(e.user.account_status, e.user.account_status === 'active' ? 'success' : 'danger'))}</div>
        <div class="grid grid-3 gap-6">${stat('Assigned', s.assigned)}${stat('Called', s.called)}${stat('Remaining', s.remaining)}${stat('Interested', s.interested)}${stat('Meetings', s.meetings_booked)}${stat('Follow-ups', s.follow_ups_pending)}${stat('No answer', s.no_answer)}${stat('Not interested', s.not_interested)}${stat('Calls today', s.calls_today)}</div>
        <div class="mt-2 small"><b>Current cycle:</b> ${emp.current_cycle} · <b>Active lists:</b> ${my.length ? raw(my.map((l) => `${esc(l.list_code)} (${l.stats.processed_this_cycle}/${l.stats.total})`).join(', ')) : raw('<span class="faint">none</span>')}</div>
        ${my.length ? raw(my.map((l) => `<div class="progress-row mt-1"><span style="width:70px">${esc(l.list_code)}</span>${progressBar(l.stats.processed_this_cycle, l.stats.total || 1, l.contact_type)}<span>${l.stats.completion_pct}%</span></div>`).join('')) : raw('')}
      </div>`; })}</div>
    <div class="card"><div class="card-head"><h2>Recent activity (all employees)</h2><a class="small" href="#/settings/audit">Full audit log</a></div>
      ${act.items.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Business / list</th><th>Details</th></tr></thead><tbody>${join(act.items, (a) => html`<tr><td class="nowrap">${fmtDateTime(a.timestamp)}</td><td>${a.user_name || 'System'}</td><td>${raw(badge(a.action.replace(/_/g, ' '), 'neutral'))}</td><td>${a.business_name ? raw(`<a href="#/contact/${a.contact_id}">${esc(a.business_name)}</a>`) : (a.list_name || '—')}</td><td class="small muted">${Object.entries(a.details || {}).filter(([k]) => !['usage', 'errors'].includes(k)).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 160)}</td></tr>`)}</tbody></table></div>` : raw(emptyState('📝', 'No activity yet'))}
    </div>`;
}
