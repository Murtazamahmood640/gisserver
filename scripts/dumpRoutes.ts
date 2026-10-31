import fs from 'fs';
import path from 'path';
import app from '../app';
import {
  refreshIpLimiter,
  refreshTokenHashLimiter,
  loginFailedEmailIpLimiter,
  loginIpCapLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  resendVerificationLimiter,
  authLimiter,
  publicFormLimiter,
  couponValidateLimiter,
  bookingLookupLimiter,
  availabilityLimiter,
  bookingCreationLimiter,
  techApplyLimiter,
  signedUrlLimiter,
  partsImageUploadLimiter,
} from '../middleware/rateLimiter';
import {
  authenticateToken,
  optionalAuthenticateToken,
  requireAdminRole,
  requireRoles,
} from '../middleware/auth';

export interface RoutePermissionInfo {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  accessLevel: 'public' | 'optional-auth' | 'authenticated' | 'role-gated';
  roles: string[];
  limiters: string[];
  notes?: string;
}

const KNOWN_LIMITERS = new Map<any, string>([
  [refreshIpLimiter, 'refreshIpLimiter'],
  [refreshTokenHashLimiter, 'refreshTokenHashLimiter'],
  [loginFailedEmailIpLimiter, 'loginFailedEmailIpLimiter'],
  [loginIpCapLimiter, 'loginIpCapLimiter'],
  [registerLimiter, 'registerLimiter'],
  [forgotPasswordLimiter, 'forgotPasswordLimiter'],
  [resetPasswordLimiter, 'resetPasswordLimiter'],
  [resendVerificationLimiter, 'resendVerificationLimiter'],
  [authLimiter, 'authLimiter'],
  [publicFormLimiter, 'publicFormLimiter'],
  [couponValidateLimiter, 'couponValidateLimiter'],
  [bookingLookupLimiter, 'bookingLookupLimiter'],
  [availabilityLimiter, 'availabilityLimiter'],
  [bookingCreationLimiter, 'bookingCreationLimiter'],
  [techApplyLimiter, 'techApplyLimiter'],
  [signedUrlLimiter, 'signedUrlLimiter'],
  [partsImageUploadLimiter, 'partsImageUploadLimiter'],
]);

// Explicit allow-list of routes accessible by any authenticated user without role restriction
export const ANY_AUTHENTICATED_ALLOWLIST = new Set([
  'GET /api/auth/verify',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/change-password',
  'GET /api/v1/auth/me',
  'PATCH /api/v1/auth/me',
  'GET /api/v1/customers/me',
  'PUT /api/v1/customers/me',
  'POST /api/v1/customers/me/addresses',
  'PUT /api/v1/customers/me/addresses/:addressId',
  'DELETE /api/v1/customers/me/addresses/:addressId',
  'POST /api/v1/vehicles',
  'GET /api/v1/vehicles',
  'GET /api/v1/vehicles/:id',
  'PUT /api/v1/vehicles/:id',
  'DELETE /api/v1/vehicles/:id',
  'GET /api/v1/bookings/mine',
]);

const KNOWN_PREFIXES = [
  '/api/v1/admin/booking-settings',
  '/api/v1/admin/dispatch-settings',
  '/api/v1/admin/customers',
  '/api/v1/admin',
  '/api/v1/auth',
  '/api/v1/catalog',
  '/api/v1/pricing',
  '/api/v1/customers',
  '/api/v1/vehicles',
  '/api/v1/bookings',
  '/api/v1/technicians',
  '/api/v1/suppliers',
  '/api/v1/dispatch',
  '/api/v1/jobs',
  '/api/v1/tracking',
  '/api/v1/parts',
];

