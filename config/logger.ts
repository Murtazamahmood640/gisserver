/**
 * Structured logger (pino).
 */
import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test';
const isVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

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
  // Never use pino-pretty on Vercel/serverless environments
  transport:
    !isTest && !isVercel && process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

export default logger;
