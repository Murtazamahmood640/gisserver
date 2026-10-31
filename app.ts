import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import pinoHttp from 'pino-http';
import logger from './config/logger';
import { initSentry, sentryErrorHandler } from './config/sentry';

dotenv.config({ path: path.resolve(__dirname, '.env') });

// Fail fast if any required env var is missing.
// Must run after dotenv.config() but before any handler/service import
// that reads process.env at module-init time.
import { validateEnv } from './config/env';
validateEnv();

import { corsOptions } from './config/cors';
import { connectDB } from './config/database';

// Import route handlers
import authV1Router from './modules/auth/routes';
import catalogRouter from './modules/catalog/routes';
import pricingRouter from './modules/pricing/routes';
import customersRouter from './modules/customers/routes';
import vehiclesRouter from './modules/vehicles/routes';
import bookingsRouter from './modules/bookings/routes';
import bookingSettingsRouter from './modules/bookings/settingsRoutes';
import technicianRoutes from './modules/technicians/routes';
import supplierRoutes from './modules/suppliers/routes';
import customerAdminRoutes from './modules/technicians/customerAdminRoutes';
import adminRouter from './modules/admin/routes';
import { dispatchRouter, dispatchSettingsRouter } from './modules/dispatch/routes';
import { jobsRouter } from './modules/jobs/routes';
import { trackingRouter } from './modules/tracking/routes';
import { paymentsRouter } from './modules/payments/routes';
import { paymentsAdminRouter } from './modules/payments/adminRoutes';
import { payoutsAdminRouter } from './modules/payouts/adminRoutes';
import { webhookRouter } from './modules/payments/webhookRouter';
import partsRouter from './modules/parts/routes';
import authHandler from './handlers/auth';
import appointmentsHandler from './handlers/appointments';
import contactHandler from './handlers/contact';
import couponsHandler from './handlers/coupons';
import usersHandler from './handlers/users';
import feedbackHandler from './handlers/feedback';
import blogsHandler from './handlers/blogs';
import uploadHandler from './handlers/upload';
import facebookSyncHandler from './api/feedback/sync-facebook';

// Import security middlewares
import { authenticateToken, requireAdminRole, requireRoles } from './middleware/auth';
import { authLimiter, publicFormLimiter } from './middleware/rateLimiter';
import { validateBody } from './middleware/validate';
import { globalErrorHandler } from './middleware/errorHandler';

// Import validation schemas
import {
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  appointmentSchema,
  contactSchema,
  feedbackSchema,
} from './validation/schemas';

const app = express();

// Trust proxy for real client IP behind Vercel, Nginx, or Docker reverse proxies
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxyConfig = trustProxyEnv !== undefined
  ? isNaN(Number(trustProxyEnv))
    ? trustProxyEnv === 'true'
      ? true
      : trustProxyEnv === 'false'
      ? false
      : trustProxyEnv
    : Number(trustProxyEnv)
  : 1;

app.set('trust proxy', trustProxyConfig);

// Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  })
);

// Strict CORS
app.use(cors(corsOptions));

// Stripe webhook (requires raw body, mounted BEFORE express.json)
app.use('/api/v1/stripe', webhookRouter);

// Body parsing with limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Cookie parsing (zero external dependencies)
app.use((req: Request, _res: Response, next: NextFunction) => {
  const cookieHeader = req.headers.cookie;
  const cookies: Record<string, string> = {};
  if (cookieHeader) {
    const pairs = cookieHeader.split(';');
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        try {
          cookies[key] = decodeURIComponent(val);
        } catch {
          cookies[key] = val;
        }
      }
    }
  }
  req.cookies = cookies;
  next();
});

/**
 * Request serializer for pino-http.
 * Redacts/strips query strings (especially tokens) from logged URLs,
 * and whitelists safe headers (never logging authorization or x-booking-token).
 */
