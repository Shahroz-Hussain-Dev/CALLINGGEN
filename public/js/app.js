import { api } from './api.js';
import { el, esc, toast, initials, html, raw, modal } from './ui.js';
import { renderOverview } from './views/overview.js';
import { renderPanel } from './views/panel.js';
import { renderContactDetail } from './views/contact.js';
import { renderContacts } from './views/contacts.js';
import { renderRotation } from './views/rotation.js';
import { renderEmployees } from './views/employees.js';
import { renderMeetings } from './views/meetings.js';
import { renderFollowUps } from './views/followups.js';
import { renderAnalytics } from './views/analytics.js';
import { renderSettings } from './views/settings.js';

export const state = { user: null, cycle: null, app: null, users: [] };

const NAV = [
  { key: 'overview', label: 'Overview', ico: '◫', path: '#/overview', roles: ['employee', 'owner'] },
  { key: 'strategy', label: 'Strategy Leads', ico: '✦', path: '#/strategy', roles: ['employee', 'owner'], cls: 'strategy' },
  { key: 'service', label: 'Service Sales Leads', ico: '⚙', path: '#/service', roles: ['employee', 'owner'], cls: 'service' },
  { key: 'contacts', label: 'All Contacts', ico: '☰', path: '#/contacts', roles: ['owner'] },
  { key: 'rotation', label: 'Contact Rotation', ico: '↻', path: '#/rotation', roles: ['owner'] },
  { key: 'employees', label: 'Employee Activity', ico: '👥', path: '#/employees', roles: ['owner'] },
  { key: 'meetings', label: 'Meeting Scheduler', ico: '📅', path: '#/meetings', roles: ['employee', 'owner'] },
  { key: 'followups', label: 'Follow-Ups', ico: '⏰', path: '#/followups', roles: ['employee', 'owner'] },
  { key: 'analytics', label: 'Team Analytics', ico: '📈', path: '#/analytics', roles: ['owner'] },
  { key: 'settings', label: 'Settings', ico: '⚒', path: '#/settings', roles: ['employee', 'owner'] },
];

