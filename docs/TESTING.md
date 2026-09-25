# Testing

The suite (`tests/*.test.js`, Node's built-in `node:test`) runs the real Express API against a real
PostgreSQL database with a fake Claude client injected through `claude.setClientFactory`, so no
network calls or API keys are needed.

## Setup
1. Create an empty database, e.g. locally:
   ```bash
   createdb latechs_test
   ```
2. Put its URL in `.env` as `TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/latechs_test`.
3. Run:
   ```bash
   npm test
   ```
   The harness applies migrations, truncates data tables before every test and creates the three
   accounts. Files run sequentially (`--test-concurrency=1`) because they share the database.

## What is covered
| File | Scenarios |
|---|---|
| `auth.test.js` | valid login + cookie flags, case-insensitive usernames, invalid login, hashed passwords, unauthenticated/cross-site requests, employee vs owner route permissions, employee cannot access another employee's contact/list/calls by ID, logout, password change + audit |
| `leads.test.js` | generation through Claude with saved verified fields, source URLs, normalized phones, social-page-as-website handling, cycle start; duplicate rejection by phone / name+city / fuzzy name / Instagram handle across employees and panels; same name in different cities kept; incomplete data preserved honestly, no-contact-channel and off-target candidates rejected; honest exhaustion without fabrication; idempotent per-cycle lists; clear error without an API key; encrypted per-user keys |
| `calls.test.js` | call recording with panel fields + follow-up creation, contact state updates, next-contact workflow, required summary validation; chronological history visible to admin; skip requires a reason; follow-up complete/reschedule keeps history |
| `rotation.test.js` | three-day timing and refusal before due; day-4 transfer Amman→Fizza→Shahroz→Amman for both panels with history, incomplete lists, follow-up reassignment, access changes, audit and new list creation; concurrent double execution rotates once; archiving after the chain; secured cron endpoint; owner-forced rotation |
| `meetings.test.js` | creation + shared visibility + owner/admin editing and outcome recording; overlap prevention (partial, containing, inner) with adjacent slots allowed; concurrent bookings → exactly one success; cancel keeps history and frees the slot; idempotency keys; booking from a contact |

## Manual UI checks
See the checklist at the end of [DEPLOYMENT.md](DEPLOYMENT.md) (steps 14–18).
