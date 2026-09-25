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

  // AI provider selection: gemini (default when GEMINI_API_KEY is set) or anthropic
  ai: {
    provider: (env.AI_PROVIDER || (env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? 'gemini' : 'anthropic')).toLowerCase(),
    gemini: {
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
      baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
      model: env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
      fallbackModels: (env.GEMINI_FALLBACK_MODELS || 'gemini-3.8-flash,gemini-flash-latest,gemini-3.5-flash,gemini-3.1-flash-lite').split(',').map((m) => m.trim()).filter(Boolean),
      webSearch: bool(env.GEMINI_WEB_SEARCH, true),
      urlContext: bool(env.GEMINI_URL_CONTEXT, true),
      thinking: env.GEMINI_THINKING || 'high', // high | medium | low | off  (Gemini 3 thinkingLevel; older models use a dynamic budget)
      temperature: Number.isFinite(parseFloat(env.GEMINI_TEMPERATURE)) ? parseFloat(env.GEMINI_TEMPERATURE) : 0.2,
      timeoutMs: int(env.GEMINI_TIMEOUT_MS, 170000),
      maxRetries: int(env.GEMINI_MAX_RETRIES, 3),
      maxOutputTokens: int(env.GEMINI_MAX_OUTPUT_TOKENS, 16384),
    },
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
