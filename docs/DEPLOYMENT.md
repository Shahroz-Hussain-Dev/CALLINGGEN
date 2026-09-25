# Deployment guide (Supabase + Vercel)

This walks through every step from an empty Supabase project to a running production system.

## 1. Install dependencies
```bash
npm install
```
Node.js 20 or newer is required (Vercel's default Node runtime is fine).

## 2. Configure environment variables
Copy `.env.example` to `.env` for local use. Every variable is documented in
[ENVIRONMENT.md](ENVIRONMENT.md). Minimum for production:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase PostgreSQL connection string (transaction pooler, port 6543, on Vercel) |
| `ANTHROPIC_API_KEY` | Server-wide Claude key (users may add personal keys in Settings) |
| `APP_ENCRYPTION_KEY` | Random 32+ byte secret; encrypts personal Claude keys at rest |
| `CRON_SECRET` | Random secret; Vercel Cron sends it as `Authorization: Bearer` |
| `NODE_ENV` | `production` |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## 3. Connect Supabase PostgreSQL
1. In Supabase: **Project Settings → Database → Connection string**.
2. Use the **URI** form. For serverless (Vercel) choose *Transaction pooler* (port 6543); for local
   development and for running migrations the *Direct connection* (port 5432) is fine.
3. TLS is enabled automatically for non-localhost hosts (`DATABASE_SSL=require` forces it).
4. The individual `DATABASE_HOST/PORT/NAME/USER/PASSWORD` variables are used only when
   `DATABASE_URL` is empty.

## 4. Run SQL migrations
```bash
DATABASE_URL="postgresql://..." npm run migrate
```
Applies `db/migrations/*.sql` in order and records them in `schema_migrations`. Re-running is safe.
Use `node scripts/migrate.js --status` to see what is applied.

## 5. Create indexes and constraints
Included in the migrations: unique indexes for global duplicate prevention
(`contacts_normalized_phone_uidx`, `contacts_normalized_domain_uidx`, `contacts_name_city_uidx`),
the meeting overlap exclusion constraint, per-cycle list uniqueness, rotation idempotency indexes
and all query indexes. Nothing else to run.

## 6. Configure the Claude API
* Set `ANTHROPIC_API_KEY` (server key). Default model `claude-opus-5`; override with `CLAUDE_MODEL`.
* `CLAUDE_WEB_SEARCH=true` (default) lets Claude research businesses with live web search and cite
  sources. Set to `false` to disable (all leads will then be *Needs Verification*).
* Each user can save a personal key in **Settings → Claude API** (encrypted with `APP_ENCRYPTION_KEY`)
  and test the connection there. The personal key takes precedence for that user.

## 7. Configure the optional business/search API
`LEAD_SEARCH_PROVIDER=serper` with `SERPER_API_KEY` enables Google Places verification of every
candidate (phone, address, website, rating). Additional providers implement the interface in
`server/services/search/index.js` and are selected by the same variable – no redesign needed.

## 8. Seed the accounts
```bash
DATABASE_URL="postgresql://..." npm run seed
```
Creates Amman, Fizza and Shahroz with their initial (hashed) passwords.

## 9. Start the development server
```bash
npm run dev      # or npm start
```
Open http://localhost:3000.

## 10. Build the production version
There is no build step: the frontend is static and the API is plain Node.js. `npm run lint`
syntax-checks the entry points; `npm test` runs the integration suite.

## 11. Deploy the frontend (Vercel)
1. Push the repository to GitHub.
2. In Vercel: **Add New → Project → Import** the repository. Framework preset: **Other**.
   Leave build command empty and output directory as default (`public/` is served as static files).
3. Add the environment variables (step 2) for the Production environment.
4. Deploy. `vercel.json` contains the rewrite `/api/(.*) → /api/index` and security headers.

## 12. Deploy the server/serverless API
Deployed together with the frontend: `api/index.js` exports the Express app and Vercel runs it as a
single serverless function (`maxDuration` 60 s, 1024 MB in `vercel.json`). If your plan allows longer
executions (Pro / Fluid compute), raise `maxDuration` to 300 so larger generation batches fit; otherwise
keep the batch size at 3–5 (Settings → System configuration → *Generation batch size*).

## 13. Configure the scheduled rotation process
`vercel.json` registers a cron: `{"path": "/api/rotation/cron", "schedule": "5 19 * * *"}` – daily at
19:05 UTC = 00:05 Asia/Karachi. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically once
`CRON_SECRET` is set. The endpoint is idempotent: it rotates only when a cycle is due, then continues
pending list generation within its time budget.

Alternatives: any external scheduler can call `GET https://<your-app>/api/rotation/cron` with the
same bearer token, or run `npm run rotation:run` from a server with the same environment variables.
The owner can also run or force a rotation from **Contact Rotation → Rotation controls**.

## 14. Test authentication
Sign in as each user. Verify: wrong password → error; `AMMAN` (any case) works; employees do not
see owner pages; Settings → Account → change password.

## 15. Test lead generation
Settings → Claude API → **Test API connection** must succeed. Then in *Strategy Leads* select a niche,
request 5 contacts and click **Generate Contacts**. Watch the live counters (saved / duplicates /
needs verification). Open a contact: verification badges, source URLs and per-field verification are shown.

## 16. Test duplicate prevention
Generate again for the same niche/city (or from the other panel or as another user). The batch
summary shows *Duplicates rejected*, and **Settings → Audit log** lists `lead_rejected_duplicate`
events with the matching reason (same phone, same name and city, similar name, same Instagram…).

## 17. Test rotation
**Contact Rotation** shows the cycle, countdown and chain. Use **Force rotation now** (type ROTATE)
to run a rotation immediately: lists move to the next person with their full history, archived lists
appear below, new lists are created, and the run is recorded in *Rotation runs* and the audit log.
Running the cron endpoint again in the same cycle returns `rotated: false, reason: "not_due"`.

## 18. Test meeting conflict prevention
Book a meeting, then try to book an overlapping slot as another user (or click **Check availability**):
the conflict is reported with the existing meeting and owner. Adjacent slots are allowed.

## Supabase notes
* Row Level Security is not used: the application connects with its own database role from the
  server only and enforces permissions in code and constraints. Do not expose the anon key or the
  database URL to the browser.
* Keep the pooler `max` low on serverless (`DATABASE_POOL_MAX`, default 3).
