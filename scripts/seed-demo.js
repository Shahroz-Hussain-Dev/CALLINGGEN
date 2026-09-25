#!/usr/bin/env node
/**
 * DEMO DATA ONLY - for local testing of the UI. Creates clearly labelled demo
 * contacts (is_demo = true, business names prefixed with "DEMO") in a demo list
 * for each employee. Never run this against the production database.
 *
 *   node scripts/seed-demo.js
 *   node scripts/seed-demo.js --remove
 */
require('dotenv').config();
const { createPool } = require('../server/db');
const { normalizeBusinessName, normalizePhone } = require('../server/lib/normalize');

const DEMO = {
  strategy: [
    ['DEMO Glow Bridal Studio', 'Bridal Makeup Studios', 'Lahore', '0300-1112233', 'Bridal and party makeup studio taking bookings by WhatsApp and Instagram DM.'],
    ['DEMO Serene Skin Clinic', 'Skin Care Clinics', 'Karachi', '0321-4445566', 'Skin care clinic run by two sisters; appointments by phone call only.'],
    ['DEMO Aura Nails Lounge', 'Nail Art Studios', 'Islamabad', '0333-7778899', 'Nail art studio with walk-in and Instagram bookings.'],
  ],
  service: [
    ['DEMO Skyline Travels', 'Umrah and Hajj Travel Agencies', 'Lahore', '042-35551234', 'Umrah packages; inquiries answered manually on WhatsApp and phone all day.'],
    ['DEMO PrimeHire Recruiters', 'Recruitment Agencies', 'Karachi', '021-34567890', 'Recruitment agency screening CVs and scheduling interviews by phone.'],
    ['DEMO Metro Property Advisors', 'Property Dealers and Real Estate Brokerages', 'Islamabad', '051-2223344', 'Property brokerage with a 6-person sales team following up leads manually.'],
  ],
};

async function main() {
  const remove = process.argv.includes('--remove');
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (remove) {
      const { rowCount } = await client.query('DELETE FROM contacts WHERE is_demo = true');
      await client.query("DELETE FROM contact_lists WHERE list_code LIKE 'DEMO-%'");
      await client.query('COMMIT');
      console.log(`Removed ${rowCount} demo contacts.`);
      return;
    }
    const { rows: users } = await client.query("SELECT id, display_name FROM users WHERE account_status = 'active' ORDER BY rotation_order");
    if (!users.length) throw new Error('Run scripts/seed.js first');
    const { rows: st } = await client.query('SELECT * FROM rotation_state WHERE id = 1');
    const cycleNo = st[0].current_cycle_number;
    let created = 0;
    for (const type of ['strategy', 'service']) {
      for (let i = 0; i < users.length; i++) {
        const u = users[i];
        const code = `DEMO-${type === 'strategy' ? 'S' : 'V'}-${u.display_name[0]}`;
        const { rows: existing } = await client.query('SELECT id FROM contact_lists WHERE list_code = $1', [code]);
        let listId = existing[0] ? existing[0].id : null;
        if (!listId) {
          const ins = await client.query(
            `INSERT INTO contact_lists (list_name, list_code, contact_type, current_owner_id, original_owner_id, cycle_number, list_status, selected_niches, target_size, generation_progress)
             VALUES ($1, $2, $3, $4, $4, $5, 'active', '[]', 50, '{"status":"demo"}') ON CONFLICT (original_owner_id, contact_type, cycle_number) DO NOTHING RETURNING id`,
            [`DEMO ${type} list · ${u.display_name}`, code, type, u.id, cycleNo],
          );
          if (!ins.rows[0]) { console.log(`Skipped demo list for ${u.display_name}/${type}: a real list exists for this cycle`); continue; }
          listId = ins.rows[0].id;
        }
        const item = DEMO[type][i % DEMO[type].length];
        const name = `${item[0]} ${u.display_name}`;
        const phoneDigits = normalizePhone(item[3]).slice(0, -1) + String(i);
        const c = await client.query(
          `INSERT INTO contacts (business_name, normalized_business_name, niche, business_description, phone, normalized_phone, city, contact_type, contact_list_id, current_owner_id, original_owner_id, data_status, generation_source, generation_timestamp, is_demo, website_available, social_profiles)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 'estimated', 'demo', now(), true, false, '{"instagram":"https://instagram.com/demo"}') ON CONFLICT DO NOTHING RETURNING id`,
          [name, normalizeBusinessName(name), item[1], `${item[4]} (DEMO DATA - not a real business)`, item[3], phoneDigits, item[2], type, listId, u.id],
        );
        if (c.rows[0]) {
          await client.query('INSERT INTO list_contacts (list_id, contact_id, position) VALUES ($1, $2, (SELECT COALESCE(MAX(position),0)+1 FROM list_contacts WHERE list_id = $1))', [listId, c.rows[0].id]);
          created++;
        }
      }
    }
    await client.query('COMMIT');
    console.log(`Demo seed complete: ${created} DEMO contacts created (clearly labelled, is_demo = true).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error('Demo seed failed:', err.message); process.exit(1); });
