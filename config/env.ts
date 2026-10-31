/**
 * Environment variable validation.
 *
 * REQUIRED variables — the server refuses to start without them:
 *   MONGODB_URI           MongoDB Atlas connection string
 *   JWT_SECRET            Secret used to sign session and password-reset JWTs
 *   STACKMAIL_HOST        SMTP host for outbound email (Hostinger / Stackmail)
 *   STACKMAIL_USER        SMTP username (also used as the From address)
 *   STACKMAIL_PASS        SMTP password
 *   CLOUDINARY_CLOUD_NAME Cloudinary cloud identifier (image uploads)
 *   CLOUDINARY_API_KEY    Cloudinary API key
 *   CLOUDINARY_API_SECRET Cloudinary API secret
 *
 * OPTIONAL variables — missing values produce a startup warning only, the
 * corresponding feature will degrade gracefully at runtime:
 *   ADMIN_EMAIL              Notification recipient; falls back to STACKMAIL_USER value
 *   FRONTEND_URL             Comma-separated CORS origins; hardcoded production domains
 *                            are always allowed
 *   TRUST_PROXY              Express trust-proxy hops; defaults to 1
 *   PORT                     HTTP listen port; defaults to 3000
 *   NODE_ENV                 Runtime environment; defaults to "development"
 *   LOG_LEVEL                pino log level (trace|debug|info|warn|error|fatal); defaults to "info"
 *   REDIS_URL                Redis connection URL (optional; enables distributed rate limiting)
 *   SENTRY_DSN               Sentry DSN — Sentry is disabled entirely when absent
 *   SENTRY_TRACES_SAMPLE_RATE Sentry traces sampling rate (0.0 to 1.0); defaults to 0.1
 *   BUSINESS_TIMEZONE        IANA timezone for scheduling (required in production; defaults to America/New_York in dev/test)
 *   FB_PAGE_ID               Facebook Graph API page ID (reviews sync feature)
 *   FB_ACCESS_TOKEN          Facebook Graph API access token (reviews sync feature)
 *   CRON_SECRET              Bearer token that allows the cron endpoint without admin JWT
 *   COOKIE_DOMAIN            Cookie domain for httpOnly auth cookies in web mode
 *   STACKMAIL_PORT           SMTP port (defaults to 587)
 *   STACKMAIL_SECURE         SMTP secure TLS flag (defaults to false)
 *   DISABLE_REALTIME         Set to "true" to disable Socket.IO server initialization (optional)
 *
 * Call validateEnv() once at process startup (before importing any handler
 * that reads process.env).  In test mode (NODE_ENV === "test") only the
 * required variables are checked; warnings are suppressed entirely.
 */

/** Names of variables that must be non-empty strings for the server to function. */
const REQUIRED_VARS = [
  'MONGODB_URI',
  'JWT_SECRET',
  'STACKMAIL_HOST',
  'STACKMAIL_USER',
  'STACKMAIL_PASS',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
] as const;

/** Names of optional variables that trigger a console.warn when absent. */
const OPTIONAL_VARS: readonly string[] = [
  'REDIS_URL',
  'ADMIN_EMAIL',
  'FRONTEND_URL',
  'TRUST_PROXY',
  'PORT',
  'NODE_ENV',
  'LOG_LEVEL',
  'SENTRY_DSN',
  'SENTRY_TRACES_SAMPLE_RATE',
  'BUSINESS_TIMEZONE',
  'FB_PAGE_ID',
  'FB_ACCESS_TOKEN',
  'CRON_SECRET',
  'ENABLE_CRON',
  'COOKIE_DOMAIN',
  'STACKMAIL_PORT',
  'STACKMAIL_SECURE',
  'GOOGLE_MAPS_SERVER_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

export type RequiredEnvVar = (typeof REQUIRED_VARS)[number];

/**
 * Validates that all required environment variables are present and non-empty.
 *
 * - In any environment: throws an Error listing every missing required variable.
 * - In production (NODE_ENV === 'production'): BUSINESS_TIMEZONE is also strictly required.
 * - Outside test mode: prints a warning for each optional variable that is not set.
 *
 * Does NOT read, print, or export the values of any variables.
 */
export function validateEnv(): void {
  const missing: string[] = REQUIRED_VARS.filter(
    (key) => !process.env[key]?.trim()
  );

  // BUSINESS_TIMEZONE is strictly required in production; allowed to default in dev/test
  if (process.env.NODE_ENV === 'production' && !process.env.BUSINESS_TIMEZONE?.trim()) {
    missing.push('BUSINESS_TIMEZONE (required in production mode)');
  }

  // Refuse sk_live keys unless NODE_ENV=production
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (stripeKey?.startsWith('sk_live') && process.env.NODE_ENV !== 'production') {
    throw new Error('[env] Live Stripe keys (sk_live...) are only permitted when NODE_ENV=production.');
  }

  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required environment variable(s): ${missing.join(', ')}\n` +
        'Set them in your .env file or deployment environment and restart the server.'
    );
  }

  // Suppress optional-variable warnings during tests to keep output clean.
  if (process.env.NODE_ENV !== 'test') {
    if (!process.env.BUSINESS_TIMEZONE?.trim()) {
      console.warn(
        "[env] BUSINESS_TIMEZONE is not set. API defaulting to 'America/New_York' for development. Set BUSINESS_TIMEZONE in production."
      );
    }

    const unset = OPTIONAL_VARS.filter((key) => !process.env[key]?.trim());
    if (unset.length > 0) {
      console.warn(
        `[env] Optional variable(s) not set — related features may be limited: ${unset.join(', ')}`
      );
    }
  }
}

export function getStripeKey(): string | undefined {
  return process.env.STRIPE_SECRET_KEY;
}
