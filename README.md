# LATechS Sales OS

Internal lead generation, sales strategy and meeting management system for LATechS.
Three accounts (Amman, Fizza – employees; Shahroz – owner/administrator), two completely
separate sales panels (**Strategy Leads** and **Service Sales Leads**), Claude-powered
research of real Pakistani businesses, global duplicate prevention, guided calling with
permanent call history, follow-ups, a shared conflict-free meeting calendar, automatic
three-day list rotation with fresh list generation, and a full owner dashboard.

| Layer | Technology |
|---|---|
| Frontend | Static HTML / CSS / JavaScript (ES modules, no build step) in `public/` |
| API | Node.js + Express, deployed as one Vercel serverless function (`api/index.js`) |
| Database | Supabase PostgreSQL (`pg`), versioned SQL migrations in `db/migrations/` |
| AI | Google Gemini (Gemini Developer API, default) or Anthropic Claude — selected with `AI_PROVIDER`, server-side only |
| Scheduler | Vercel Cron → `GET /api/rotation/cron` (protected by `CRON_SECRET`) |

Everything sensitive (database credentials, Claude API keys, passwords, sessions) lives on the
server. The browser only ever receives an httpOnly session cookie and JSON data.

---

## 1. Quick start (local)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env          # then edit .env (see docs/ENVIRONMENT.md)

# 3. Connect Supabase PostgreSQL: set DATABASE_URL in .env
#    (Supabase -> Project Settings -> Database -> Connection string)

# 4. Run the SQL migrations (creates tables, indexes, constraints, niches, defaults)
npm run migrate

# 5. Indexes and constraints are part of the migrations (nothing else to run)

# 6. Configure the AI provider: set GEMINI_API_KEY (default provider) or ANTHROPIC_API_KEY with AI_PROVIDER=anthropic
#    (users may also add their own key in Settings → AI configuration)

# 7. (Optional) business/search data provider: LEAD_SEARCH_PROVIDER=serper + SERPER_API_KEY

# 8. Create the three initial accounts
npm run seed

