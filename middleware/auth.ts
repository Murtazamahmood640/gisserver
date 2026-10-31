import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import {
  verifyToken,
  verifyAccessToken,
  decodeToken,
  JwtPayload,
  AccessTokenPayload,
} from '../utils/jwt';
import { User, UserRole } from '../models/User';

export type AuthUser = {
  userId: string;
  email: string;
  role: 'customer' | 'technician' | 'supplier' | 'admin' | 'dispatcher';
  status?: 'active' | 'suspended' | 'pending';
  emailVerified?: boolean;
};

// ---------------------------------------------------------------------------
// In-Memory User Status Cache (max 30s TTL, invalidated on status changes)
// ---------------------------------------------------------------------------
interface CachedUserStatus {
  status: 'active' | 'suspended' | 'pending';
  isActive: boolean;
  role: AuthUser['role'];
  expiresAt: number;
}

const userStatusCache = new Map<string, CachedUserStatus>();

export function invalidateUserStatusCache(userId: string): void {
  if (userId) {
    userStatusCache.delete(userId.toString());
  }
}

export function clearUserStatusCache(): void {
  userStatusCache.clear();
}

async function getUserLiveStatus(userId: string): Promise<CachedUserStatus | null> {
  const key = userId.toString();
  const cached = userStatusCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  // If mongoose is disconnected and User.findById is not a Vitest spy/mock, avoid buffering hang
  const isMocked = (User.findById as any)?._isMockFunction || (User.findById as any)?.mock;
  if (mongoose.connection.readyState !== 1 && !isMocked) {
    return null;
  }

  try {
    const user = await User.findById(userId).select('status isActive role');
    if (!user) return null;
    const effectiveRole = user.getEffectiveRole ? user.getEffectiveRole() : (user.role === 'user' ? 'dispatcher' : user.role);
    const result: CachedUserStatus = {
      status: (user.status as any) || 'active',
      isActive: user.isActive !== false,
      role: effectiveRole as AuthUser['role'],
      expiresAt: now + 30 * 1000,
    };
    userStatusCache.set(key, result);
    return result;
  } catch {
    return cached || null;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      cookies?: Record<string, string>;
    }
  }
}

export function getTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
}

/**
 * Universal token authenticator:
 * Accepts both legacy 7d tokens (admin UI) and new 15m v1 tokens (mobile/web).
 * Reads the user's CURRENT status from the database on every request (cached <= 30s).
 * Immediately rejects suspended users with 403 ACCOUNT_SUSPENDED even if their token is valid.
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getTokenFromRequest(req);

  if (!token) {
    res.status(401).json({
      success: false,
      message: 'Access token required',
      error: {
        code: 'UNAUTHORIZED',
        message: 'Access token required',
      },
    });
    return;
  }

  // Explicitly reject non-authentication token types (password reset, email verification)
  const unverified = decodeToken(token);
  if (
    unverified &&
    (unverified.type === 'password_reset' || unverified.type === 'email_verification')
  ) {
    res.status(401).json({
      success: false,
      message: 'Invalid token type for authorization',
      error: {
        code: 'INVALID_TOKEN_TYPE',
        message: `Token of type '${unverified.type}' cannot be used as an authorization bearer token`,
      },
    });
    return;
  }

  let verifiedUserId: string | null = null;
  let verifiedEmail: string = '';
  let tokenRole: string = 'customer';
  let tokenStatus: string = 'active';
  let tokenEmailVerified: boolean = true;

  // Try v1 access token first, fall back to legacy token
  const v1User = verifyAccessToken(token);
  if (v1User) {
    verifiedUserId = v1User.userId;
    verifiedEmail = v1User.email;
    tokenRole = (v1User.role as string) === 'user' ? 'dispatcher' : v1User.role;
    tokenStatus = v1User.status || 'active';
    tokenEmailVerified = v1User.emailVerified !== false;
  } else {
    // Fallback to legacy JWT verification
    const legacyUser = verifyToken(token);
    if (!legacyUser) {
      res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired token',
        },
      });
      return;
    }
    verifiedUserId = legacyUser.userId;
    verifiedEmail = legacyUser.email;
    tokenRole = legacyUser.role === 'user' ? 'dispatcher' : (legacyUser.role as AuthUser['role']);
    tokenStatus = 'active';
    tokenEmailVerified = true;
  }

  // Check live status from database (cached <= 30 seconds)
  const liveStatus = await getUserLiveStatus(verifiedUserId);
  if (liveStatus) {
    if (!liveStatus.isActive || liveStatus.status === 'suspended') {
      res.status(403).json({
        success: false,
        message: 'Account is suspended. Please contact support.',
        error: { code: 'ACCOUNT_SUSPENDED', message: 'Account is suspended' },
      });
      return;
    }

    req.user = {
      userId: verifiedUserId,
      email: verifiedEmail,
      role: liveStatus.role,
      status: liveStatus.status,
      emailVerified: tokenEmailVerified,
    };
    return next();
  }

  // If user record no longer exists or DB lookup returned null
  if (tokenStatus === 'suspended') {
    res.status(403).json({
      success: false,
      message: 'Account is suspended. Please contact support.',
      error: { code: 'ACCOUNT_SUSPENDED', message: 'Account is suspended' },
    });
    return;
  }

  req.user = {
    userId: verifiedUserId,
    email: verifiedEmail,
    role: tokenRole as AuthUser['role'],
    status: tokenStatus as any,
    emailVerified: tokenEmailVerified,
  };
  next();
}

/**
 * Optional token authenticator:
 * If an Authorization header is provided, verifies it and populates req.user.
 * If no token is provided, proceeds as guest without failing.
 */
