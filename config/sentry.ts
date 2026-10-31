/**
 * Optional Sentry integration.
 *
 * Enabled only when SENTRY_DSN is set in the environment.
 * If SENTRY_DSN is absent this module is a complete no-op:
 * no import side-effects, no network traffic, no errors.
 *
 * Usage in app.ts:
 *   import { initSentry, sentryErrorHandler } from './config/sentry';
 *   initSentry(app);            // before routes
 *   app.use(sentryErrorHandler); // after all routes, before globalErrorHandler
 */

import type { Express, Request, Response, NextFunction } from 'express';
import logger from './logger';

let sentryInitialized = false;

/**
 * Initialise Sentry and attach the request handler.
 * Call once at app startup, before defining any routes.
 */
export async function initSentry(app: Express): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    logger.info('SENTRY_DSN not set — Sentry disabled');
    return;
  }

  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'production',
      // Never send raw request bodies (could contain PII)
      // Cast as any because sendDefaultPii typing varies across SDK versions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(({ sendDefaultPii: false, tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1') } as any)),
    } as any);

    // Attach Sentry request handler (must come before routes)
    app.use(Sentry.expressErrorHandler() as unknown as (req: Request, res: Response, next: NextFunction) => void);
    sentryInitialized = true;
    logger.info('Sentry initialised');
  } catch (err) {
    logger.warn({ err }, 'Sentry initialisation failed — continuing without Sentry');
  }
}

/**
 * Express error handler that forwards errors to Sentry.
 * No-op when Sentry is not initialised.
 * Place this AFTER all routes but BEFORE your own globalErrorHandler.
 */
export function sentryErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (sentryInitialized) {
    // Dynamic import so the module is still a no-op when Sentry is absent
    import('@sentry/node')
      .then((Sentry) => {
        Sentry.captureException(err);
        next(err);
      })
      .catch(() => next(err));
  } else {
    next(err);
  }
}