export function serializePinoReq(req: any) {
  const rawUrl = req?.url || '';
  const sanitizedUrl = rawUrl.split('?')[0];

  return {
    id: req?.id,
    method: req?.method,
    url: sanitizedUrl,
    // Explicit safe headers whitelist; authorization and x-booking-token are never logged
    headers: {
      'user-agent': req?.headers ? req.headers['user-agent'] : undefined,
      'content-type': req?.headers ? req.headers['content-type'] : undefined,
      host: req?.headers ? req.headers.host : undefined,
    },
  };
}

// Structured HTTP request logging (no-op in test mode via logger's "silent" level)
app.use(
  pinoHttp({
    logger,
    // Assign a unique request ID to every incoming request
    genReqId: (req) =>
      (req.headers['x-request-id'] as string) ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    // Never log raw request bodies (may contain PII / passwords)
    serializers: {
      req: serializePinoReq,
      res: (res) => ({ statusCode: res.statusCode }),
    },
  })
);

// Initialise Sentry (no-op when SENTRY_DSN is absent)
initSentry(app).catch((err) => logger.warn({ err }, 'Sentry init error'));

// ---------------------------------------------------------------------------
// 1. Health check (Public) — must respond even when DB is down
// ---------------------------------------------------------------------------
app.get('/api/health', async (_req: Request, res: Response) => {
  const startTime = process.hrtime.bigint();
  // Read version from package.json (resolveJsonModule enabled in tsconfig)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('../package.json') as { version: string };

  let dbStatus: 'connected' | 'disconnected' = 'disconnected';
  try {
    // connectDB is statically imported at the top of this file so the Vitest
    // mock in tests/security.test.ts covers this call correctly.
    const conn = await Promise.race([
      connectDB(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('DB health timeout')), 3000)
      ),
    ]);
    if (conn) dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }

  const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  const isHealthy = dbStatus === 'connected';

  const body = {
    status: isHealthy ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    version,
    timestamp: new Date().toISOString(),
    db: dbStatus,
    responseTimeMs: Math.round(durationMs),
  };

  res.status(isHealthy ? 200 : 503).json(body);
});


// ---------------------------------------------------------------------------
// 2. Authentication routes
// ---------------------------------------------------------------------------
// V1 Multi-Role Authentication Router (customer, technician, supplier, admin, dispatcher)
app.use('/api/v1/auth', authV1Router);
// V1 Catalog and Pricing Routers
app.use('/api/v1/catalog', catalogRouter);
app.use('/api/v1/pricing', pricingRouter);
// V1 Customers, Vehicles, Bookings, and Settings Routers
app.use('/api/v1/customers', customersRouter);
app.use('/api/v1/vehicles', vehiclesRouter);
app.use('/api/v1/bookings', bookingsRouter);
app.use('/api/v1/admin/booking-settings', bookingSettingsRouter);
app.use('/api/v1/technicians', technicianRoutes);
app.use('/api/v1/suppliers', supplierRoutes);
app.use('/api/v1/admin/customers', customerAdminRoutes);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/dispatch', dispatchRouter);
app.use('/api/v1/admin/dispatch-settings', dispatchSettingsRouter);
app.use('/api/v1/jobs', jobsRouter);
app.use('/api/v1/tracking', trackingRouter);
app.use('/api/v1/payments', paymentsRouter);
app.use('/api/v1/admin', paymentsAdminRouter);
app.use('/api/v1/admin/payouts', payoutsAdminRouter);
app.use('/api/v1/parts', partsRouter);

// Legacy Authentication Endpoints (Admin panel backwards compatibility)
// Public: Login with rate limiting and Zod validation
app.post(
  '/api/auth/login',
  authLimiter,
  validateBody(loginSchema),
  async (req: Request, res: Response) => {
    await authHandler({ ...req, query: { action: 'login' } } as unknown as Request, res);
  }
);

// Public: Forgot password with rate limiting and Zod validation
app.post(
  '/api/auth/forgot-password',
  authLimiter,
  validateBody(forgotPasswordSchema),
  async (req: Request, res: Response) => {
    await authHandler(
      { ...req, query: { action: 'forgot-password' } } as unknown as Request,
      res
    );
  }
);

