import logger from '../config/logger';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { connectDB } from '../config/database';
import { User } from '../models/User';
import {
  generateToken,
  generatePasswordResetToken,
  verifyPasswordResetToken,
  decodeToken,
  verifyToken,
  type PasswordResetPayload,
} from '../utils/jwt';
import { sendEmail, getPasswordResetEmail } from '../services/emailService';

export default async function handler(
  req: Request,
  res: Response
): Promise<void> {
  await connectDB();

  try {
    const action =
      (req.query.action as string) ||
      (req.url?.includes('/forgot-password') && 'forgot-password') ||
      (req.url?.includes('/reset-password') && 'reset-password') ||
      (req.url?.includes('/login') && 'login') ||
      (req.url?.includes('/register') && 'register') ||
      (req.url?.includes('/verify') && 'verify');

    // Token verification (GET /api/auth/verify)
    if (action === 'verify' || (req.method === 'GET' && req.url?.includes('/verify'))) {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];

      if (!token) {
        res.status(401).json({
          success: false,
          message: 'No token provided',
          error: { code: 'UNAUTHORIZED', message: 'No token provided' },
        });
        return;
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        res.status(401).json({
          success: false,
          message: 'Invalid or expired token',
          error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
        });
        return;
      }

      const user = await User.findById(decoded.userId);
      if (!user || !user.isActive) {
        res.status(401).json({
          success: false,
          message: 'User no longer active or exists',
          error: { code: 'UNAUTHORIZED', message: 'User no longer active or exists' },
        });
        return;
      }

      res.status(200).json({
        success: true,
        user: {
          id: user._id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
        },
      });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({
        success: false,
        message: 'Method not allowed',
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
      });
      return;
    }

    // Login (POST /api/auth/login)
    if (action === 'login') {
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({
          success: false,
          message: 'Email and password are required',
          error: { code: 'VALIDATION_ERROR', message: 'Email and password are required' },
        });
        return;
      }

      const user = await User.findOne({
        email: email.toLowerCase(),
      }).select('+password');

      if (!user) {
        res.status(401).json({
          success: false,
          message: 'Invalid email or password',
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
        });
        return;
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        res.status(401).json({
          success: false,
          message: 'Invalid email or password',
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
        });
        return;
      }

      if (!user.isActive || user.status === 'suspended') {
        res.status(403).json({
          success: false,
          message: 'Account is suspended or inactive',
          error: { code: 'ACCOUNT_SUSPENDED', message: 'Account is suspended or inactive' },
        });
        return;
      }

      const token = generateToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      res.status(200).json({
        success: true,
        token,
        user: {
          id: user._id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
        },
      });
      return;
    }

    // Register (POST /api/auth/register)
    if (action === 'register') {
      const { email, password, fullName } = req.body;

      if (!email || !password || !fullName) {
        res.status(400).json({
          success: false,
          message: 'Email, password, and full name are required',
          error: { code: 'VALIDATION_ERROR', message: 'Email, password, and full name are required' },
        });
        return;
      }

      const existingUser = await User.findOne({
        email: email.toLowerCase(),
      });

      if (existingUser) {
        res.status(409).json({
          success: false,
          message: 'User with this email already exists',
          error: { code: 'DUPLICATE_KEY_ERROR', message: 'User with this email already exists' },
        });
        return;
      }

      const user = new User({
        email: email.toLowerCase(),
        password,
        fullName,
        role: 'user',
        isActive: true,
      });

      await user.save();

      const token = generateToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      res.status(201).json({
        success: true,
        token,
        user: {
          id: user._id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
        },
      });
      return;
    }

    // Forgot Password (POST /api/auth/forgot-password)
    if (action === 'forgot-password') {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          message: 'Email address is required',
          error: { code: 'VALIDATION_ERROR', message: 'Email address is required' },
        });
        return;
      }

      const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

      if (user && user.isActive) {
        const resetToken = generatePasswordResetToken(
          {
            userId: user._id.toString(),
            email: user.email,
          },
          user.password
        );

        const baseUrl =
          process.env.FRONTEND_URL?.split(',')[0].trim().replace(/\/$/, '') ||
          'https://globalintegratedsupport.com';
        const resetUrl = `${baseUrl}/admin?resetToken=${resetToken}`;

        try {
          await sendEmail({
            to: user.email,
            subject: 'Password Reset Request - Global Integrated Support',
            html: getPasswordResetEmail({
              fullName: user.fullName || 'Admin',
              resetUrl,
            }),
          });
        } catch (emailError) {
          logger.error({ err: emailError }, 'Failed to send password reset email');
        }
      } else {
        // Timing resistance: perform dummy bcrypt hash so non-existent emails take similar time to existing lookups
        await bcrypt.hash('GIS_TIMING_DEFENSE_DUMMY_SALT', 10);
      }

      // Consistent message to prevent email enumeration
      res.status(200).json({
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent.',
      });
      return;
    }

    // Reset Password (POST /api/auth/reset-password)
    if (action === 'reset-password') {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        res.status(400).json({
          success: false,
          message: 'Reset token and new password are required',
          error: { code: 'VALIDATION_ERROR', message: 'Reset token and new password are required' },
        });
        return;
      }

      if (newPassword.length < 6) {
        res.status(400).json({
          success: false,
          message: 'Password must be at least 6 characters long',
          error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 6 characters long' },
        });
        return;
      }

      const unverified = decodeToken(token) as (PasswordResetPayload & { pwdFingerprint?: string }) | null;
      if (!unverified || !unverified.userId || unverified.type !== 'password_reset') {
        res.status(400).json({
          success: false,
          message: 'Reset token is invalid or has expired',
          error: { code: 'INVALID_TOKEN', message: 'Reset token is invalid or has expired' },
        });
        return;
      }

      const user = await User.findById(unverified.userId).select('+password');
      if (!user || !user.isActive) {
        res.status(400).json({
          success: false,
          message: 'Account not found or is inactive',
          error: { code: 'USER_NOT_FOUND', message: 'Account not found or is inactive' },
        });
        return;
      }

      // Single-use verification against user's current password hash
      const decoded = verifyPasswordResetToken(token, user.password);
      if (!decoded) {
        res.status(400).json({
          success: false,
          message: 'Reset token is invalid or has expired',
          error: { code: 'INVALID_TOKEN', message: 'Reset token is invalid or has expired' },
        });
        return;
      }

      user.password = newPassword;
      await user.save();

      res.status(200).json({
        success: true,
        message: 'Password has been reset successfully. You may now log in with your new password.',
      });
      return;
    }

    res.status(400).json({
      success: false,
      message: 'Invalid action',
      error: { code: 'BAD_REQUEST', message: 'Invalid action' },
    });
  } catch (error) {
    logger.error({ err: error }, 'Auth handler error');
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    });
  }
}
