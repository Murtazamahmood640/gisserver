import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import { hashToken } from '../utils/jwt';
import logger from '../config/logger';

let redisClient: Redis | null = null;

/**
 * Returns a RedisStore instance if REDIS_URL is configured,
 * otherwise returns undefined to use the default in-memory store.
 *
 * NOTE: On Vercel / serverless deployments, in-memory limits are per-instance.
 * Setting REDIS_URL enables distributed rate limiting across all instances.
 */
export function getLimiterStore(prefix = 'rl:') {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    if (!redisClient) {
      try {
        redisClient = new Redis(redisUrl, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: false,
          lazyConnect: true,
        });
        redisClient.connect().catch((err) => {
          logger.warn({ err }, 'Redis connection failed for rate-limiter, using memory fallback');
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to create Redis client for rate limiting');
      }
    }
    if (redisClient) {
      return new RedisStore({
        // @ts-expect-error - ioredis sendCommand compatibility
        sendCommand: (...args: string[]) => redisClient!.call(...args),
        prefix,
      });
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. Refresh token limiters:
//    - 300 requests per 15 min per IP
//    - 10 requests per 15 min keyed by refresh token hash (prevents hammering)
//    - Safely skips if refreshToken is missing or not a string
// ---------------------------------------------------------------------------
export const refreshIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:refresh:ip:'),
  message: {
    success: false,
    message: 'Too many token refresh requests from this IP, please try again later',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many token refresh requests from this IP, please try again later',
    },
  },
});

function extractRefreshToken(req: any): string | null {
  if (req.body?.refreshToken && typeof req.body.refreshToken === 'string' && req.body.refreshToken.trim()) {
    return req.body.refreshToken.trim();
  }
  const cookies = req.cookies || {};
  if (cookies.refreshToken && typeof cookies.refreshToken === 'string' && cookies.refreshToken.trim()) {
    return cookies.refreshToken.trim();
  }
  if (req.headers?.cookie) {
    const match = (req.headers.cookie as string).match(/(?:^|;\s*)refreshToken=([^;]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1].trim());
      } catch {
        return match[1].trim();
      }
    }
  }
  return null;
}

export const refreshTokenHashLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skip: (req) => {
    const token = extractRefreshToken(req);
    return !token;
  },
  store: getLimiterStore('rl:refresh:token:'),
  keyGenerator: (req) => {
    const token = extractRefreshToken(req);
    return token ? hashToken(token) : (req.ip || 'unknown');
  },
  message: {
    success: false,
    message: 'Too many refresh attempts for this token, please re-authenticate',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many refresh attempts for this token, please re-authenticate',
    },
  },
});

// ---------------------------------------------------------------------------
// 2. Login limiters:
//    - 5 failed attempts per 15 min per email+IP (skipSuccessfulRequests)
//    - looser per-IP cap of 100 per 15 min (skipSuccessfulRequests)
// ---------------------------------------------------------------------------
export const loginFailedEmailIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:login:failed:'),
  keyGenerator: (req) => {
    const email = (req.body?.email as string)?.trim().toLowerCase() || '';
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `${ip}:${email}`;
  },
  message: {
    success: false,
    message: 'Too many failed login attempts, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many failed login attempts, please try again after 15 minutes',
    },
  },
});

export const loginIpCapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:login:ip:'),
  message: {
    success: false,
    message: 'Too many login attempts from this IP, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many login attempts from this IP, please try again after 15 minutes',
    },
  },
});

// ---------------------------------------------------------------------------
// 3. Register limiter:
//    - 10 per hour per IP
// ---------------------------------------------------------------------------
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:register:'),
  message: {
    success: false,
    message: 'Too many registrations from this IP, please try again after an hour',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many registrations from this IP, please try again after an hour',
    },
  },
});

// ---------------------------------------------------------------------------
// 4. Forgot-password & Reset-password limiters:
//    - 5 per 15 min keyed by IP + email
// ---------------------------------------------------------------------------
export const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:forgot:'),
  keyGenerator: (req) => {
    const email = (req.body?.email as string)?.trim().toLowerCase() || '';
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `${ip}:${email}`;
  },
  message: {
    success: false,
    message: 'Too many password reset requests, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many password reset requests, please try again after 15 minutes',
    },
  },
});

export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:reset:'),
  keyGenerator: (req) => {
    const email = (req.body?.email as string)?.trim().toLowerCase() || '';
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `${ip}:${email}`;
  },
  message: {
    success: false,
    message: 'Too many password reset attempts, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many password reset attempts, please try again after 15 minutes',
    },
  },
});

// ---------------------------------------------------------------------------
// 5. Resend-verification limiter:
//    - 3 per hour keyed by IP + email
// ---------------------------------------------------------------------------
export const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:resend:'),
  keyGenerator: (req) => {
    const email = (req.body?.email as string)?.trim().toLowerCase() || '';
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `${ip}:${email}`;
  },
  message: {
    success: false,
    message: 'Too many verification email requests. Please try again after an hour.',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many verification email requests. Please try again after an hour.',
    },
  },
});