// Public: Reset password with rate limiting and Zod validation
app.post(
  '/api/auth/reset-password',
  authLimiter,
  validateBody(resetPasswordSchema),
  async (req: Request, res: Response) => {
    await authHandler(
      { ...req, query: { action: 'reset-password' } } as unknown as Request,
      res
    );
  }
);

// Admin / Auth: Token verification
app.get('/api/auth/verify', async (req: Request, res: Response) => {
  await authHandler({ ...req, query: { action: 'verify' } } as unknown as Request, res);
});

// Admin-only: Register new user (protected)
app.post(
  '/api/auth/register',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await authHandler({ ...req, query: { action: 'register' } } as unknown as Request, res);
  }
);

// ---------------------------------------------------------------------------
// 3. Appointments routes
// ---------------------------------------------------------------------------
// Public: Customer creates appointment with rate limiting and Zod validation
app.post(
  '/api/appointments',
  publicFormLimiter,
  validateBody(appointmentSchema),
  async (req: Request, res: Response) => {
    await appointmentsHandler(req as any, res as any);
  }
);

// Admin-only: List appointments
app.get(
  '/api/appointments',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await appointmentsHandler(req as any, res as any);
  }
);

// Admin-only: Update appointment
app.put(
  '/api/appointments/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await appointmentsHandler(
      { ...req, query: { id: req.params.id } } as any,
      res as any
    );
  }
);

// Admin-only: Delete appointment
app.delete(
  '/api/appointments/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await appointmentsHandler(
      { ...req, query: { id: req.params.id } } as any,
      res as any
    );
  }
);

// ---------------------------------------------------------------------------
// 4. Contact inquiries
// ---------------------------------------------------------------------------
// Public: Customer submits inquiry with rate limiting and Zod validation
app.post(
  '/api/contact',
  publicFormLimiter,
  validateBody(contactSchema),
  async (req: Request, res: Response) => {
    await contactHandler(req as any, res as any);
  }
);

// Admin or Dispatcher: List contact inquiries
app.get(
  '/api/contact',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  async (req: Request, res: Response) => {
    await contactHandler(req as any, res as any);
  }
);

// Admin or Dispatcher: Update contact inquiry
app.put(
  '/api/contact/:id',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  async (req: Request, res: Response) => {
    await contactHandler(
      { ...req, query: { id: req.params.id } } as any,
      res as any
    );
  }
);

// Admin-only: Delete contact inquiry
app.delete(
  '/api/contact/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await contactHandler(
      { ...req, query: { id: req.params.id } } as any,
      res as any
    );
  }
);

// ---------------------------------------------------------------------------
// 5. Feedback / Reviews routes
// ---------------------------------------------------------------------------
// Public: Customer submits feedback with rate limiting and Zod validation
app.post(
  '/api/feedback',
  publicFormLimiter,
  validateBody(feedbackSchema),
  async (req: Request, res: Response) => {
    await feedbackHandler(req as any, res as any);
  }
);

// Public if status=publish; Admin or Dispatcher for all reviews
app.get(
  '/api/feedback',
  (req: Request, res: Response, next: NextFunction) => {
    if (req.query.status === 'publish') {
      return next();
    }
    return authenticateToken(req, res, () => {
      requireRoles('admin', 'dispatcher')(req, res, next);
    });
  },
  async (req: Request, res: Response) => {
    await feedbackHandler(req as any, res as any);
  }
);

// Admin-only: Update review status
app.put(
  '/api/feedback/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await feedbackHandler(
      { ...req, query: { id: req.params.id } } as any,
      res as any
    );
  }
);

// Admin-only: Delete review
app.delete(
  '/api/feedback/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await feedbackHandler(
      { ...req, query: { id: req.params.id } } as any,
      res as any
    );
  }
);

// Admin-only: Facebook manual sync
app.post(
  '/api/feedback/sync-facebook',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await facebookSyncHandler(req as any, res as any);
  }
);

