import { api } from '../api.js';
import { esc, html, raw, join, toast, badge, tileHtml, num, fmtDate, fmtTime, emptyState, telHref, promptDialog, FOLLOWUP_STATUS_CLASS, panelBadge, todayStr, addDaysStr } from '../ui.js';
import { state, refreshFollowUpBadge } from '../app.js';

export async function renderFollowUps(root) {
  const view = { due: 'due', status: 'pending', owner: '' };
  root.innerHTML = '<div id="fuTop"></div><div class="card mt-3"><div class="card-head"><h2>Follow-ups</h2><div class="flex flex-wrap" id="fuFilters"></div></div><div id="fuList"></div></div>';
  async function load() {
    const [summary, list] = await Promise.all([api.get('/api/follow-ups/summary'), api.get('/api/follow-ups' + api.qs({ due: view.due === 'all' ? '' : view.due, status: view.due === 'all' ? view.status : '', owner_id: view.owner, limit: 200 }))]);
    root.querySelector('#fuTop').innerHTML = html`<div class="grid grid-4">${raw(tileHtml('Due today', num(summary.today), 'pending follow-ups', 'accent-primary'))}${raw(tileHtml('Overdue', num(summary.overdue), 'need attention', summary.overdue ? 'accent-danger' : ''))}${raw(tileHtml('Upcoming', num(summary.upcoming), 'scheduled ahead'))}${raw(tileHtml('Total pending', num(summary.pending), 'across your contacts'))}</div>`;
    const filters = root.querySelector('#fuFilters');
    filters.innerHTML = html`<div class="btn-group">${join([['due', 'Due now'], ['today', 'Today'], ['overdue', 'Overdue'], ['upcoming', 'Upcoming'], ['all', 'All']], ([k, l]) => html`<button class="btn sm ${view.due === k ? 'active' : ''}" data-due="${k}">${l}</button>`)}</div>
      ${view.due === 'all' ? html`<select data-status style="width:150px"><option value="">Any status</option>${join(['pending', 'completed', 'rescheduled', 'cancelled'], (s) => html`<option value="${s}" ${view.status === s ? 'selected' : ''}>${s}</option>`)}</select>` : raw('')}
      ${state.user.role === 'owner' ? html`<select data-owner style="width:160px"><option value="">All owners</option>${join(state.users, (u) => html`<option value="${u.id}" ${view.owner === u.id ? 'selected' : ''}>${u.display_name}</option>`)}</select>` : raw('')}`;
    filters.querySelectorAll('[data-due]').forEach((b) => b.addEventListener('click', () => { view.due = b.dataset.due; load(); }));
    const st = filters.querySelector('[data-status]'); if (st) st.addEventListener('change', () => { view.status = st.value; load(); });
    const ow = filters.querySelector('[data-owner]'); if (ow) ow.addEventListener('change', () => { view.owner = ow.value; load(); });
    const box = root.querySelector('#fuList');
    if (!list.items.length) { box.innerHTML = emptyState('✅', 'No follow-ups here', 'Follow-ups are created from call records or from a contact page.').s; return; }
    const today = todayStr();
    box.innerHTML = html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Business</th><th>Contact person</th><th>Reason / notes</th><th>Owner</th><th>Status</th><th>Actions</th></tr></thead><tbody>${join(list.items, (f) => html`<tr>
      <td class="nowrap">${fmtDate(f.follow_up_date)} ${fmtTime(f.follow_up_time)}${f.status === 'pending' && f.follow_up_date < today ? raw(' <span class="badge danger">overdue</span>') : f.status === 'pending' && f.follow_up_date === today ? raw(' <span class="badge primary">today</span>') : raw('')}</td>
      <td><a href="#/contact/${f.contact_id}"><b>${f.business_name}</b></a><span class="sub">${raw(panelBadge(f.contact_type))} ${f.city || ''} ${f.phone ? raw(`· <a href="${telHref(f.phone)}">${esc(f.phone)}</a>`) : raw('')}</span></td>
      <td>${f.contact_person || '—'}</td><td>${f.reason || '—'}<span class="sub">${f.notes || ''}</span></td><td>${f.owner_name}${f.previous_owner_id ? raw('<span class="sub">transferred</span>') : raw('')}</td>
      <td>${raw(badge(f.status, FOLLOWUP_STATUS_CLASS[f.status]))}</td>
      <td class="nowrap">${f.status === 'pending' ? raw(`<button class="btn xs success" data-a="completed" data-id="${f.id}">Done</button> <button class="btn xs" data-a="reschedule" data-id="${f.id}">Reschedule</button> <button class="btn xs ghost" data-a="cancelled" data-id="${f.id}">Cancel</button>`) : raw('')}</td></tr>`)}</tbody></table></div>`;
    box.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      try {
        if (b.dataset.a === 'reschedule') {
          const d = await promptDialog({ title: 'Reschedule follow-up', label: 'New date (YYYY-MM-DD)', placeholder: addDaysStr(today, 2), multiline: false, confirmText: 'Reschedule' });
          if (!d) return;
          await api.patch(`/api/follow-ups/${id}`, { status: 'rescheduled', follow_up_date: d });
        } else {
          const notes = b.dataset.a === 'completed' ? await promptDialog({ title: 'Complete follow-up', label: 'Outcome notes (optional)', required: false, confirmText: 'Mark completed' }) : null;
          if (b.dataset.a === 'completed' && notes === null) return;
          await api.patch(`/api/follow-ups/${id}`, { status: b.dataset.a, notes: notes || undefined });
        }
        toast('Follow-up updated', 'success'); load(); refreshFollowUpBadge();
      } catch (e) { toast(e.message, 'error'); }
    }));
  }
  await load();
}