// ---------------------------------------------------------------------------
// 6. Legacy limiters (kept for backwards compatibility on /api/auth and public forms)
// ---------------------------------------------------------------------------
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:legacy:auth:'),
  message: {
    success: false,
    message: 'Too many login attempts, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many login attempts, please try again after 15 minutes',
    },
  },
});

export const publicFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:forms:'),
  message: {
    success: false,
    message: 'Too many submissions from this IP, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many submissions from this IP, please try again after 15 minutes',
    },
  },
});

// ---------------------------------------------------------------------------
// 7. Coupon validation limiter: 20 per 15 min per IP
// ---------------------------------------------------------------------------
export const couponValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:coupon:validate:'),
  message: {
    success: false,
    message: 'Too many coupon validation attempts, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many coupon validation attempts, please try again after 15 minutes',
    },
  },
});

// ---------------------------------------------------------------------------
// 8. Booking token lookup limiter:
//    - Authenticated users: 120 per 15 min keyed by userId
//    - Guests: 20 per 15 min keyed by IP
// ---------------------------------------------------------------------------
export const bookingLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => ((req as any).user?.userId ? 120 : 20),
  keyGenerator: (req) => {
    const userId = (req as any).user?.userId;
    if (userId) {
      return `usr:${userId}`;
    }
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `ip:${ip}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:booking:lookup:'),
  message: {
    success: false,
    message: 'Too many booking lookup attempts, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many booking lookup attempts, please try again after 15 minutes',
    },
  },
});

// ---------------------------------------------------------------------------
// 9. Availability rate limiter: 120 per 15 min per IP
// ---------------------------------------------------------------------------
export const availabilityLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: getLimiterStore('rl:availability:'),
  message: {
    success: false,
    message: 'Too many availability requests, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many availability requests, please try again after 15 minutes',
    },
  },
});

// ---------------------------------------------------------------------------
// 10. Booking creation limiter: 10 per 15 min per IP
//     (counts successful and failed creations, but skips 400 validation errors)
// ---------------------------------------------------------------------------
export const bookingCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skipFailedRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 400,
  store: getLimiterStore('rl:booking:create:'),
  message: {
    success: false,
    message: 'Too many booking submissions from this IP, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many booking submissions from this IP, please try again after 15 minutes',
    },
  },
});

// ---------------------------------------------------------------------------
// 11. Technician Apply Limiter: 5 per 15 min per user/IP
// ---------------------------------------------------------------------------
export const techApplyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => {
    const userId = (req as any).user?.userId;
    if (userId) return `usr:${userId}`;
    return req.ip || req.socket?.remoteAddress || 'unknown';
  },
  store: getLimiterStore('rl:tech:apply:'),
  message: {
    success: false,
    message: 'Too many technician application requests, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many technician application requests, please try again after 15 minutes',
    },
  },
});

// ---------------------------------------------------------------------------
// 12. Signed Document URL Limiter: 60 per 15 min per user/IP
// ---------------------------------------------------------------------------
export const signedUrlLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => {
    const userId = (req as any).user?.userId;
    if (userId) return `usr:${userId}`;
    return req.ip || req.socket?.remoteAddress || 'unknown';
  },
  store: getLimiterStore('rl:signedurl:'),
  message: {
    success: false,
    message: 'Too many document URL requests, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many document URL requests, please try again after 15 minutes',
    },
  },
});

// ---------------------------------------------------------------------------
// 13. Parts Image Upload Limiter: 20 per 15 min per user/IP
// ---------------------------------------------------------------------------
export const partsImageUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => {
    const userId = (req as any).user?.userId;
    if (userId) return `usr:${userId}`;
    return req.ip || req.socket?.remoteAddress || 'unknown';
  },
  store: getLimiterStore('rl:parts:image:upload:'),
  message: {
    success: false,
    message: 'Too many image upload requests, please try again after 15 minutes',
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many image upload requests, please try again after 15 minutes',
    },
  },
});

(refreshIpLimiter as any)._limiterName = 'refreshIpLimiter';
(refreshTokenHashLimiter as any)._limiterName = 'refreshTokenHashLimiter';
(loginFailedEmailIpLimiter as any)._limiterName = 'loginFailedEmailIpLimiter';
(loginIpCapLimiter as any)._limiterName = 'loginIpCapLimiter';
(registerLimiter as any)._limiterName = 'registerLimiter';
(forgotPasswordLimiter as any)._limiterName = 'forgotPasswordLimiter';
(resetPasswordLimiter as any)._limiterName = 'resetPasswordLimiter';
(resendVerificationLimiter as any)._limiterName = 'resendVerificationLimiter';
(authLimiter as any)._limiterName = 'authLimiter';
(publicFormLimiter as any)._limiterName = 'publicFormLimiter';
(couponValidateLimiter as any)._limiterName = 'couponValidateLimiter';
(bookingLookupLimiter as any)._limiterName = 'bookingLookupLimiter';
(availabilityLimiter as any)._limiterName = 'availabilityLimiter';
(bookingCreationLimiter as any)._limiterName = 'bookingCreationLimiter';
(techApplyLimiter as any)._limiterName = 'techApplyLimiter';
(signedUrlLimiter as any)._limiterName = 'signedUrlLimiter';
(partsImageUploadLimiter as any)._limiterName = 'partsImageUploadLimiter';


