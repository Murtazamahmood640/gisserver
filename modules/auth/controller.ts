import { Request, Response, NextFunction } from 'express';
import { AuthService } from './service';
import logger from '../../config/logger';
import { isOriginAllowed } from '../../config/cors';

export function isWebClient(req: Request): boolean {
  const clientHeader = req.headers['x-client'];
  return typeof clientHeader === 'string' && clientHeader.trim().toLowerCase() === 'web';
}

export function getCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
  domain?: string;
} {
  const domain = process.env.COOKIE_DOMAIN?.trim();
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test',
    sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    ...(domain ? { domain } : {}),
  };
}

export function setRefreshTokenCookie(res: Response, token: string): void {
  res.cookie('refreshToken', token, getCookieOptions());
}

export function clearRefreshTokenCookie(res: Response): void {
  const { maxAge, ...clearOpts } = getCookieOptions();
  res.clearCookie('refreshToken', clearOpts);
}

export function verifyCsrfOrigin(req: Request): void {
  const origin = req.headers.origin;
  if (!origin || !isOriginAllowed(origin)) {
    const err = new Error('CSRF check failed: Invalid or missing Origin header for web client') as any;
    err.statusCode = 403;
    err.code = 'CSRF_FORBIDDEN';
    throw err;
  }
}

export function csrfCheckWebMode(req: Request, res: Response, next: NextFunction): void {
  const isWeb = isWebClient(req);
  const cookieToken = req.cookies?.refreshToken;
  const hasCookie = Boolean(cookieToken);

  if (isWeb || hasCookie) {
    if (!isWeb) {
      res.status(403).json({
        success: false,
        message: 'CSRF check failed: Missing X-Client header in cookie mode',
        error: { code: 'CSRF_FORBIDDEN', message: 'Missing X-Client header in cookie mode' },
      });
      return;
    }
    try {
      verifyCsrfOrigin(req);
    } catch (err: any) {
      res.status(err.statusCode || 403).json({
        success: false,
        message: err.message || 'CSRF check failed',
        error: { code: err.code || 'CSRF_FORBIDDEN', message: err.message || 'CSRF check failed' },
      });
      return;
    }
  }
  next();
}

function getClientDetails(req: Request) {
  const deviceInfo = (req.headers['user-agent'] as string) || 'unknown';
  const ipAddress =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
    req.socket.remoteAddress;
  return { deviceInfo, ipAddress };
}

export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { deviceInfo, ipAddress } = getClientDetails(req);
      const isWeb = isWebClient(req);
      const result = await AuthService.register(req.body, deviceInfo, ipAddress);

      if (isWeb) {
        setRefreshTokenCookie(res, result.refreshToken);
        const { refreshToken, ...dataWithoutRefreshToken } = result;
        res.status(201).json({
          success: true,
          message: 'Account registered successfully. Please check your email to verify your account.',
          data: dataWithoutRefreshToken,
        });
      } else {
        res.status(201).json({
          success: true,
          message: 'Account registered successfully. Please check your email to verify your account.',
          data: result,
        });
      }
    } catch (error) {
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { deviceInfo, ipAddress } = getClientDetails(req);
      const { email, password, fcmToken } = req.body;
      const isWeb = isWebClient(req);
      const result = await AuthService.login(email, password, deviceInfo, ipAddress, fcmToken);

      if (isWeb) {
        setRefreshTokenCookie(res, result.refreshToken);
        const { refreshToken, ...dataWithoutRefreshToken } = result;
        res.status(200).json({
          success: true,
          message: 'Login successful',
          data: dataWithoutRefreshToken,
        });
      } else {
        res.status(200).json({
          success: true,
          message: 'Login successful',
          data: result,
        });
      }
    } catch (error) {
      next(error);
    }
  }

  static async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { deviceInfo, ipAddress } = getClientDetails(req);
      const isWeb = isWebClient(req);
      const cookieToken = req.cookies?.refreshToken;
      const hasCookie = Boolean(cookieToken);

      // CSRF check for web / cookie clients
      if (isWeb || hasCookie) {
        if (!isWeb) {
          res.status(403).json({
            success: false,
            message: 'CSRF check failed: Missing X-Client header in cookie mode',
            error: { code: 'CSRF_FORBIDDEN', message: 'Missing X-Client header in cookie mode' },
          });
          return;
        }
        verifyCsrfOrigin(req);
      }

      const refreshToken = (isWeb ? cookieToken : undefined) || req.body?.refreshToken;

      if (!refreshToken || typeof refreshToken !== 'string' || !refreshToken.trim()) {
        res.status(400).json({
          success: false,
          message: 'Refresh token is required',
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Refresh token is required',
          },
        });
        return;
      }

      const result = await AuthService.refresh(refreshToken.trim(), deviceInfo, ipAddress);

      if (isWeb) {
        setRefreshTokenCookie(res, result.refreshToken);
        const { refreshToken: _, ...dataWithoutRefreshToken } = result;
        res.status(200).json({
          success: true,
          message: 'Token refreshed successfully',
          data: dataWithoutRefreshToken,
        });
      } else {
        res.status(200).json({
          success: true,
          message: 'Token refreshed successfully',
          data: result,
        });
      }
    } catch (error) {
      next(error);
    }
  }

  static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isWeb = isWebClient(req);
      const cookieToken = req.cookies?.refreshToken;
      const hasCookie = Boolean(cookieToken);

      // CSRF check for web / cookie clients
      if (isWeb || hasCookie) {
        if (!isWeb) {
          res.status(403).json({
            success: false,
            message: 'CSRF check failed: Missing X-Client header in cookie mode',
            error: { code: 'CSRF_FORBIDDEN', message: 'Missing X-Client header in cookie mode' },
          });
          return;
        }
        verifyCsrfOrigin(req);
      }

      const refreshToken = req.body?.refreshToken || cookieToken;
      const { fcmToken } = req.body || {};
      const userId = req.user?.userId;

      await AuthService.logout(refreshToken, userId, fcmToken);

      if (isWeb || hasCookie) {
        clearRefreshTokenCookie(res);
      }

      res.status(200).json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const token = (req.query.token as string) || req.body?.token;
      if (!token) {
        res.status(400).json({
          success: false,
          message: 'Verification token is required',
          error: { code: 'VALIDATION_ERROR', message: 'Verification token is required' },
        });
        return;
      }

      await AuthService.verifyEmail(token);

      res.status(200).json({
        success: true,
        message: 'Email verified successfully. You may now log in and use all features.',
      });
    } catch (error) {
      next(error);
    }
  }

  static async resendVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email } = req.body;
      await AuthService.resendVerification(email);

      res.status(200).json({
        success: true,
        message: 'If the account exists and is unverified, a new verification link has been sent.',
      });
    } catch (error) {
      next(error);
    }
  }

  static async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { currentPassword, newPassword } = req.body;
      await AuthService.changePassword(userId, currentPassword, newPassword);

      res.status(200).json({
        success: true,
        message: 'Password changed successfully. All other active sessions have been signed out.',
      });
    } catch (error) {
      next(error);
    }
  }

  static async forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email } = req.body;
      await AuthService.forgotPassword(email);

      res.status(200).json({
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent.',
      });
    } catch (error) {
      next(error);
    }
  }

  static async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, newPassword } = req.body;
      await AuthService.resetPassword(token, newPassword);

      res.status(200).json({
        success: true,
        message: 'Password has been reset successfully. You may now log in with your new password.',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const user = await AuthService.getMe(userId);

      res.status(200).json({
        success: true,
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const user = await AuthService.updateMe(userId, req.body);

      res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }
}
