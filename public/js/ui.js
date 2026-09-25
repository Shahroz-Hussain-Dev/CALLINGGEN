/** UI helpers: escaping, DOM building, formatting, toasts, modals, confirm. */
export const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function el(markup) { const t = document.createElement('template'); t.innerHTML = String(markup).trim(); return t.content.firstElementChild; }
/** Marks a string as already-safe HTML. Extends String so it behaves like one everywhere (innerHTML, concatenation, trim). */
class SafeHtml extends String { get s() { return this.valueOf(); } }
export const raw = (s) => new SafeHtml(String(s === undefined || s === null ? '' : s));
/** Tagged template: interpolated values are escaped unless they are SafeHtml (from html``, raw() or join()). */
export function html(strings, ...values) { return raw(strings.reduce((out, s, i) => out + s + (i < values.length ? (values[i] instanceof SafeHtml ? values[i].s : esc(values[i])) : ''), '')); }
export const isSafeHtml = (v) => v instanceof SafeHtml;
export const join = (arr, fn) => raw((arr || []).map((x, i) => fn(x, i)).join(''));

export const STATUS_LABELS = {
  not_called: 'Not Called', no_answer: 'No Answer', call_back_later: 'Call Back Later', interested: 'Interested', not_interested: 'Not Interested',
  meeting_booked: 'Meeting Booked', wrong_number: 'Wrong Number', business_closed: 'Business Closed', follow_up_required: 'Follow-Up Required',
};
export const STATUS_CLASS = { not_called: 'neutral', no_answer: 'warning', call_back_later: 'warning', interested: 'success', not_interested: 'danger', meeting_booked: 'primary', wrong_number: 'danger', business_closed: 'danger', follow_up_required: 'info' };
export const INTEREST_LABELS = { interested: 'Interested', not_interested: 'Not Interested', maybe_follow_up: 'Maybe / Follow Up', meeting_requested: 'Meeting Requested', meeting_booked: 'Meeting Booked', no_clear_interest: 'No Clear Interest' };
export const INTEREST_CLASS = { interested: 'success', not_interested: 'danger', maybe_follow_up: 'warning', meeting_requested: 'primary', meeting_booked: 'primary', no_clear_interest: 'neutral' };
export const DATA_STATUS_LABELS = { verified: 'Verified', partially_verified: 'Partially Verified', estimated: 'Estimated', needs_verification: 'Needs Verification' };
export const DATA_STATUS_CLASS = { verified: 'success', partially_verified: 'info', estimated: 'warning', needs_verification: 'danger' };
export const MEETING_TYPES = { website_development: 'Website Development Meeting', automation_sales: 'Automation Sales Meeting', senior_management: 'Senior Management Meeting', follow_up: 'Follow-Up Meeting', other: 'Other' };
export const MEETING_STATUS = { scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled', rescheduled: 'Rescheduled', no_show: 'No Show' };
export const MEETING_STATUS_CLASS = { scheduled: 'primary', completed: 'success', cancelled: 'danger', rescheduled: 'warning', no_show: 'danger' };
export const FOLLOWUP_STATUS_CLASS = { pending: 'warning', completed: 'success', rescheduled: 'info', cancelled: 'neutral' };
export const PANEL_LABEL = { strategy: 'Strategy Leads', service: 'Service Sales Leads' };

export const badge = (text, cls = 'neutral') => raw(`<span class="badge ${esc(cls)}">${esc(text)}</span>`);
export const statusBadge = (s) => badge(STATUS_LABELS[s] || s || '—', STATUS_CLASS[s] || 'neutral');
export const interestBadge = (s) => (s ? badge(INTEREST_LABELS[s] || s, INTEREST_CLASS[s] || 'neutral') : raw('<span class="faint">—</span>'));
export const dataStatusBadge = (s) => badge(DATA_STATUS_LABELS[s] || s || 'Unknown', DATA_STATUS_CLASS[s] || 'neutral');
export const panelBadge = (t) => badge(PANEL_LABEL[t] || t, t);
export const websiteBadge = (v) => (v === true ? badge('Has website', 'info') : v === false ? badge('No website', 'success') : badge('Website unknown', 'neutral'));

export function fmtDate(v, opts) {
  if (!v) return '—';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00') : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-GB', opts || { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtTime(v) { if (!v) return ''; return String(v).slice(0, 5); }
export function timeAgo(v) {
  if (!v) return '—';
  const diff = Date.now() - new Date(v).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d} d ago`;
  return fmtDate(v);
}
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const addDaysStr = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const initials = (name) => String(name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
export const num = (n) => Number(n || 0).toLocaleString('en-US');
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const telHref = (phone) => (phone ? `tel:${String(phone).replace(/[^\d+]/g, '')}` : null);
export const waHref = (phone) => { if (!phone) return null; let d = String(phone).replace(/\D/g, ''); if (d.startsWith('0')) d = '92' + d.slice(1); return `https://wa.me/${d}`; };

// ---------- toasts ----------
let toastBox;
export function toast(message, type = 'info', ms = 4200) {
  if (!toastBox) { toastBox = el('<div class="toasts"></div>'); document.body.appendChild(toastBox); }
  const t = el(`<div class="toast ${esc(type)}">${esc(message)}</div>`);
  toastBox.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, ms);
}

// ---------- modals ----------
export function modal({ title, body, footer, size = '', onClose }) {
  const backdrop = el(`<div class="modal-backdrop"><div class="modal ${esc(size)}" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="close-x" aria-label="Close">×</button></div>
    <div class="modal-body"></div>${footer ? '<div class="modal-foot"></div>' : ''}</div></div>`);
  const bodyEl = backdrop.querySelector('.modal-body');
  if (typeof body === 'string' || body instanceof SafeHtml) bodyEl.innerHTML = String(body); else if (body) bodyEl.appendChild(body);
  if (footer) { const f = backdrop.querySelector('.modal-foot'); if (typeof footer === 'string' || footer instanceof SafeHtml) f.innerHTML = String(footer); else f.appendChild(footer); }
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.querySelector('.close-x').addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  return { root: backdrop, body: bodyEl, close, foot: backdrop.querySelector('.modal-foot') };
}

export function confirmDialog({ title = 'Please confirm', message, confirmText = 'Confirm', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    const foot = el(`<div class="flex"><button class="btn" data-x="cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="ok" ${requireText ? 'disabled' : ''}>${esc(confirmText)}</button></div>`);
    const body = `<p>${esc(message)}</p>${requireText ? `<label class="field"><span>Type <b>${esc(requireText)}</b> to confirm</span><input type="text" data-x="txt"></label>` : ''}`;
    const m = modal({ title, body, footer: foot, size: 'narrow', onClose: () => resolve(false) });
    if (requireText) m.body.querySelector('[data-x=txt]').addEventListener('input', (e) => { foot.querySelector('[data-x=ok]').disabled = e.target.value.trim() !== requireText; });
    foot.querySelector('[data-x=cancel]').addEventListener('click', () => m.close());
    foot.querySelector('[data-x=ok]').addEventListener('click', () => { const c = m.close; m.close = () => {}; c(); resolve(true); });
  });
}

export function promptDialog({ title, label, placeholder = '', multiline = true, confirmText = 'Save', required = true }) {
  return new Promise((resolve) => {
    const foot = el(`<div class="flex"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="ok">${esc(confirmText)}</button></div>`);
    const body = `<label class="field"><span>${esc(label)}</span>${multiline ? `<textarea data-x="v" placeholder="${esc(placeholder)}"></textarea>` : `<input type="text" data-x="v" placeholder="${esc(placeholder)}">`}</label><div class="error-text mt-1 hidden" data-x="err">This field is required</div>`;
    const m = modal({ title, body, footer: foot, size: 'narrow', onClose: () => resolve(null) });
    const input = m.body.querySelector('[data-x=v]'); setTimeout(() => input.focus(), 30);
    foot.querySelector('[data-x=cancel]').addEventListener('click', () => m.close());
    foot.querySelector('[data-x=ok]').addEventListener('click', () => { const v = input.value.trim(); if (required && !v) { m.body.querySelector('[data-x=err]').classList.remove('hidden'); return; } const c = m.close; m.close = () => {}; c(); resolve(v); });
  });
}

export function formValues(form) {
  const out = {};
  for (const elx of form.querySelectorAll('[name]')) {
    if (elx.type === 'checkbox') out[elx.name] = elx.checked;
    else if (elx.type === 'radio') { if (elx.checked) out[elx.name] = elx.value; }
    else if (elx.multiple) out[elx.name] = [...elx.selectedOptions].map((o) => o.value);
    else out[elx.name] = elx.value;
  }
  return out;
}

export function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${esc(label || 'Working…')}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

export function errorState(message, retry) {
  const box = el(`<div class="error-box"><div><b>Something went wrong.</b> ${esc(message)}</div>${retry ? '<button class="btn sm mt-2" data-x="retry">Try again</button>' : ''}</div>`);
  if (retry) box.querySelector('[data-x=retry]').addEventListener('click', retry);
  return box;
}
export const emptyState = (icon, title, sub) => raw(`<div class="empty"><div class="ico">${esc(icon)}</div><div><b>${esc(title)}</b></div>${sub ? `<div class="small mt-1">${esc(sub)}</div>` : ''}</div>`);
export const loadingState = (label = 'Loading…') => raw(`<div class="loading"><span class="spinner lg"></span> ${esc(label)}</div>`);
export const progressBar = (value, max, cls = '') => raw(`<div class="progress ${esc(cls)}"><span style="width:${max ? Math.min(100, Math.round((value / max) * 100)) : 0}%"></span></div>`);

export function tileHtml(label, value, sub = '', cls = '') { return `<div class="tile ${esc(cls)}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`; }

export function listToText(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? Object.values(x).filter(Boolean).join(' · ') : x)).join(', ') : '—';
  if (typeof v === 'object') return Object.entries(v).filter(([, x]) => x !== null && x !== '' && x !== undefined).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('; ') || '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
