# Environment variables

All configuration comes from environment variables (see `.env.example`). None of them is ever sent
to the browser.

## Database (Supabase PostgreSQL)
| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes (or the individual fields) | Full PostgreSQL URI. On Vercel use the Supabase transaction pooler (port 6543). |
| `DATABASE_HOST` `DATABASE_PORT` `DATABASE_NAME` `DATABASE_USER` `DATABASE_PASSWORD` | fallback | Used only when `DATABASE_URL` is empty. |
| `DATABASE_SSL` | no | `require` / `disable`; default: TLS on for non-localhost hosts. |
| `DATABASE_POOL_MAX` | no | Pool size per process (default 3 on Vercel, 10 locally). |
| `TEST_DATABASE_URL` | tests | Separate disposable database for `npm test`. |

## Claude API
| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | recommended | Server-wide key. Users may also store personal keys (encrypted). |
| `CLAUDE_MODEL` | no | Default `claude-opus-5`. |
| `CLAUDE_WEB_SEARCH` | no | `true` (default): Claude researches businesses with live web search and cites sources. |
| `CLAUDE_WEB_SEARCH_MAX_USES` | no | Max searches per generation request (default 8). |
| `CLAUDE_EFFORT` | no | `low` / `medium` (default) / `high` reasoning effort. |
| `CLAUDE_ENABLE_FALLBACKS` | no | Server-side refusal fallbacks (default true; degrades automatically if unsupported). |
| `CLAUDE_TIMEOUT_MS` | no | Per-request timeout (default 55000). Keep below the function `maxDuration`. |

## Business-data provider (optional)
| Variable | Description |
|---|---|
| `LEAD_SEARCH_PROVIDER` | `none` (default) or `serper`. |
| `SERPER_API_KEY` | API key for Serper.dev Google Places verification. |

## Security
| Variable | Required | Description |
|---|---|---|
| `APP_ENCRYPTION_KEY` | yes for personal keys | 32+ random bytes; AES-256-GCM key for per-user Claude keys. |
| `CRON_SECRET` | yes for cron | Bearer token accepted by `/api/rotation/cron`. Vercel Cron sends it automatically. |
| `SESSION_TTL_HOURS` | no | Sliding session lifetime (default 12). |
| `SESSION_ABSOLUTE_TTL_DAYS` | no | Hard session limit (default 7). |
| `SECURE_COOKIES` | no | Force the `Secure` cookie flag (auto-on in production / Vercel). |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | no | Login throttling (default 8 per 15 min). |

## Generation & app
| Variable | Description |
|---|---|
| `LEAD_GENERATION_BATCH_SIZE` | Contacts requested per Claude call (1–15, default 5; also editable in Settings). |
| `LEAD_GENERATION_MAX_EMPTY_ATTEMPTS` | Empty batches tolerated before a job is marked *exhausted* (default 4, scaled by niches/cities). |
| `LEAD_GENERATION_TIME_BUDGET_MS` | Time the cron spends continuing generation (default 45000). |
| `APP_TIMEZONE` | Default `Asia/Karachi` (cycle day boundaries, meeting times; also a system setting). |
| `PORT` | Local server port (default 3000). |
| `NODE_ENV` | `development` / `production` / `test`. |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error`. |
