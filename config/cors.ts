import logger from './logger';
import type { CorsOptions } from 'cors';

export function parseAllowedOrigins(): string[] {
  const origins: string[] = [
    'https://globalintegratedsupport.com',
    'https://www.globalintegratedsupport.com',
    'https://gis.tintsshine.com',
  ];

  if (process.env.FRONTEND_URL) {
    const customOrigins = process.env.FRONTEND_URL.split(',')
      .map((url) => url.trim().replace(/\/$/, ''))
      .filter(Boolean);
    origins.push(...customOrigins);
  }

  // Include common local dev origins if not in strict production mode
  if (process.env.NODE_ENV !== 'production') {
    origins.push(
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:3000',
      'http://localhost:8080',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3000'
    );
  }

  return Array.from(new Set(origins));
}

export function isOriginAllowed(origin?: string): boolean {
  if (!origin) return false;
  const cleanOrigin = origin.replace(/\/$/, '');
  const allowed = parseAllowedOrigins();
  if (allowed.includes(cleanOrigin)) return true;

  // Allow all Vercel deployment preview / production domains
  if (/^https:\/\/[a-zA-Z0-9_-]+\.vercel\.app$/.test(cleanOrigin)) {
    return true;
  }

  if (
    process.env.NODE_ENV !== 'production' &&
    (/^http:\/\/localhost:\d+$/.test(cleanOrigin) ||
      /^http:\/\/127\.0\.0\.1:\d+$/.test(cleanOrigin))
  ) {
    return true;
  }
  return false;
}

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (curl, server-to-server, mobile native)
    if (!origin) {
      return callback(null, true);
    }

    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    logger.warn({ origin }, '[CORS] Origin blocked by CORS policy');
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Client',
    'X-Booking-Token',
    'X-Request-Id',
  ],
};