// Cron or Admin secret: Automated Facebook sync
app.get(
  '/api/cron/sync-facebook',
  (req: Request, res: Response, next: NextFunction) => {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'];
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      return next();
    }
    return authenticateToken(req, res, () => {
      requireAdminRole(req, res, next);
    });
  },
  async (req: Request, res: Response) => {
    await facebookSyncHandler(req as any, res as any);
  }
);

// ---------------------------------------------------------------------------
// 6. Blogs routes
// ---------------------------------------------------------------------------
// Public: Read single blog post by slug
app.get('/api/blogs/:slug', async (req: Request, res: Response) => {
  await blogsHandler({ ...req, query: { slug: req.params.slug } } as any, res as any);
});

// Public: List published blogs; Admin-only: all=true
app.get(
  '/api/blogs',
  (req: Request, res: Response, next: NextFunction) => {
    if (req.query.all === 'true') {
      return authenticateToken(req, res, () => {
        requireAdminRole(req, res, next);
      });
    }
    return next();
  },
  async (req: Request, res: Response) => {
    await blogsHandler(req as any, res as any);
  }
);

// Admin-only: Create blog post
app.post(
  '/api/blogs',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await blogsHandler(req as any, res as any);
  }
);

// Admin-only: Update blog post
app.put(
  '/api/blogs/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await blogsHandler({ ...req, query: { id: req.params.id } } as any, res as any);
  }
);

// Admin-only: Delete blog post
app.delete(
  '/api/blogs/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await blogsHandler({ ...req, query: { id: req.params.id } } as any, res as any);
  }
);

// ---------------------------------------------------------------------------
// 7. Upload route (Admin-only, validated 5MB max, JPEG/PNG/WebP)
// ---------------------------------------------------------------------------
app.post(
  '/api/upload',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await uploadHandler(req, res);
  }
);

// ---------------------------------------------------------------------------
// 8. Coupons routes
// ---------------------------------------------------------------------------
// Public if active=true; Admin-only for full coupon management
app.get(
  '/api/coupons',
  (req: Request, res: Response, next: NextFunction) => {
    if (req.query.active === 'true') {
      return next();
    }
    return authenticateToken(req, res, () => {
      requireAdminRole(req, res, next);
    });
  },
  async (req: Request, res: Response) => {
    await couponsHandler(req as any, res as any);
  }
);

// Admin-only: Create coupon
app.post(
  '/api/coupons',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await couponsHandler(req as any, res as any);
  }
);

// Admin-only: Update coupon
app.put(
  '/api/coupons/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await couponsHandler({ ...req, query: { id: req.params.id } } as any, res as any);
  }
);

// Admin-only: Delete coupon
app.delete(
  '/api/coupons/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await couponsHandler({ ...req, query: { id: req.params.id } } as any, res as any);
  }
);

// ---------------------------------------------------------------------------
// 9. Users routes (Admin-only)
// ---------------------------------------------------------------------------
app.get(
  '/api/users',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await usersHandler(req as any, res as any);
  }
);

app.post(
  '/api/users',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await usersHandler(req as any, res as any);
  }
);

app.put(
  '/api/users/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await usersHandler({ ...req, query: { id: req.params.id } } as any, res as any);
  }
);

app.put(
  '/api/users',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await usersHandler(req as any, res as any);
  }
);

app.delete(
  '/api/users/:id',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await usersHandler({ ...req, query: { id: req.params.id } } as any, res as any);
  }
);

app.delete(
  '/api/users',
  authenticateToken,
  requireAdminRole,
  async (req: Request, res: Response) => {
    await usersHandler(req as any, res as any);
  }
);

// ---------------------------------------------------------------------------
// 10. Global Error Handling and 404
// ---------------------------------------------------------------------------
// Sentry error capture (no-op when SENTRY_DSN is unset)
app.use(sentryErrorHandler);
app.use(globalErrorHandler);

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
  });
});

export default app;