export function extractRoutes(): RoutePermissionInfo[] {
  const router = (app as any).router;
  if (!router || !router.stack) {
    throw new Error('Express router stack not accessible on app.router');
  }

  const routes: RoutePermissionInfo[] = [];

  for (const layer of router.stack) {
    // 1. Direct routes mounted on app
    if (layer.route) {
      const routePath = layer.route.path;
      const methods = Object.keys(layer.route.methods)
        .map((m) => m.toUpperCase() as RoutePermissionInfo['method']);

      for (const method of methods) {
        routes.push(analyzeRoute(method, routePath, layer.route.stack));
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      // 2. Subrouters mounted via app.use(prefix, subRouter)
      let matchedPrefix = '';
      for (const prefix of KNOWN_PREFIXES) {
        if (layer.matchers && layer.matchers[0]) {
          const matchResult = layer.matchers[0](prefix);
          if (matchResult && matchResult.path === prefix) {
            matchedPrefix = prefix;
            break;
          }
        }
      }

      if (!matchedPrefix) continue;

      // Check router-level middlewares (e.g. router.use(authenticateToken))
      const routerMiddlewares: any[] = [];
      for (const subLayer of layer.handle.stack) {
        if (!subLayer.route && typeof subLayer.handle === 'function') {
          routerMiddlewares.push(subLayer.handle);
        }
      }

      for (const subLayer of layer.handle.stack) {
        if (subLayer.route) {
          const subPath = subLayer.route.path === '/' ? '' : subLayer.route.path;
          const fullPath = `${matchedPrefix}${subPath}`;
          const methods = Object.keys(subLayer.route.methods)
            .map((m) => m.toUpperCase() as RoutePermissionInfo['method']);

          const combinedHandlers = [...routerMiddlewares, ...subLayer.route.stack.map((s: any) => s.handle)];

          for (const method of methods) {
            routes.push(analyzeRoute(method, fullPath, combinedHandlers));
          }
        }
      }
    }
  }

  // Sort deterministically by path, then method
  routes.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.method.localeCompare(b.method);
  });

  return routes;
}

function analyzeRoute(
  method: RoutePermissionInfo['method'],
  fullPath: string,
  handlers: any[]
): RoutePermissionInfo {
  const routeKey = `${method} ${fullPath}`;
  const limiters: string[] = [];
  let isAuth = false;
  let isOptionalAuth = false;
  let requiredRoles: string[] | null = null;
  let notes: string | undefined;

  for (const h of handlers) {
    const fn = typeof h === 'function' ? h : h?.handle;
    if (!fn) continue;

    // Check rate limiters
    if (fn._limiterName) {
      if (!limiters.includes(fn._limiterName)) limiters.push(fn._limiterName);
    } else if (KNOWN_LIMITERS.has(fn)) {
      const name = KNOWN_LIMITERS.get(fn)!;
      if (!limiters.includes(name)) limiters.push(name);
    }

    // Check roles
    if (fn._requiredRoles) {
      requiredRoles = [...fn._requiredRoles];
    }

    // Check auth
    if (fn === authenticateToken || fn.name === 'authenticateToken') {
      isAuth = true;
    } else if (fn === optionalAuthenticateToken || fn.name === 'optionalAuthenticateToken') {
      isOptionalAuth = true;
    }
  }

  // Handle special legacy endpoints with inline handlers
  if (routeKey === 'GET /api/feedback') {
    return {
      method,
      path: fullPath,
      accessLevel: 'optional-auth',
      roles: ['public (if status=publish)', 'admin', 'dispatcher'],
      limiters,
      notes: 'Public when status=publish; otherwise requires admin or dispatcher',
    };
  }

  if (routeKey === 'GET /api/blogs') {
    return {
      method,
      path: fullPath,
      accessLevel: 'optional-auth',
      roles: ['public', 'admin (if all=true)'],
      limiters,
      notes: 'Public for published blogs; requires admin when all=true',
    };
  }

  if (routeKey === 'GET /api/coupons') {
    return {
      method,
      path: fullPath,
      accessLevel: 'optional-auth',
      roles: ['public (if active=true)', 'admin'],
      limiters,
      notes: 'Public when active=true; requires admin otherwise',
    };
  }

  if (routeKey === 'GET /api/cron/sync-facebook') {
    return {
      method,
      path: fullPath,
      accessLevel: 'role-gated',
      roles: ['cron-secret', 'admin'],
      limiters,
      notes: 'Requires Authorization: Bearer <CRON_SECRET> or admin JWT',
    };
  }

  if (routeKey === 'POST /api/v1/technicians/cron/document-expiry-check') {
    return {
      method,
      path: fullPath,
      accessLevel: 'role-gated',
      roles: ['cron-secret'],
      limiters,
      notes: 'Requires Authorization: Bearer <CRON_SECRET>',
    };
  }

  // Determine access level & roles
  if (requiredRoles && requiredRoles.length > 0) {
    return {
      method,
      path: fullPath,
      accessLevel: 'role-gated',
      roles: requiredRoles,
      limiters,
      notes,
    };
  }

  if (isOptionalAuth) {
    return {
      method,
      path: fullPath,
      accessLevel: 'optional-auth',
      roles: ['public', 'customer', 'technician', 'supplier', 'admin', 'dispatcher'],
      limiters,
      notes: notes || 'Allows guest token or authenticated user session',
    };
  }

  if (isAuth) {
    if (ANY_AUTHENTICATED_ALLOWLIST.has(routeKey)) {
      return {
        method,
        path: fullPath,
        accessLevel: 'authenticated',
        roles: ['customer', 'technician', 'supplier', 'admin', 'dispatcher'],
        limiters,
        notes: 'Accessible to any authenticated user session regardless of role',
      };
    }

    return {
      method,
      path: fullPath,
      accessLevel: 'authenticated',
      roles: ['customer', 'technician', 'supplier', 'admin', 'dispatcher'],
      limiters,
      notes,
    };
  }

  return {
    method,
    path: fullPath,
    accessLevel: 'public',
    roles: [],
    limiters,
    notes,
  };
}

