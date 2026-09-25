#!/usr/bin/env node
/**
 * Creates the three initial accounts with their INITIAL passwords (hashed with
 * scrypt) and default settings. Idempotent: existing users are left untouched
 * unless --reset-passwords is passed.
 *
 *   node scripts/seed.js
 *   node scripts/seed.js --reset-passwords
 */
require('dotenv').config();
const { createPool } = require('../server/db');
const { hashPassword } = require('../server/lib/password');

const INITIAL_USERS = [
  { username: 'Amman', display_name: 'Amman', password: 'Amman@latechs', role: 'employee', rotation_order: 1 },
  { username: 'fizza', display_name: 'Fizza', password: 'fizza@123', role: 'employee', rotation_order: 2 },
  { username: 'shahroz', display_name: 'Shahroz', password: 'shezi', role: 'owner', rotation_order: 3 },
];

async function main() {
  const reset = process.argv.includes('--reset-passwords');
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of INITIAL_USERS) {
      const { rows } = await client.query('SELECT id FROM users WHERE username_normalized = lower($1)', [u.username]);
      if (rows[0]) {
        if (reset) {
          await client.query('UPDATE users SET password_hash = $2, must_change_password = true, account_status = $3 WHERE id = $1', [rows[0].id, hashPassword(u.password), 'active']);
          console.log(`Reset password for ${u.username}`);
        } else console.log(`User ${u.username} already exists - skipped`);
        continue;
      }
      const ins = await client.query(
        'INSERT INTO users (username, display_name, password_hash, role, rotation_order, must_change_password) VALUES ($1, $2, $3, $4, $5, true) RETURNING id',
        [u.username, u.display_name, hashPassword(u.password), u.role, u.rotation_order],
      );
      await client.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [ins.rows[0].id]);
      console.log(`Created ${u.role} account: ${u.username}`);
    }
    await client.query('COMMIT');
    console.log('Seed complete. Users should change their initial passwords after first login (Settings > Account).');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error('Seed failed:', err.message); process.exit(1); });