# 9. Start the development server
npm run dev                    # http://localhost:3000
```

Initial credentials (users are asked to change them on first login, Settings → Account):

| User | Username | Initial password | Role |
|---|---|---|---|
| Amman | `Amman` | `Amman@latechs` | Employee |
| Fizza | `fizza` | `fizza@123` | Employee |
| Shahroz | `shahroz` | `shezi` | Owner / Administrator |

Usernames are case-insensitive. Passwords are stored as scrypt hashes only.

Optional, clearly labelled demo data for UI testing: `npm run seed:demo` (remove with
`node scripts/seed-demo.js --remove`). Demo contacts are flagged `is_demo = true` and prefixed
`DEMO`; they are never produced by the real generator.

---

## 2. Deployment on Vercel

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for the step-by-step guide. Summary:

1. Push this repository to GitHub and import it in Vercel (framework preset: *Other*).
2. Add the environment variables from `.env.example` (at minimum `DATABASE_URL`,
   `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY` + `AI_PROVIDER=anthropic`), `APP_ENCRYPTION_KEY`, `CRON_SECRET`, `NODE_ENV=production`).
   Use the Supabase **transaction pooler** URL (port 6543) for `DATABASE_URL`.
3. Run the migrations and seed once from your machine against the production database:
   `DATABASE_URL=<supabase url> npm run migrate && DATABASE_URL=<supabase url> npm run seed`.
4. Deploy. `vercel.json` routes `/api/*` to the serverless API, serves `public/` as static
   files, and registers the daily rotation cron (`5 19 * * *` UTC = 00:05 Pakistan time).
5. Sign in, open **Settings → AI configuration → Test API connection**. On a free-tier Gemini key, also paste
   one free search API key (Serper recommended) in **Settings → System configuration → Web research API keys**
   and click *Test web research*. Then generate the first lists.

---

## 3. How the system works

### Two panels, never merged
* **Strategy Leads** – Pakistani appointment-based businesses (30 women-focused niches) without a
  website/online booking. Employees approach as a customer first, understand the booking process,
  then introduce LATechS. Panel-specific call fields record exactly what was asked and answered.
* **Service Sales Leads** – Pakistani non-technical businesses with repetitive work (10 niche
  groups, 80 niches). Software/AI/automation agencies are excluded by the prompt rules. The goal is
  a meeting with the decision-maker plus a Claude-prepared, process-specific automation proposal.

### Lead generation (Claude + verification + duplicate prevention)
1. User selects niches and a number of contacts (≤ 50) and clicks **Generate Contacts**.
2. The server creates (or continues) the user's list for the current cycle and a generation job.
3. Each batch runs a two-phase research pipeline on Gemini (default `gemini-3.1-pro-preview`, with an
   automatic fallback chain to the current Flash models when a model is unavailable on the key's tier):
   a grounded research call (Google Search + URL reading, high thinking, low temperature) that writes an
   evidence report with a URL for every fact, then a strict-JSON extraction call that may only restate
   facts from the report. With the Anthropic provider the same rules apply through Claude's web search
   and a strict `submit_leads` tool.
   **Free mode (no paid grounding needed):** when the Gemini key has no Google-grounding quota (free
   tier), the app runs its own web research: six web searches per niche and city (Serper/Jina/Tavily/
   Google Programmable Search with a free key, or DuckDuckGo/Bing where those are not blocked), reads up to eight
   of the resulting pages (directories, salon and company websites; social pages via their search
   snippets), extracts phone numbers, emails and social links, and gives that evidence bundle to the
   model in a single strict-JSON call. The server then verifies every returned fact against the evidence:
   a phone, website, email, social profile or person name that does not appear in the gathered pages is
   removed, and a business whose name is not in the evidence is rejected. Leads therefore carry real
   source URLs and honest verification badges even on a free key.
4. Every candidate is normalized (name, phone, domain, social handles), optionally verified through
   the pluggable business-data provider (`server/services/search/`), checked against the **entire
   database** (all employees, both panels, all history) using phone, website domain, name+city,
   social handles and fuzzy name matching, and saved only if unique. PostgreSQL unique indexes are
   the final guard. Rejections are logged (`generation_rejections`, activity log).
5. The frontend calls the next batch until the target is reached or the source is exhausted. Real
   counts are shown: saved / duplicates rejected / needs verification / rejected. Nothing is ever
   fabricated to fill empty slots.

### Calling workflow
The panel shows the next unprocessed contact with its full profile and guided steps. A contact is
only marked processed for the current cycle when a call record (with a required summary for real
conversations) or a skip reason is saved. Call records are permanent and chronological; rotated
contacts show the previous employee's history to the new owner.

### Three-day rotation
* A global cycle starts when the first list is generated (00:00 Pakistan time of that day) and a
  rotation becomes due three days later (`rotation_interval_days`, editable).
* Rotation moves **every active list in full** – incomplete or not – along the chain
  Amman → Fizza → Shahroz → Amman, for both panels, preserving business details, previous/current
  owner, call history, notes, follow-ups (pending ones are reassigned), meetings and rotation history.
  After a list has visited every employee (`list_max_rotations`, default 2) it is archived, never deleted.
* After rotating, a fresh 50-contact list is created for every employee and panel; generation
  continues automatically in batches (cron + when the employee opens the panel).
* The engine is idempotent: the state row is locked, the due-check is re-evaluated under the lock,
  and one completed run per cycle is enforced by a unique index. Running the cron twice never rotates
  twice. Every rotation is recorded in `rotation_history`, `rotation_runs` and `activity_logs`.

### Shared meeting calendar
Day / week / month views for the whole team. Overlaps are impossible: a PostgreSQL exclusion
constraint (`meetings_no_overlap_excl`) rejects any two active meetings whose time ranges intersect,
even when two employees submit at the same instant. Employees manage their own meetings; Shahroz
manages all. Idempotency keys make retries safe.

### Security model
* Server-side sessions (random token, hashed in DB, httpOnly + SameSite cookie, sliding expiry).
* Every API route re-checks the logged-in user, role, contact/list ownership and meeting ownership.
  An employee requesting another employee's contact ID receives `403`.
* CSRF guard: state-changing requests must carry the `X-Requested-With` marker header and a
  same-origin `Sec-Fetch-Site`.
* Per-user Claude keys are AES-256-GCM encrypted at rest; only the last four characters are ever
  returned. The server key never leaves the server. Errors never expose secrets or SQL details.
* Security headers (CSP, frame-ancestors, nosniff, referrer policy) on every response.

---

## 4. Project layout

```
api/index.js                 Vercel serverless entry (exports the Express app)
server.js                    Local development server
server/app.js                Express app, middleware, routes
server/config.js             Environment-driven configuration (no secrets in code)
server/db.js                 pg pool, transactions, health check
server/lib/                  normalization, dates, validation, crypto, passwords, errors
server/middleware/           auth (sessions), security headers + CSRF guard, error handler
server/services/             auth, users, niches, settings, apiKeys, ai (facade), gemini, claude, search providers,
                             duplicates, contacts, lists, generation, calls, followups, meetings,
                             rotation, cycle, analytics, activity
server/prompts/              Claude prompts and JSON schemas (lead generation, analysis)
server/routes/               REST routes (/api/...)
db/migrations/               001_initial_schema.sql, 002_reference_data.sql
scripts/                     migrate.js, seed.js, seed-demo.js, run-rotation.js, db-status.js
public/                      Frontend (index.html, css/, js/ with views/)
tests/                       node:test suites (auth, leads, calls, rotation, meetings)
docs/                        DEPLOYMENT.md, ENVIRONMENT.md, TESTING.md, API.md
```

## 5. API overview

All routes are under `/api` and require a session unless noted. Full list in
[docs/API.md](docs/API.md).

| Area | Routes |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /me`, `POST /me/password` |
| AI | `GET /ai/status`, `POST /ai/test`, `POST /ai/key`, `DELETE /ai/key` (legacy aliases under `/claude/*`) |
| Leads | `GET /leads`, `GET /leads/:id`, `POST /leads/generate`, `POST /leads/:id/call`, `POST /leads/:id/follow-up`, `POST /leads/:id/skip`, `PATCH /leads/:id/notes`, `POST /leads/:id/research` |
| Lists | `GET /lists`, `GET /lists/:id`, `GET /lists/:id/next`, `POST /lists/generate`, `POST /lists/:id/generate`, `GET /generation/:jobId`, `POST /generation/:jobId/cancel` |
| Rotation | `GET /rotation/status`, `GET /rotation/overview` (owner), `POST /rotation/run` (owner), `POST /rotation/transfer` (owner), `GET /rotation/cron` (CRON_SECRET) |
| Meetings | `GET /meetings`, `POST /meetings`, `POST /meetings/check`, `PATCH /meetings/:id`, `DELETE /meetings/:id` (cancels, keeps history) |
| Follow-ups | `GET /follow-ups`, `GET /follow-ups/summary`, `PATCH /follow-ups/:id` |
| Settings | `GET /settings`, `PATCH /settings/user`, `PATCH /settings/system` (owner), `GET /settings/system/status` (owner), `GET/POST/PATCH /niches` |
| Admin | `GET /admin/activity`, `GET /admin/analytics`, `GET /admin/contacts`, `GET /admin/search`, `GET /admin/employees`, `GET /admin/users`, `PATCH /admin/users/:id` |
| Dashboard | `GET /overview`, `GET /activity`, `GET /users`, `GET /health` (public) |

## 6. Testing

```bash
# needs a disposable PostgreSQL database in TEST_DATABASE_URL (see docs/TESTING.md)
npm test
```

30 integration tests run the real API against PostgreSQL with a fake AI client (no network), plus 6 Gemini provider unit tests:
authentication and permissions, lead generation / duplicate rejection / verification fields /
honest incomplete data / exhaustion, call recording and follow-ups, three-day rotation (timing,
day-4 transfer, ownership, history preservation, incomplete lists, double-execution protection),
and meetings (creation, overlap prevention incl. concurrent bookings, shared visibility, admin editing).

## 7. Operations

* `npm run migrate` – apply pending migrations (safe to re-run); `node scripts/migrate.js --status`.
* `npm run seed` – create the three accounts (`--reset-passwords` to restore initial passwords).
* `npm run rotation:run` – run the rotation/generation scheduler once from any machine or cron.
* `npm run db:status` – connectivity and migration check; `npm run db:probe` – finds a reachable Supabase endpoint.
* Settings → *Database & generation status* (owner) shows DB health, environment flags and jobs.
