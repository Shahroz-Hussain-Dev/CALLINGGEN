import { api } from '../api.js';
import { esc, html, raw, join, toast, badge, panelBadge, progressBar, tileHtml, fmtDate, fmtDateTime, emptyState, confirmDialog, modal, el, setBusy, formValues } from '../ui.js';
import { state, updateCyclePill } from '../app.js';

export async function renderRotation(root) {
  async function load() {
    const d = await api.get('/api/rotation/overview');
    updateCyclePill(d.cycle);
    const c = d.cycle;
    const byType = (t) => d.active_lists.filter((l) => l.contact_type === t);
    const listRow = (l) => html`<tr><td><b>${l.list_code}</b><span class="sub">${l.list_name}</span></td><td>${raw(panelBadge(l.contact_type))}</td><td><b>${l.current_owner_name}</b></td><td>${l.original_owner_name}</td><td>${l.cycle_number}</td><td>${l.rotation_count} / ${d.settings.list_max_rotations}</td><td>${l.contact_count}/${l.target_size} ${l.list_status === 'generating' ? raw(badge('generating', 'warning')) : raw('')}</td><td style="min-width:130px">${raw(progressBar(l.stats.processed_this_cycle, l.stats.total || 1, l.contact_type))}<span class="sub">${l.stats.processed_this_cycle}/${l.stats.total} processed · ${l.stats.remaining} left</span></td><td>${l.rotation_date ? fmtDate(l.rotation_date, { day: '2-digit', month: 'short' }) : '—'}${l.rotation_count >= d.settings.list_max_rotations ? raw('<span class="sub">will be archived</span>') : raw('')}</td><td><button class="btn xs" data-transfer="${l.id}">Transfer</button></td></tr>`;
    root.innerHTML = html`
      <div class="grid grid-4 mb-3">
        ${raw(tileHtml('Current cycle', c.started ? `#${c.current_cycle_number}` : '—', c.started ? `started ${fmtDate(c.cycle_started_at)}` : 'starts with the first list', 'accent-primary'))}
        ${raw(tileHtml('Next rotation', c.next_rotation_at ? fmtDate(c.next_rotation_at, { weekday: 'short', day: '2-digit', month: 'short' }) : '—', c.started ? (c.rotation_due ? 'Rotation due now' : c.days_remaining === 0 ? `Rotation in ${c.hours_remaining} h` : `Rotation in ${c.days_remaining} day(s)`) : '', c.rotation_due ? 'accent-danger' : 'accent-warning'))}
        ${raw(tileHtml('Day of cycle', c.started ? `${c.day_of_cycle} / ${c.rotation_interval_days}` : '—', `${c.rotation_interval_days}-day cycles · ${c.rotation_enabled ? 'automatic rotation on' : 'automatic rotation OFF'}`))}
        ${raw(tileHtml('Active lists', String(d.active_lists.length), `${byType('strategy').length} strategy · ${byType('service').length} service`))}
      </div>
      <div class="grid grid-2 mb-3">
        <div class="card"><div class="card-head"><h2>Rotation chain</h2><span class="small muted">every ${d.settings.rotation_interval_days} days, both panels</span></div>
          <div class="flex flex-wrap steps-inline">${join(d.chain, (u, i) => html`<div class="chain-node"><span class="chain-num">${i + 1}</span><div><b>${u.display_name}</b><div class="small muted">passes lists to ${u.passes_to}</div></div></div>`)}</div>
          <div class="small muted mt-2">Each list travels the chain once per rotation. After <b>${d.settings.list_max_rotations}</b> rotations a list is archived (complete history kept). Lists rotate in full, even if incomplete; nothing is deleted or reset. New ${d.settings.list_size}-contact lists are ${d.settings.auto_generate_after_rotation ? 'generated automatically' : 'NOT auto-generated'} after each rotation.</div>
          <div class="mt-2"><b>Strategy Leads</b><div class="small">${byType('strategy').length ? raw(byType('strategy').map((l) => `${esc(l.current_owner_name)} → ${esc(l.list_code)}`).join('<br>')) : raw('<span class="faint">no active lists</span>')}</div></div>
          <div class="mt-2"><b>Service Sales</b><div class="small">${byType('service').length ? raw(byType('service').map((l) => `${esc(l.current_owner_name)} → ${esc(l.list_code)}`).join('<br>')) : raw('<span class="faint">no active lists</span>')}</div></div>
        </div>
        <div class="card"><div class="card-head"><h2>Rotation controls</h2></div>
          <div class="col">
            <div class="flex flex-wrap"><button class="btn primary" id="runNow" ${!c.started ? 'disabled' : ''}>${c.rotation_due ? 'Run rotation now (due)' : 'Force rotation now'}</button><span class="small muted">Idempotent: running twice never rotates twice. A rotation transfers every active list to the next person, archives lists that finished the chain, and creates new lists.</span></div>
            <form id="rotSettings" class="form-grid mt-2">
              <label class="field"><span>Rotation interval (days)</span><input type="number" name="rotation_interval_days" min="1" max="30" value="${d.settings.rotation_interval_days}"></label>
              <label class="field"><span>Max rotations per list</span><input type="number" name="list_max_rotations" min="1" max="10" value="${d.settings.list_max_rotations}"></label>
              <label class="field"><span>Contacts per list (max 50)</span><input type="number" name="list_size" min="1" max="50" value="${d.settings.list_size}"></label>
              <div class="col"><label class="check"><input type="checkbox" name="rotation_enabled" ${d.settings.rotation_enabled ? 'checked' : ''}> Automatic rotation enabled</label><label class="check"><input type="checkbox" name="auto_generate_after_rotation" ${d.settings.auto_generate_after_rotation ? 'checked' : ''}> Generate new lists after rotation</label></div>
            </form>
            <div><button class="btn sm" id="saveRot">Save rotation settings</button></div>
            <div class="tiny faint">The scheduled process runs daily via Vercel Cron (or any scheduler calling /api/rotation/cron with the CRON_SECRET) and rotates when a cycle is due. The generation of new lists continues in batches when employees open their panels.</div>
          </div></div>
      </div>
      <div class="card mb-3"><div class="card-head"><h2>Active lists & generation status</h2></div>
        ${d.active_lists.length ? html`<div class="table-wrap"><table><thead><tr><th>List</th><th>Panel</th><th>Current owner</th><th>Original owner</th><th>Cycle</th><th>Rotations</th><th>Contacts</th><th>Progress</th><th>Next rotation</th><th></th></tr></thead><tbody>${join(d.active_lists, listRow)}</tbody></table></div>` : raw(emptyState('📋', 'No active lists', 'Lists are created when employees generate contacts or automatically after a rotation.'))}
      </div>
      <div class="grid grid-2">
        <div class="card"><div class="card-head"><h2>Rotation history</h2></div>
          ${d.history.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>List</th><th>Event</th><th>From</th><th>To</th><th>Cycle</th></tr></thead><tbody>${join(d.history, (h) => html`<tr><td class="nowrap">${fmtDateTime(h.rotation_date)}</td><td><b>${h.list_code}</b> ${raw(panelBadge(h.contact_type))}</td><td>${h.event_type}</td><td>${h.previous_owner_name}</td><td>${h.new_owner_name || 'archived'}</td><td>${h.cycle_number}</td></tr>`)}</tbody></table></div>` : raw(emptyState('↻', 'No rotations yet'))}
        </div>
        <div class="col"><div class="card"><div class="card-head"><h2>Rotation runs (audit)</h2></div>
          ${d.runs.length ? html`<div class="table-wrap"><table><thead><tr><th>Started</th><th>Cycle</th><th>Trigger</th><th>Status</th><th>Rotated / Archived / Created</th></tr></thead><tbody>${join(d.runs, (r) => html`<tr><td class="nowrap">${fmtDateTime(r.started_at)}</td><td>${r.cycle_number}</td><td>${r.trigger_source}${r.triggered_by_name ? ` (${r.triggered_by_name})` : ''}</td><td>${raw(badge(r.status, r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'))}${r.error ? raw(`<span class="sub">${esc(r.error)}</span>`) : raw('')}</td><td>${r.lists_rotated} / ${r.lists_completed} / ${r.lists_created}</td></tr>`)}</tbody></table></div>` : raw('<div class="muted small">No runs recorded.</div>')}</div>
          <div class="card"><div class="card-head"><h2>Completed / archived lists</h2></div>${d.completed_lists.length ? html`<div class="table-wrap"><table><thead><tr><th>List</th><th>Last owner</th><th>Original owner</th><th>Cycle</th><th>Contacts</th></tr></thead><tbody>${join(d.completed_lists, (l) => html`<tr><td><b>${l.list_code}</b> ${raw(panelBadge(l.contact_type))}</td><td>${l.current_owner_name}</td><td>${l.original_owner_name}</td><td>${l.cycle_number}</td><td>${l.contact_count}</td></tr>`)}</tbody></table></div>` : raw('<div class="muted small">None yet. Contacts and history are never deleted.</div>')}</div></div>
      </div>`;
    root.querySelector('#runNow').addEventListener('click', async (e) => {
      const force = !c.rotation_due;
      const ok = await confirmDialog({ title: force ? 'Force rotation now?' : 'Run rotation now?', message: force ? 'The cycle is not due yet. Forcing rotation transfers every active list to the next employee immediately, archives lists that finished the chain, starts a new cycle and creates new lists. This cannot be undone.' : 'This rotates every active list to the next employee, starts the next cycle and creates new lists.', confirmText: force ? 'Force rotation' : 'Rotate now', danger: force, requireText: force ? 'ROTATE' : null });
      if (!ok) return;
      setBusy(e.target, true, 'Rotating…');
      try { const r = await api.post('/api/rotation/run', { force }); if (r.rotated) toast(`Rotation complete: ${r.lists_rotated} rotated, ${r.lists_completed} archived, ${r.lists_created} new lists (cycle ${r.cycle_to})`, 'success', 8000); else toast(r.message || r.reason, 'warning'); await load(); } catch (er) { toast(er.message, 'error', 8000); setBusy(e.target, false); }
    });
    root.querySelector('#saveRot').addEventListener('click', async (e) => {
      const v = formValues(root.querySelector('#rotSettings'));
      setBusy(e.target, true, 'Saving…');
      try { await api.patch('/api/settings/system', v); toast('Rotation settings saved', 'success'); await load(); } catch (er) { toast(er.message, 'error'); setBusy(e.target, false); }
    });
    root.querySelectorAll('[data-transfer]').forEach((b) => b.addEventListener('click', () => {
      const l = d.active_lists.find((x) => x.id === b.dataset.transfer);
      const body = el(`<div class="col"><p>Transfer <b>${esc(l.list_code)}</b> (currently ${esc(l.current_owner_name)}) to another user immediately. History and follow-ups move with it; the current owner loses active access.</p><label class="field"><span>New owner</span><select name="new_owner_id">${state.users.filter((u) => u.id !== l.current_owner_id).map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join('')}</select></label></div>`);
      const foot = el('<div class="flex"><button class="btn" data-x="c">Cancel</button><button class="btn primary" data-x="ok">Transfer list</button></div>');
      const m = modal({ title: 'Manual list transfer', body, footer: foot, size: 'narrow' });
      foot.querySelector('[data-x=c]').addEventListener('click', m.close);
      foot.querySelector('[data-x=ok]').addEventListener('click', async () => { try { await api.post('/api/rotation/transfer', { list_id: l.id, new_owner_id: body.querySelector('select').value }); toast('List transferred', 'success'); m.close(); load(); } catch (er) { toast(er.message, 'error'); } });
    }));
  }
  await load();
}
