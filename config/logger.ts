/**
 * Structured logger (pino).
 *
 * Configuration:
 *   LOG_LEVEL  — pino log level: trace | debug | info | warn | error | fatal
 *               Defaults to "info".  Forced to "silent" in test mode.
 *
 * Sensitive fields redacted from every log line:
 *   - req.headers.authorization
 *   - req.headers.cookie
 *   - Any field named: password, token, secret, apiKey, api_key,
 *     accessToken, access_token, refreshToken, refresh_token,
 *     resetToken, reset_token, emailBody, html (email template fields)
 */

import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-booking-token"]',
  'req.headers.x-booking-token',
  'x-booking-token',
  '*.x-booking-token',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.resetToken',
  '*.reset_token',
  '*.emailBody',
  '*.html',
  'password',
  'token',
  'secret',
];

const logger = pino({
  level: isTest ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  // Pretty-print in development; structured JSON in production/staging
  transport:
    !isTest && process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

export default logger;