export async function optionalAuthenticateToken(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = getTokenFromRequest(req);
  if (!token) return next();

  try {
    const unverified = decodeToken(token);
    if (
      unverified &&
      (unverified.type === 'password_reset' || unverified.type === 'email_verification')
    ) {
      return next();
    }

    const v1User = verifyAccessToken(token);
    if (v1User) {
      const liveStatus = await getUserLiveStatus(v1User.userId);
      if (liveStatus && (!liveStatus.isActive || liveStatus.status === 'suspended')) {
        return next();
      }
      if (v1User.status !== 'suspended') {
        const mappedRole = (v1User.role as string) === 'user' ? 'dispatcher' : (liveStatus?.role || v1User.role);
        req.user = {
          userId: v1User.userId,
          email: v1User.email,
          role: mappedRole as AuthUser['role'],
          status: liveStatus?.status || v1User.status,
          emailVerified: v1User.emailVerified,
        };
        return next();
      }
    }

    const legacyUser = verifyToken(token);
    if (legacyUser) {
      const liveStatus = await getUserLiveStatus(legacyUser.userId);
      if (liveStatus && (!liveStatus.isActive || liveStatus.status === 'suspended')) {
        return next();
      }
      const mappedRole =
        legacyUser.role === 'user' ? 'dispatcher' : (liveStatus?.role || (legacyUser.role as AuthUser['role']));
      req.user = {
        userId: legacyUser.userId,
        email: legacyUser.email,
        role: mappedRole as AuthUser['role'],
        status: liveStatus?.status || 'active',
        emailVerified: true,
      };
    }
  } catch {
    // Proceed as unauthenticated guest
  }
  next();
}

/**
 * Backwards-compatible admin gate: only 'admin' role allowed.
 */
export function requireAdminRole(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({
      success: false,
      message: 'Admin access required',
      error: {
        code: 'FORBIDDEN',
        message: 'Admin access required',
      },
    });
    return;
  }

  next();
}
(requireAdminRole as any)._requiredRoles = ['admin'];

/**
 * Role-based access control middleware allowing one or multiple roles.
 * Usage: requireRoles('admin', 'dispatcher')
 */
export function requireRoles(...roles: Array<AuthUser['role']>) {
  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required',
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        message: `Forbidden: requires one of [${roles.join(', ')}] role`,
        error: {
          code: 'FORBIDDEN',
          message: `Access denied for role '${req.user.role}'`,
        },
      });
      return;
    }

    next();
  };
  (middleware as any)._requiredRoles = roles;
  return middleware;
}

/**
 * Middleware ensuring user has verified their email address.
 */
export function requireVerified(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: 'Authentication required',
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return;
  }

  if (req.user.emailVerified === false) {
    res.status(403).json({
      success: false,
      message: 'Email address verification required',
      error: {
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email address to access this resource',
      },
    });
    return;
  }

  next();
}

/**
 * Ownership helper: verifies resource owner matches authenticated user OR user is admin.
 * @param extractOwnerId Function taking request and returning the owner's userId string
 */
export function requireOwnershipOrAdmin(extractOwnerId: (req: Request) => string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required',
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    if (req.user.role === 'admin') {
      return next();
    }

    const ownerId = extractOwnerId(req);
    if (!ownerId || ownerId.toString() !== req.user.userId.toString()) {
      res.status(403).json({
        success: false,
        message: 'Forbidden: You do not own this resource',
        error: {
          code: 'FORBIDDEN',
          message: 'Ownership or administrative privilege required',
        },
      });
      return;
    }

    next();
  };
}
