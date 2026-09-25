'use strict';
/**
 * Central configuration. Every secret comes from the environment; nothing in
 * this file is ever shipped to the browser.
 */
const env = process.env;

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const isTest = env.NODE_ENV === 'test';

const config = {
  env: env.NODE_ENV || 'development',
  isProduction: env.NODE_ENV === 'production' || !!env.VERCEL,
  isTest,
  port: int(env.PORT, 3000),

  database: {
    url: isTest ? env.TEST_DATABASE_URL || env.DATABASE_URL : env.DATABASE_URL,
    host: env.DATABASE_HOST,
    port: int(env.DATABASE_PORT, 5432),
    name: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    ssl: env.DATABASE_SSL, // 'require' | 'disable' | undefined (auto)
    poolMax: int(env.DATABASE_POOL_MAX, env.VERCEL ? 3 : 10),
  },

  session: {
    cookieName: 'latechs_session',
    ttlHours: int(env.SESSION_TTL_HOURS, 12),
    absoluteTtlDays: int(env.SESSION_ABSOLUTE_TTL_DAYS, 7),
    secureCookies: bool(env.SECURE_COOKIES, env.NODE_ENV === 'production' || !!env.VERCEL),
  },

  security: {
    encryptionKey: env.APP_ENCRYPTION_KEY || '',
    cronSecret: env.CRON_SECRET || '',
    loginMaxAttempts: int(env.LOGIN_MAX_ATTEMPTS, 8),
    loginWindowMinutes: int(env.LOGIN_WINDOW_MINUTES, 15),
  },

  claude: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.CLAUDE_MODEL || 'claude-opus-5',
    fastModel: env.CLAUDE_FAST_MODEL || env.CLAUDE_MODEL || 'claude-opus-5',
    webSearch: bool(env.CLAUDE_WEB_SEARCH, true),
    webSearchMaxUses: int(env.CLAUDE_WEB_SEARCH_MAX_USES, 8),
    fallbacks: bool(env.CLAUDE_ENABLE_FALLBACKS, true),
    timeoutMs: int(env.CLAUDE_TIMEOUT_MS, 55000),
    effort: env.CLAUDE_EFFORT || 'medium',
  },

  search: {
    provider: (env.LEAD_SEARCH_PROVIDER || 'none').toLowerCase(), // none | serper
    serperApiKey: env.SERPER_API_KEY || '',
  },

  generation: {
    batchSize: int(env.LEAD_GENERATION_BATCH_SIZE, 5),
    maxEmptyAttempts: int(env.LEAD_GENERATION_MAX_EMPTY_ATTEMPTS, 4),
    timeBudgetMs: int(env.LEAD_GENERATION_TIME_BUDGET_MS, 45000),
  },

  app: {
    timezone: env.APP_TIMEZONE || 'Asia/Karachi',
    name: 'LATechS Sales OS',
  },
};

module.exports = config;