const ROUTES = [
  { re: /^#\/overview$/, view: renderOverview, title: 'Overview', key: 'overview' },
  { re: /^#\/strategy$/, view: (root) => renderPanel(root, 'strategy'), title: 'Strategy Leads', key: 'strategy' },
  { re: /^#\/service$/, view: (root) => renderPanel(root, 'service'), title: 'Service Sales Leads', key: 'service' },
  { re: /^#\/contacts$/, view: renderContacts, title: 'All Contacts', key: 'contacts', owner: true },
  { re: /^#\/contact\/([0-9a-f-]{36})$/, view: (root, m) => renderContactDetail(root, m[1]), title: 'Contact', key: null },
  { re: /^#\/rotation$/, view: renderRotation, title: 'Contact Rotation Management', key: 'rotation', owner: true },
  { re: /^#\/employees$/, view: renderEmployees, title: 'Employee Activity', key: 'employees', owner: true },
  { re: /^#\/meetings$/, view: renderMeetings, title: 'Shared Meeting Scheduler', key: 'meetings' },
  { re: /^#\/followups$/, view: renderFollowUps, title: 'Follow-Ups', key: 'followups' },
  { re: /^#\/analytics$/, view: renderAnalytics, title: 'Team Analytics', key: 'analytics', owner: true },
  { re: /^#\/settings(?:\/([\w-]+))?$/, view: (root, m) => renderSettings(root, m[1]), title: 'Settings', key: 'settings' },
];

const root = document.getElementById('app');
let currentViewCleanup = null;

function renderLogin(message) {
  document.title = 'Sign in · LATechS Sales OS';
  root.innerHTML = '';
  const screen = el(`<div class="login-screen"><div class="login-card">
    <div class="brand mb-3"><div class="brand-mark">L</div><div>LATechS Sales OS<small>Lead generation · Sales · Meetings</small></div></div>
    <h2>Sign in</h2><p class="muted small">Use your LATechS account. Usernames are not case-sensitive.</p>
    ${message ? `<div class="warn-box mb-2">${esc(message)}</div>` : ''}
    <form class="col" id="loginForm" autocomplete="on">
      <label class="field"><span>Username</span><input type="text" name="username" required autocomplete="username" autofocus></label>
      <label class="field"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
      <div class="error-text hidden" id="loginError"></div>
      <button class="btn primary block mt-2" type="submit">Sign in</button>
    </form></div></div>`);
  root.appendChild(screen);
  const form = screen.querySelector('#loginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const err = form.querySelector('#loginError');
    err.classList.add('hidden');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in…';
    try {
      const { user } = await api.post('/api/auth/login', { username: form.username.value, password: form.password.value });
      state.user = user;
      await boot();
    } catch (e2) {
      err.textContent = e2.message; err.classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });
}

function renderShell() {
  root.innerHTML = '';
  const u = state.user;
  const items = NAV.filter((n) => n.roles.includes(u.role));
  const shell = el(`<div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-head"><div class="brand"><div class="brand-mark">L</div><div>LATechS<small>Sales Operating System</small></div></div></div>
      <nav class="nav" id="nav">
        <div class="nav-label">${u.role === 'owner' ? 'Owner dashboard' : 'Employee dashboard'}</div>
        ${items.map((n) => `<a href="${n.path}" data-key="${n.key}" class="${n.cls || ''}"><span class="ico">${n.ico}</span>${esc(n.label)}${n.key === 'followups' ? '<span class="nav-badge" id="fuBadge"></span>' : ''}</a>`).join('')}
      </nav>
      <div class="sidebar-foot"><div class="user-chip"><div class="avatar">${esc(initials(u.display_name))}</div><div class="grow truncate"><div><b>${esc(u.display_name)}</b></div><div class="small muted">${u.role === 'owner' ? 'Owner / Administrator' : 'Employee'}</div></div><button class="btn ghost sm" id="logoutBtn" title="Sign out">⎋</button></div></div>
    </aside>
    <div class="main">
      <header class="topbar"><button class="btn ghost menu-btn" id="menuBtn" aria-label="Menu">☰</button><h1 id="pageTitle">Overview</h1><div class="grow"></div><div class="cycle-pill" id="cyclePill"></div></header>
      <div class="content" id="view"></div>
    </div></div>`);
  root.appendChild(shell);
  shell.querySelector('#logoutBtn').addEventListener('click', async () => { try { await api.post('/api/auth/logout'); } catch (_) { /* ignore */ } state.user = null; location.hash = '#/overview'; renderLogin('You have been signed out.'); });
  shell.querySelector('#menuBtn').addEventListener('click', () => toggleSidebar(true));
  shell.querySelector('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) toggleSidebar(false); });
  updateCyclePill();
}

function toggleSidebar(open) {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  let bd = document.querySelector('.sidebar-backdrop');
  if (open) { sb.classList.add('open'); if (!bd) { bd = el('<div class="sidebar-backdrop"></div>'); bd.addEventListener('click', () => toggleSidebar(false)); document.body.appendChild(bd); } }
  else { sb.classList.remove('open'); if (bd) bd.remove(); }
}

export function updateCyclePill(cycle) {
  if (cycle) state.cycle = cycle;
  const pill = document.getElementById('cyclePill');
  const c = state.cycle;
  if (!pill) return;
  if (!c || !c.started) { pill.innerHTML = '<span class="dot muted"></span><span>No rotation cycle yet</span>'; return; }
  const dotCls = c.rotation_due ? 'danger' : c.days_remaining <= 1 ? 'warn' : '';
  const rot = c.rotation_due ? 'Rotation due now' : c.days_remaining === 0 ? `Rotation in ${c.hours_remaining} h` : `Rotation in ${c.days_remaining} day${c.days_remaining === 1 ? '' : 's'}`;
  pill.innerHTML = `<span class="dot ${dotCls}"></span><span>Cycle <b>${c.current_cycle_number}</b></span><span class="opt">· Day ${c.day_of_cycle} of ${c.rotation_interval_days}</span><span>· ${esc(rot)}</span>`;
}

export async function refreshFollowUpBadge() {
  try {
    const s = await api.get('/api/follow-ups/summary');
    const b = document.getElementById('fuBadge');
    if (b) { const n = s.today + s.overdue; b.textContent = n ? String(n) : ''; b.classList.toggle('hidden', !n); }
  } catch (_) { /* ignore */ }
}

async function route() {
  if (!state.user) return;
  const hash = location.hash || '#/overview';
  const match = ROUTES.map((r) => ({ r, m: r.re.exec(hash) })).find((x) => x.m);
  const view = document.getElementById('view');
  if (!view) return;
  if (currentViewCleanup) { try { currentViewCleanup(); } catch (_) { /* ignore */ } currentViewCleanup = null; }
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
  if (!match) { location.hash = '#/overview'; return; }
  if (match.r.owner && state.user.role !== 'owner') { toast('That page is only available to the administrator', 'warning'); location.hash = '#/overview'; return; }
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.key === match.r.key));
  document.getElementById('pageTitle').textContent = match.r.title;
  document.title = `${match.r.title} · LATechS Sales OS`;
  view.innerHTML = '<div class="loading"><span class="spinner lg"></span> Loading…</div>';
  window.scrollTo(0, 0);
  try {
    const cleanup = await match.r.view(view, match.m);
    if (typeof cleanup === 'function') currentViewCleanup = cleanup;
  } catch (err) {
    if (err.status === 401) return;
    view.innerHTML = '';
    view.appendChild(el(`<div class="error-box"><b>Could not load this page.</b> ${esc(err.message)}<div class="mt-2"><button class="btn sm" onclick="location.reload()">Reload</button></div></div>`));
  }
  refreshFollowUpBadge();
}

async function boot() {
  try {
    const me = await api.get('/api/me');
    state.user = me.user; state.cycle = me.cycle; state.app = me.app;
    try { state.users = (await api.get('/api/users')).items; } catch (_) { state.users = []; }
    renderShell();
    if (!location.hash) location.hash = '#/overview';
    await route();
    if (state.user.must_change_password) {
      const m = modal({ title: 'Please change your initial password', body: html`<p>You are signed in with an initial password. For security, set a personal password now in <a href="#/settings/account">Settings → Account</a>.</p>`, size: 'narrow' });
      m.body.querySelector('a').addEventListener('click', () => m.close());
    }
  } catch (err) {
    if (err.status === 401) renderLogin();
    else renderLogin(`Could not connect: ${err.message}`);
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('auth:expired', () => { if (state.user) { state.user = null; renderLogin('Your session has expired. Please sign in again.'); } });
setInterval(async () => { if (!state.user) return; try { const me = await api.get('/api/me'); updateCyclePill(me.cycle); } catch (_) { /* ignore */ } }, 5 * 60 * 1000);
boot();
