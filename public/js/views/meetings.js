import { api } from '../api.js';
import { esc, html, raw, join, toast, badge, fmtDate, fmtTime, todayStr, addDaysStr, MEETING_TYPES } from '../ui.js';
import { state } from '../app.js';
import { openMeetingModal, meetingDetailsModal } from './shared.js';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function startOfWeek(dateStr) { const d = new Date(dateStr + 'T00:00:00'); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return toStr(d); }
function toStr(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function monthRange(dateStr) { const d = new Date(dateStr + 'T00:00:00'); const first = new Date(d.getFullYear(), d.getMonth(), 1); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0); return { first: toStr(first), last: toStr(last), gridStart: startOfWeek(toStr(first)) }; }
const minutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

export async function renderMeetings(root) {
  const view = { mode: 'week', date: todayStr(), owner: '' };
  root.innerHTML = '<div class="card"><div class="cal-toolbar" id="calBar"></div><div id="cal"></div><div class="legend mt-2" id="legend"></div></div>';
  async function load() {
    let from, to;
    if (view.mode === 'day') { from = to = view.date; }
    else if (view.mode === 'week') { from = startOfWeek(view.date); to = addDaysStr(from, 6); }
    else { const r = monthRange(view.date); from = r.gridStart; to = addDaysStr(r.gridStart, 41); }
    const res = await api.get('/api/meetings' + api.qs({ from, to, owner_id: view.owner }));
    const items = res.items;
    const title = view.mode === 'day' ? fmtDate(view.date, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) : view.mode === 'week' ? `${fmtDate(from, { day: '2-digit', month: 'short' })} – ${fmtDate(to, { day: '2-digit', month: 'short', year: 'numeric' })}` : fmtDate(view.date, { month: 'long', year: 'numeric' });
    root.querySelector('#calBar').innerHTML = html`<div class="flex"><div class="btn-group"><button class="btn sm" data-nav="-1">‹</button><button class="btn sm" data-nav="0">Today</button><button class="btn sm" data-nav="1">›</button></div><h2 style="margin:0">${title}</h2></div>
      <div class="flex flex-wrap"><div class="btn-group">${join(['day', 'week', 'month'], (m) => html`<button class="btn sm ${view.mode === m ? 'active' : ''}" data-mode="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`)}</div>
      <select data-owner style="width:150px"><option value="">Everyone</option>${join(state.users, (u) => html`<option value="${u.id}" ${view.owner === u.id ? 'selected' : ''}>${u.display_name}</option>`)}</select>
      <button class="btn primary sm" id="newMeeting">+ New meeting</button></div>`;
    root.querySelector('#legend').innerHTML = Object.entries(MEETING_TYPES).map(([k, v]) => `<span class="${k}">${esc(v)}</span>`).join('') + '<span class="muted">· All meetings are visible to the whole team; only the meeting owner or Shahroz can edit.</span>';
    root.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { const n = Number(b.dataset.nav); if (n === 0) view.date = todayStr(); else if (view.mode === 'month') { const d = new Date(view.date + 'T00:00:00'); d.setMonth(d.getMonth() + n); view.date = toStr(d); } else view.date = addDaysStr(view.date, n * (view.mode === 'week' ? 7 : 1)); load(); }));
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { view.mode = b.dataset.mode; load(); }));
    root.querySelector('[data-owner]').addEventListener('change', (e) => { view.owner = e.target.value; load(); });
    root.querySelector('#newMeeting').addEventListener('click', () => openMeetingModal({ date: view.date, onSaved: load }));
    const cal = root.querySelector('#cal');
    const byDay = {};
    for (const m of items) (byDay[m.meeting_date] = byDay[m.meeting_date] || []).push(m);
    const evt = (m) => `<div class="evt ${esc(m.meeting_type)} ${m.meeting_status === 'cancelled' ? 'cancelled' : ''}" data-m="${m.id}" title="${esc(m.business_name)} · ${esc(m.owner_name)}">${esc(fmtTime(m.start_time))} ${esc(m.business_name)} <span class="faint">· ${esc(m.owner_name)}</span></div>`;
    if (view.mode === 'month') {
      const r = monthRange(view.date);
      const cur = new Date(view.date + 'T00:00:00').getMonth();
      let cells = '';
      for (let i = 0; i < 42; i++) {
        const ds = addDaysStr(r.gridStart, i); const d = new Date(ds + 'T00:00:00');
        cells += `<div class="cal-day ${d.getMonth() !== cur ? 'other' : ''} ${ds === todayStr() ? 'today' : ''}" data-day="${ds}"><div class="daynum">${d.getDate()}</div>${(byDay[ds] || []).map(evt).join('')}</div>`;
      }
      cal.innerHTML = `<div class="cal-month">${DOW.map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>`;
      cal.querySelectorAll('.cal-day').forEach((c) => c.addEventListener('dblclick', () => openMeetingModal({ date: c.dataset.day, onSaved: load })));
    } else {
      const days = view.mode === 'day' ? [view.date] : Array.from({ length: 7 }, (_, i) => addDaysStr(from, i));
      const startH = 8, endH = 21;
      let hdr = '<div class="hdr"></div>' + days.map((ds) => `<div class="hdr ${ds === todayStr() ? 'today' : ''}">${fmtDate(ds, { weekday: 'short', day: '2-digit', month: 'short' })}</div>`).join('');
      let rows = '';
      for (let h = startH; h < endH; h++) {
        rows += `<div class="hour">${String(h).padStart(2, '0')}:00</div>` + days.map((ds) => {
          const evs = (byDay[ds] || []).filter((m) => Math.floor(minutes(m.start_time) / 60) === h);
          const inner = evs.map((m) => { const top = (minutes(m.start_time) % 60) / 60 * 48; const height = Math.max(22, (minutes(m.end_time) - minutes(m.start_time)) / 60 * 48 - 2); return `<div class="evt abs ${esc(m.meeting_type)} ${m.meeting_status === 'cancelled' ? 'cancelled' : ''}" data-m="${m.id}" style="top:${top}px;height:${height}px">${esc(fmtTime(m.start_time))}–${esc(fmtTime(m.end_time))} ${esc(m.business_name)}<br><span class="faint">${esc(m.owner_name)}</span></div>`; }).join('');
          return `<div class="slot" data-day="${ds}" data-hour="${h}">${inner}</div>`;
        }).join('');
      }
      cal.innerHTML = `<div class="cal-week ${view.mode === 'day' ? 'day' : ''}">${hdr}${rows}</div><div class="tiny faint mt-1">Click an empty slot to book at that time. Overlapping meetings are blocked for the whole team.</div>`;
      cal.querySelectorAll('.slot').forEach((s) => s.addEventListener('click', (e) => { if (e.target.closest('.evt')) return; openMeetingModal({ date: s.dataset.day, start: `${String(s.dataset.hour).padStart(2, '0')}:00`, onSaved: load }); }));
    }
    cal.querySelectorAll('[data-m]').forEach((e) => e.addEventListener('click', (ev) => { ev.stopPropagation(); const m = items.find((x) => x.id === e.dataset.m); if (m) meetingDetailsModal(m, load); }));
  }
  await load();
}
