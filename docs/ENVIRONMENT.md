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

## AI provider
| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | no | `gemini` (default when `GEMINI_API_KEY` is set) or `anthropic`. |

## Google Gemini
| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | yes for Gemini | Gemini Developer API key from Google AI Studio (`AIza…` or `AQ.…`). Users may also store personal keys (encrypted). |
| `GEMINI_MODEL` | no | Primary model, default `gemini-3.1-pro-preview` (best quality; needs a billed key). |
| `GEMINI_FALLBACK_MODELS` | no | Comma-separated chain tried automatically when a model is unavailable on the key's tier. Default `gemini-3.8-flash,gemini-flash-latest,gemini-3.5-flash,gemini-3.1-flash-lite`. |
| `GEMINI_RESEARCH_MODE` | no | `auto` (default): Google Search grounding when the key has quota, otherwise the free built-in web research; `evidence`: always built-in research; `native`: always grounding. |
| `GEMINI_EVIDENCE_THINKING` / `GEMINI_EVIDENCE_TIMEOUT_MS` | no | Thinking level (default `medium`) and timeout (default 120000) for the evidence-mode call. |
| `GEMINI_WEB_SEARCH` | no | `true` (default): research uses Google Search grounding and cites sources. Free-tier keys have no grounding quota; the app then falls back to ungrounded research and marks leads *Needs Verification*. |
| `GEMINI_URL_CONTEXT` | no | `true` (default): lets the model open pages it finds to confirm details. |
| `GEMINI_THINKING` | no | `high` (default) / `medium` / `low` / `off`. |
| `GEMINI_TEMPERATURE` | no | Default `0.2` (factual). |
| `GEMINI_TIMEOUT_MS` | no | Per-request timeout (default 170000; keep below the function `maxDuration`). |
| `GEMINI_MAX_RETRIES` | no | Retries on "high demand" (503) per model (default 3). |
| `GEMINI_OVERLOAD_ROUNDS` | no | Extra sweeps over the whole model chain when every model was overloaded or per-minute rate-limited (default 2), separated by `GEMINI_OVERLOAD_ROUND_WAIT_MS` (default 12000). |
| `GEMINI_BATCH_DEADLINE_MS` | no | Time budget for one lead batch including web research (default 240000). Model calls and retry rounds stop before it so the serverless function never times out. |
| `GEMINI_MAX_OUTPUT_TOKENS` | no | Default 16384. |

## Anthropic Claude (AI_PROVIDER=anthropic)
| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | recommended | Server-wide key. Users may also store personal keys (encrypted). |
| `CLAUDE_MODEL` | no | Default `claude-opus-5`. |
| `CLAUDE_WEB_SEARCH` | no | `true` (default): Claude researches businesses with live web search and cites sources. |
| `CLAUDE_WEB_SEARCH_MAX_USES` | no | Max searches per generation request (default 8). |
| `CLAUDE_EFFORT` | no | `low` / `medium` (default) / `high` reasoning effort. |
| `CLAUDE_ENABLE_FALLBACKS` | no | Server-side refusal fallbacks (default true; degrades automatically if unsupported). |
| `CLAUDE_TIMEOUT_MS` | no | Per-request timeout (default 55000). Keep below the function `maxDuration`. |

## Free built-in web research (evidence mode)
| Variable | Description |
|---|---|
| `WEB_SEARCH_ENGINE` | Preferred key-less engine: `duckduckgo` (default; direct, blocked from Vercel's network) / `jina_reader` (DuckDuckGo Lite and Bing result pages rendered by the key-less Jina Reader proxy, works from Vercel; set this on Vercel) / `bing` (RSS). Engines with a configured key (`serper`, `brave`, `google_cse`, `tavily`, `jina`) are always tried first; blocked, rate-limited or repeatedly empty engines are put on cooldown and the next one is used. |
| `JINA_MIN_GAP_MS` | Spacing between key-less Jina Reader calls (default 3200 ms, i.e. under its 20 requests/minute limit). A `JINA_API_KEY` raises that limit. |
| `JINA_RATE_LIMIT_COOLDOWN_MS` | Cooldown after a Jina Reader HTTP 429 (default 90000). |
| `EVIDENCE_JINA_PAGE_FALLBACKS` | Pages per batch re-read through Jina Reader when a site refuses direct fetches (default 3). |
| `SERPER_API_KEY` | Serper.dev key (Google results; 2,500 free searches, no card). Also enables Google Places verification. **Recommended.** |
| `JINA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` | Alternative search APIs with free tiers. |
| `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ID` | Google Programmable Search JSON API (100 free queries/day). |
| (Settings UI) | The owner can paste any of these keys in Settings → System configuration; they are stored AES-256-GCM encrypted in `system_settings` and take precedence over the environment. |
| `EVIDENCE_TIME_BUDGET_MS` | Total time spent searching and reading pages per batch (default 45000). |
| `EVIDENCE_MAX_PAGES` | Pages read per batch (default 8). |
| `EVIDENCE_MAX_PROMPT_CHARS` | Evidence characters passed to the model (default 36000). |

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