export function generateMarkdown(routes: RoutePermissionInfo[]): string {
  let md = '# Route Permissions & Authorization Matrix\n\n';
  md += `*Generated automatically from Express router stack at ${new Date().toISOString()}*\n\n`;
  md += `Total Mounted Endpoints: **${routes.length}**\n\n`;

  md += '| Method | Path | Access Level | Allowed Roles | Rate Limiters | Notes |\n';
  md += '| :--- | :--- | :---: | :--- | :--- | :--- |\n';

  for (const r of routes) {
    const rolesStr = r.roles.length > 0 ? r.roles.map((x) => `\`${x}\``).join(', ') : '*(public)*';
    const limitersStr = r.limiters.length > 0 ? r.limiters.map((x) => `\`${x}\``).join(', ') : '—';
    const notesStr = r.notes ? r.notes.replace(/\|/g, '\\|') : '—';
    md += `| **${r.method}** | \`${r.path}\` | \`${r.accessLevel}\` | ${rolesStr} | ${limitersStr} | ${notesStr} |\n`;
  }

  return md;
}

export function dumpRoutesToFiles(): { routes: RoutePermissionInfo[]; jsonPath: string; mdPath: string } {
  const routes = extractRoutes();
  const docsDir = path.resolve(__dirname, '../../docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const jsonPath = path.join(docsDir, 'route-permissions.json');
  const mdPath = path.join(docsDir, 'ROUTE-PERMISSIONS.md');

  fs.writeFileSync(jsonPath, JSON.stringify(routes, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, generateMarkdown(routes), 'utf8');

  return { routes, jsonPath, mdPath };
}

if (require.main === module || process.argv[1]?.includes('dumpRoutes')) {
  try {
    const { routes, jsonPath, mdPath } = dumpRoutesToFiles();
    console.log(`Successfully dumped ${routes.length} routes to:\n- ${jsonPath}\n- ${mdPath}`);
  } catch (err) {
    console.error('Error dumping routes:', err);
    process.exit(1);
  }
}
