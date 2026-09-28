'use strict';
/**
 * PDF export of contact lists (one or several lists in a single document).
 * Access: the owner may export any list; an employee only lists in their current workspace.
 */
const PDFDocument = require('pdfkit');
const db = require('../db');
const { ValidationError } = require('../lib/errors');
const v = require('../lib/validate');
const lists = require('./lists.service');
const criteriaLib = require('../lib/criteria');
const PANEL_LABEL = { strategy: 'Strategy Leads', service: 'Service Sales Leads' };

const PAGE = { size: 'A4', layout: 'landscape', margin: 28 };
const COLUMNS = [
  { key: 'n', label: '#', width: 22 },
  { key: 'business_name', label: 'Business', width: 118 },
  { key: 'niche', label: 'Niche', width: 76 },
  { key: 'city', label: 'City', width: 52 },
  { key: 'phone', label: 'Phone / WhatsApp', width: 82 },
  { key: 'social', label: 'Social profile', width: 118 },
  { key: 'people', label: 'Owner / doctor (own number)', width: 84 },
  { key: 'profile', label: 'Startup profile / opening', width: 108 },
  { key: 'sell', label: 'Sell %', width: 30 },
  { key: 'status', label: 'Data', width: 40 },
  { key: 'source', label: 'Source', width: 76 },
];

