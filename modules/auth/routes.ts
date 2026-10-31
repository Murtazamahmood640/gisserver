import { Router } from 'express';
import { AuthController, csrfCheckWebMode } from './controller';
import { validateBody } from '../../middleware/validate';
import {
  refreshIpLimiter,
  refreshTokenHashLimiter,
  loginFailedEmailIpLimiter,
  loginIpCapLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  resendVerificationLimiter,
  publicFormLimiter,
} from '../../middleware/rateLimiter';
import { authenticateToken } from '../../middleware/auth';
import {
  registerSchema,
  v1LoginSchema,
  refreshTokenSchema,
  changePasswordSchema,
  forgotPasswordV1Schema,
  resetPasswordV1Schema,
  updateMeSchema,
  resendVerificationSchema,
  logoutSchema,
} from './schema';

const router = Router();

// ---------------------------------------------------------------------------
// Public auth endpoints
// ---------------------------------------------------------------------------

// Register: 10 per hour per IP
router.post(
  '/register',
  registerLimiter,
  validateBody(registerSchema),
  AuthController.register
);

// Login: 50/15min per IP + 5 failed attempts/15min per email+IP (skipSuccessfulRequests)
router.post(
  '/login',
  loginIpCapLimiter,
  loginFailedEmailIpLimiter,
  validateBody(v1LoginSchema),
  AuthController.login
);

function validateRefreshRequest(req: any, res: any, next: any) {
  const isWeb = req.headers['x-client']?.toString().toLowerCase() === 'web';
  const cookieToken = req.cookies?.refreshToken;
  const bodyToken = req.body?.refreshToken;

  if (isWeb) {
    if ((!cookieToken || typeof cookieToken !== 'string') && (!bodyToken || typeof bodyToken !== 'string')) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token is required',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Refresh token is required',
        },
      });
    }
  } else {
    if (!bodyToken || typeof bodyToken !== 'string' || !bodyToken.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token is required',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Refresh token is required',
        },
      });
    }
  }
  next();
}

// Refresh: 60/15min per IP + 10/15min per refresh token hash
router.post(
  '/refresh',
  refreshIpLimiter,
  refreshTokenHashLimiter,
  validateRefreshRequest,
  AuthController.refresh
);

router.post(
  '/verify-email',
  publicFormLimiter,
  AuthController.verifyEmail
);

router.get(
  '/verify-email',
  publicFormLimiter,
  AuthController.verifyEmail
);

// Resend verification: max 3 per hour per email + IP
router.post(
  '/resend-verification',
  resendVerificationLimiter,
  validateBody(resendVerificationSchema),
  AuthController.resendVerification
);

// Forgot password: 5 per 15 min per email + IP
router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  validateBody(forgotPasswordV1Schema),
  AuthController.forgotPassword
);

// Reset password: 5 per 15 min per email + IP
router.post(
  '/reset-password',
  resetPasswordLimiter,
  validateBody(resetPasswordV1Schema),
  AuthController.resetPassword
);

// ---------------------------------------------------------------------------
// Protected endpoints (require valid access token)
// ---------------------------------------------------------------------------

router.post(
  '/logout',
  csrfCheckWebMode,
  authenticateToken,
  validateBody(logoutSchema),
  AuthController.logout
);

router.post(
  '/change-password',
  authenticateToken,
  validateBody(changePasswordSchema),
  AuthController.changePassword
);

router.get(
  '/me',
  authenticateToken,
  AuthController.getMe
);

router.patch(
  '/me',
  authenticateToken,
  validateBody(updateMeSchema),
  AuthController.updateMe
);

export default router;