function clean(s, max = 400) {
  return String(s === null || s === undefined ? '' : s).replace(/[^\x20-\x7E -ɏ–—‘’“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function shortUrl(u) { return clean(String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), 60); }

function rowFor(c, n) {
  const ops = c.business_operations || {};
  const sp = c.social_profiles || {};
  const socialParts = [];
  for (const k of ['instagram', 'facebook', 'tiktok', 'linkedin']) if (sp[k]) socialParts.push(`${k === 'instagram' ? 'IG' : k === 'facebook' ? 'FB' : k === 'tiktok' ? 'TT' : 'LI'}: ${shortUrl(sp[k])}`);
  const people = [...((c.management_data || {}).owners || []), ...(c.decision_makers || [])].filter((p) => p && p.name).slice(0, 2).map((p) => `${p.name}${p.designation ? ` (${p.designation})` : ''}${p.contact ? ` · ${p.contact}${p.contact_kind === 'direct_mobile' ? ' (own)' : ''}` : ''}`);
  if (ops.direct_contact && ops.direct_contact.number && !people.some((x) => x.includes(ops.direct_contact.number))) people.unshift(`${ops.direct_contact.person}: ${ops.direct_contact.number} (own)`);
  const profile = [];
  if (ops.opening && ops.opening.quote) profile.push(`Opened${ops.opening.opened_on ? ' ' + ops.opening.opened_on : ''}: "${clean(ops.opening.quote, 90)}"`);
  if (ops.female_led === true) profile.push('Female-led');
  else if (ops.female_led === false) profile.push('Male-led');
  if (ops.founded_year) profile.push(`Started ${ops.founded_year}`);
  if (ops.team_size_estimate) profile.push(`~${ops.team_size_estimate} people`);
  else if (c.employee_count_estimate) profile.push(`~${c.employee_count_estimate} people`);
  if (ops.audience && ops.audience.instagram_followers !== null && ops.audience.instagram_followers !== undefined) profile.push(`${Number(ops.audience.instagram_followers).toLocaleString('en-US')} followers`);
  if (Array.isArray(ops.startup_signals) && ops.startup_signals.length) profile.push(`"${clean(ops.startup_signals[0], 70)}"`);
  if (ops.criteria_match === 'confirmed') profile.push('[criteria confirmed]');
  return {
    n: String(n),
    business_name: clean(c.business_name, 80),
    niche: clean(c.niche, 60),
    city: clean(c.city, 30),
    phone: [c.phone, sp.whatsapp && sp.whatsapp !== c.phone ? `WA ${sp.whatsapp}` : null].filter(Boolean).map((x) => clean(x, 30)).join('\n') || '—',
    social: socialParts.join('\n') || '—',
    people: people.map((p) => clean(p, 60)).join('\n') || '—',
    profile: profile.join(' · ') || '—',
    sell: c.sell_score !== null && c.sell_score !== undefined ? `${Math.round(Number(c.sell_score))}%` : '—',
    status: ({ verified: 'Verified', partially_verified: 'Partial', estimated: 'Estimated', needs_verification: 'Check' })[c.data_status] || clean(c.data_status, 20),
    source: (c.source_urls || []).slice(0, 2).map(shortUrl).join('\n') || '—',
  };
}

async function contactsOf(listId) {
  const { rows } = await db.query(
    `SELECT c.* , lc.position FROM list_contacts lc JOIN contacts c ON c.id = lc.contact_id WHERE lc.list_id = $1 ORDER BY lc.position ASC, c.created_at ASC`,
    [listId],
  );
  return rows;
}

/** Builds the PDF. Returns { filename, stream } where stream is the PDFDocument (a readable). */
async function listsPdf(user, { ids, title }) {
  if (!Array.isArray(ids) || !ids.length) throw new ValidationError('ids is required (comma-separated list ids)');
  if (ids.length > 6) throw new ValidationError('At most 6 lists per export');
  const selected = [];
  for (const id of ids) {
    const list = await lists.getForUser(user, v.uuid(id, { field: 'ids' }));
    selected.push({ list, contacts: await contactsOf(list.id) });
  }
  const docTitle = clean(title || (selected.length === 1 ? selected[0].list.list_name : `Lead lists ${selected.map((s) => s.list.list_code).join(' + ')}`), 120);
  const doc = new PDFDocument({ ...PAGE, bufferPages: true, info: { Title: docTitle, Author: 'LATechS Sales OS' } });
  const generatedAt = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi', hour12: false });

  // Cover / summary
  doc.font('Helvetica-Bold').fontSize(20).text(docTitle);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#444').text(`LATechS Sales OS · generated ${generatedAt} (Pakistan time) by ${clean(user.display_name || user.username, 40)}`);
  doc.moveDown(0.8);
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(12).text('Contents');
  doc.moveDown(0.2);
  for (const s of selected) {
    const crit = criteriaLib.describe(s.list.criteria);
    doc.font('Helvetica').fontSize(10).text(`• ${PANEL_LABEL[s.list.contact_type] || s.list.contact_type} — ${s.list.list_code} (${s.list.list_name}): ${s.contacts.length} contacts`);
    doc.fontSize(9).fillColor('#444').text(`   niches: ${(s.list.selected_niches || []).map((n) => n.name).join(', ') || '—'}${crit ? ` · targeting: ${crit}` : ''}`).fillColor('#000');
    doc.moveDown(0.2);
  }
  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Every phone number, social profile, person name and quote in this document was copied from a public web source recorded under "Source". "(own)" marks a number printed next to the owner\'s or doctor\'s name on a public page rather than a reception line. Founding year, opening evidence, team size and leadership are read from those sources and marked where they are estimates. "Sell %" is the weighted sell-probability score (Strategy panel). "Data" shows the verification level: Verified (name + phone confirmed on sources), Partial, Estimated, or Check (needs verification before use).', { width: doc.page.width - PAGE.margin * 2 });
  doc.fillColor('#000');

  for (const s of selected) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(14).text(`${PANEL_LABEL[s.list.contact_type] || s.list.contact_type} — ${s.list.list_code}`);
    doc.font('Helvetica').fontSize(9).fillColor('#444').text(`${s.list.list_name} · current owner ${clean(s.list.current_owner_name, 40)} · ${s.contacts.length} contacts · niches: ${(s.list.selected_niches || []).map((n) => n.name).join(', ') || '—'}`);
    doc.fillColor('#000').moveDown(0.5);
    const rows = s.contacts.map((c, i) => rowFor(c, i + 1));
    if (!rows.length) { doc.font('Helvetica-Oblique').fontSize(10).text('No contacts in this list yet.'); continue; }
    doc.table({
      columnStyles: COLUMNS.map((c) => c.width),
      rowStyles: (i) => (i === 0 ? { backgroundColor: '#1f2937', textColor: '#ffffff', font: { src: 'Helvetica-Bold', size: 7.5 } } : { backgroundColor: i % 2 === 0 ? '#f3f4f6' : '#ffffff', font: { src: 'Helvetica', size: 7 } }),
      defaultStyle: { padding: 3, border: 0.3, borderColor: '#d1d5db' },
      data: [COLUMNS.map((c) => c.label), ...rows.map((r) => COLUMNS.map((c) => r[c.key]))],
    });
  }

  // Footer with page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the bottom margin must not start a new page
    doc.font('Helvetica').fontSize(8).fillColor('#666').text(`${docTitle} · page ${i + 1} of ${range.count}`, PAGE.margin, doc.page.height - PAGE.margin + 6, { width: doc.page.width - PAGE.margin * 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  const filename = `${clean(docTitle, 60).replace(/[^\w.-]+/g, '_') || 'lists'}.pdf`;
  return { filename, stream: doc };
}

module.exports = { listsPdf, rowFor };
