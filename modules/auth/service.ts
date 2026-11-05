import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User, IUser, UserRole } from '../../models/User';
import { RefreshToken, IRefreshToken } from '../../models/RefreshToken';
import { LoginAttempt } from '../../models/LoginAttempt';
import { Booking } from '../../models/Booking';
import { CustomerProfile } from '../../models/CustomerProfile';
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  generateEmailVerificationToken,
  verifyEmailVerificationToken,
  generatePasswordResetToken,
  verifyPasswordResetToken,
  decodeToken,
  PasswordResetPayload,
} from '../../utils/jwt';
import {
  sendEmail,
  getEmailVerificationEmail,
  getPasswordResetEmail,
  getWelcomeEmail,
  getAccountLockedEmail,
} from '../../services/emailService';
import logger from '../../config/logger';

const REFRESH_TOKEN_EXPIRY_DAYS = 30;
const ACCESS_TOKEN_EXPIRY = '24h';
const ACCESS_TOKEN_EXPIRY_SECONDS = 86400; // 24 hours

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // 86400 seconds (24 hours)
  tokenType: 'Bearer';
  user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    status: string;
    emailVerified: boolean;
    phone?: string;
    avatarUrl?: string;
  };
}

export class AuthService {
  /**
   * Helper to issue access + rotating refresh token pair.
   */
  private static async issueTokenPair(
    user: IUser,
    deviceInfo: string,
    ipAddress?: string
  ): Promise<TokenResponse> {
    const effectiveRole = user.getEffectiveRole();

    const accessToken = generateAccessToken(
      {
        userId: user._id.toString(),
        email: user.email,
        role: effectiveRole,
        status: user.status,
        emailVerified: user.emailVerified,
      },
      ACCESS_TOKEN_EXPIRY
    );

    const rawRefreshToken = generateRefreshToken();
    const tokenHash = hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 3600 * 1000);

    await RefreshToken.create({
      userId: user._id,
      tokenHash,
      deviceInfo,
      ipAddress,
      issuedAt: new Date(),
      expiresAt,
      revoked: false,
    });

    // Update lastLoginAt
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
      tokenType: 'Bearer',
      user: {
        id: user._id.toString(),
        email: user.email,
        fullName: user.fullName,
        role: effectiveRole,
        status: user.status,
        emailVerified: user.emailVerified,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  /**
   * Register customer (default public sign-up).
   */
  static async register(
    data: {
      email: string;
      password: string;
      fullName?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      phoneCountryCode?: string;
      fcmToken?: string;
      termsAccepted?: boolean;
    },
    deviceInfo: string,
    ipAddress?: string
  ): Promise<TokenResponse> {
    const existing = await User.findOne({ email: data.email.toLowerCase() });
    if (existing) {
      const err = new Error('User with this email already exists') as any;
      err.code = 'DUPLICATE_KEY_ERROR';
      err.statusCode = 409;
      throw err;
    }

    const fcmTokens = data.fcmToken ? [data.fcmToken] : [];
    const resolvedFullName =
      (data.fullName && data.fullName.trim()) ||
      [data.firstName, data.lastName].filter(Boolean).join(' ').trim() ||
      'Customer';
    const resolvedFirstName =
      data.firstName?.trim() || resolvedFullName.split(' ')[0] || '';
    const resolvedLastName =
      data.lastName?.trim() || resolvedFullName.split(' ').slice(1).join(' ') || '';

    const user = new User({
      email: data.email.toLowerCase(),
      password: data.password,
      fullName: resolvedFullName,
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      phone: data.phone,
      phoneCountryCode: data.phoneCountryCode || '+1',
      termsAcceptedAt: data.termsAccepted ? new Date() : undefined,
      privacyAcceptedAt: data.termsAccepted ? new Date() : undefined,
      role: 'customer',
      status: 'active',
      isActive: true,
      emailVerified: false,
      fcmTokens,
    });

    // Verification token valid for 24h
    const verifyToken = generateEmailVerificationToken({
      userId: user._id.toString(),
      email: user.email,
    });
    user.emailVerificationToken = verifyToken;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 3600 * 1000);

    await user.save();
    logger.info({ userId: user._id.toString() }, 'New customer registered');

    // Ensure CustomerProfile exists
    try {
      await CustomerProfile.create({
        userId: user._id,
        savedAddresses: [],
        notificationPreferences: { email: true, push: false, sms: true },
        preferredContactChannel: 'sms',
      });
    } catch (profErr) {
      logger.warn({ err: profErr }, 'CustomerProfile creation skipped or duplicate');
    }

    // Send verification email in background
    const frontendUrl =
      process.env.FRONTEND_URL?.split(',')[0].trim().replace(/\/$/, '') ||
      'https://globalintegratedsupport.com';
    const verifyUrl = `${frontendUrl}/verify-email?token=${verifyToken}`;

    sendEmail({
      to: user.email,
      subject: 'Verify your email - Global Integrated Support',
      html: getEmailVerificationEmail({ fullName: user.fullName, verifyUrl }),
    }).catch((emailErr) => {
      logger.error({ err: emailErr }, 'Failed to send verification email on register');
    });

    if (user.emailVerified) {
      Booking.updateMany(
        { customerId: null, 'guest.email': user.email.toLowerCase() },
        { $set: { customerId: user._id } }
      ).catch((linkErr) => {
        logger.error({ err: linkErr }, 'Failed to link guest bookings on register');
      });
    }

    return this.issueTokenPair(user, deviceInfo, ipAddress);
  }

  /**
   * Universal Login supporting mobile (fcmToken) and web.
   */
  static async login(
    email: string,
    password: string,
    deviceInfo: string,
    ipAddress?: string,
    fcmToken?: string
  ): Promise<TokenResponse> {
    const normalizedEmail = email.toLowerCase().trim();
    const clientIp = ipAddress || 'unknown';
    const attemptKey = `${normalizedEmail}:${clientIp}`;

    // 1. Check if this email+IP is currently locked out
    const attempt = await LoginAttempt.findOne({ key: attemptKey });
    if (attempt && attempt.isLocked && attempt.isLocked()) {
      // Return identical generic response to prevent account state enumeration
      const err = new Error('Invalid email or password') as any;
      err.code = 'INVALID_CREDENTIALS';
      err.statusCode = 401;
      throw err;
    }

    const user = await User.findOne({ email: normalizedEmail }).select('+password');

    if (!user) {
      // Record failed attempt atomically
      await LoginAttempt.findOneAndUpdate(
        { key: attemptKey },
        {
          $inc: { failedLoginAttempts: 1 },
          $setOnInsert: { email: normalizedEmail, ip: clientIp },
        },
        { upsert: true }
      );

      const err = new Error('Invalid email or password') as any;
      err.code = 'INVALID_CREDENTIALS';
      err.statusCode = 401;
      throw err;
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      // Atomic $inc update per email+IP
      const updatedAttempt = await LoginAttempt.findOneAndUpdate(
        { key: attemptKey },
        {
          $inc: { failedLoginAttempts: 1 },
          $setOnInsert: { email: normalizedEmail, ip: clientIp },
        },
        { upsert: true, returnDocument: 'after' }
      );

      // 10 consecutive failed attempts from this IP locks out this email+IP pair for 15 minutes
      if (updatedAttempt.failedLoginAttempts >= 10) {
        await LoginAttempt.updateOne(
          { key: attemptKey },
          {
            $set: {
              lockUntil: new Date(Date.now() + 15 * 60 * 1000),
              failedLoginAttempts: 0,
            },
          }
        );

        // Notify user via email
        const lockoutHtml =
          typeof getAccountLockedEmail === 'function'
            ? getAccountLockedEmail({
                fullName: user.fullName || 'User',
                lockDurationMinutes: 15,
              })
            : '<p>Account Locked</p>';

        sendEmail({
          to: user.email,
          subject: 'Security Alert: Account Temporarily Locked - Global Integrated Support',
          html: lockoutHtml,
        }).catch((emailErr) => {
          logger.error({ err: emailErr }, 'Failed to send account lockout notice email');
        });
      }

      // Return identical generic 401 failure
      const err = new Error('Invalid email or password') as any;
      err.code = 'INVALID_CREDENTIALS';
      err.statusCode = 401;
      throw err;
    }

    if (!user.isActive || user.status === 'suspended') {
      const err = new Error('Account is suspended or inactive') as any;
      err.code = 'ACCOUNT_SUSPENDED';
      err.statusCode = 403;
      throw err;
    }

    // Reset login failures for this email+IP on success
    await LoginAttempt.deleteOne({ key: attemptKey });

    // Handle FCM token: cap at 10 (dedupe, drop oldest)
    if (fcmToken) {
      const existing = (user.fcmTokens || []).filter((t: string) => t !== fcmToken);
      existing.push(fcmToken);
      user.fcmTokens = existing.length > 10 ? existing.slice(existing.length - 10) : existing;
    }

    if (typeof user.save === 'function') await user.save();

    logger.info({ userId: user._id.toString(), role: user.role }, 'User logged in');
    return this.issueTokenPair(user, deviceInfo, ipAddress);
  }

  /**
   * Token refresh with cryptographic rotation:
   * Current refresh token is revoked and replaced by a fresh token.
   * If a revoked token is used, all tokens in the family are invalidated (breach detection).
   */
  static async refresh(
    rawRefreshToken: string,
    deviceInfo: string,
    ipAddress?: string
  ): Promise<TokenResponse> {
    const tokenHash = hashToken(rawRefreshToken);

    const storedToken = await RefreshToken.findOne({ tokenHash });
    if (!storedToken) {
      const err = new Error('Invalid refresh token') as any;
      err.code = 'INVALID_TOKEN';
      err.statusCode = 401;
      throw err;
    }

    // Token reuse detection: if already revoked, compromise detected!
    if (storedToken.revoked) {
      logger.warn(
        { userId: storedToken.userId.toString() },
        'Revoked refresh token reuse detected! Revoking all sessions for user.'
      );
      // Invalidate all tokens for this user
      await RefreshToken.updateMany(
        { userId: storedToken.userId },
        { $set: { revoked: true, revokedAt: new Date() } }
      );

      const err = new Error('Refresh token has expired or already been used') as any;
      err.code = 'TOKEN_REUSED';
      err.statusCode = 401;
      throw err;
    }

    // Check expiration
    if (storedToken.expiresAt < new Date()) {
      storedToken.revoked = true;
      storedToken.revokedAt = new Date();
      await storedToken.save();

      const err = new Error('Refresh token has expired') as any;
      err.code = 'TOKEN_EXPIRED';
      err.statusCode = 401;
      throw err;
    }

    const user = await User.findById(storedToken.userId);
    if (!user || !user.isActive || user.status === 'suspended') {
      const err = new Error('Account inactive or not found') as any;
      err.code = 'ACCOUNT_INACTIVE';
      err.statusCode = 403;
      throw err;
    }

    // Rotate: Revoke the old token and link to new one
    const newRawRefreshToken = generateRefreshToken();
    const newTokenHash = hashToken(newRawRefreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 3600 * 1000);

    storedToken.revoked = true;
    storedToken.revokedAt = new Date();
    storedToken.replacedByTokenHash = newTokenHash;
    await storedToken.save();

    // Create new refresh token
    await RefreshToken.create({
      userId: user._id,
      tokenHash: newTokenHash,
      deviceInfo,
      ipAddress,
      issuedAt: new Date(),
      expiresAt,
      revoked: false,
    });

    const effectiveRole = user.getEffectiveRole();
    const accessToken = generateAccessToken(
      {
        userId: user._id.toString(),
        email: user.email,
        role: effectiveRole,
        status: user.status,
        emailVerified: user.emailVerified,
      },
      ACCESS_TOKEN_EXPIRY
    );

    return {
      accessToken,
      refreshToken: newRawRefreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
      tokenType: 'Bearer',
      user: {
        id: user._id.toString(),
        email: user.email,
        fullName: user.fullName,
        role: effectiveRole,
        status: user.status,
        emailVerified: user.emailVerified,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  /**
   * Logout: Revoke the provided refresh token and remove the device FCM token.
   */
  static async logout(
    rawRefreshToken?: string,
    userId?: string,
    fcmToken?: string
  ): Promise<void> {
    if (rawRefreshToken) {
      const tokenHash = hashToken(rawRefreshToken);
      await RefreshToken.updateOne(
        { tokenHash },
        { $set: { revoked: true, revokedAt: new Date() } }
      );
    } else if (userId) {
      await RefreshToken.updateMany(
        { userId, revoked: false },
        { $set: { revoked: true, revokedAt: new Date() } }
      );
    }

    if (userId && fcmToken) {
      await User.updateOne({ _id: userId }, { $pull: { fcmTokens: fcmToken } });
    }
  }

  /**
   * Verify email via token.
   */
  static async verifyEmail(token: string): Promise<void> {
    const decoded = verifyEmailVerificationToken(token);
    if (!decoded) {
      const err = new Error('Invalid or expired verification token') as any;
      err.code = 'INVALID_TOKEN';
      err.statusCode = 400;
      throw err;
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      const err = new Error('User not found') as any;
      err.code = 'USER_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    if (user.emailVerified) {
      return; // already verified
    }

    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    logger.info({ userId: user._id.toString() }, 'Email verified successfully');

    // Link existing guest bookings with the same verified email
    Booking.updateMany(
      { customerId: null, 'guest.email': user.email.toLowerCase() },
      { $set: { customerId: user._id } }
    ).catch((linkErr) => {
      logger.error({ err: linkErr }, 'Failed to link guest bookings on verifyEmail');
    });

    // Send welcome email
    sendEmail({
      to: user.email,
      subject: 'Welcome to Global Integrated Support!',
      html: getWelcomeEmail({ fullName: user.fullName }),
    }).catch((emailErr) => {
      logger.error({ err: emailErr }, 'Failed to send welcome email');
    });
  }

  /**
   * Resend email verification.
   */
  static async resendVerification(email: string): Promise<void> {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || user.emailVerified) {
      return; // Do not leak existence or state
    }

    const verifyToken = generateEmailVerificationToken({
      userId: user._id.toString(),
      email: user.email,
    });
    user.emailVerificationToken = verifyToken;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 3600 * 1000);
    await user.save();

    const frontendUrl =
      process.env.FRONTEND_URL?.split(',')[0].trim().replace(/\/$/, '') ||
      'https://globalintegratedsupport.com';
    const verifyUrl = `${frontendUrl}/verify-email?token=${verifyToken}`;

    await sendEmail({
      to: user.email,
      subject: 'Verify your email - Global Integrated Support',
      html: getEmailVerificationEmail({ fullName: user.fullName, verifyUrl }),
    });
  }

  /**
   * Change password (authenticated).
   */
  static async changePassword(
    userId: string,
    currentPass: string,
    newPass: string
  ): Promise<void> {
    const user = await User.findById(userId).select('+password');
    if (!user) {
      const err = new Error('User not found') as any;
      err.code = 'USER_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    const isMatch = await user.comparePassword(currentPass);
    if (!isMatch) {
      const err = new Error('Current password is incorrect') as any;
      err.code = 'INVALID_PASSWORD';
      err.statusCode = 400;
      throw err;
    }

    user.password = newPass;
    await user.save();

    // Revoke all refresh tokens upon password change
    await RefreshToken.updateMany(
      { userId: user._id, revoked: false },
      { $set: { revoked: true, revokedAt: new Date() } }
    );

    logger.info({ userId }, 'Password changed successfully; all sessions revoked');
  }

  /**
   * Forgot password (v1 endpoint).
   */
  static async forgotPassword(email: string): Promise<void> {
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (user && user.isActive) {
      const resetToken = generatePasswordResetToken(
        { userId: user._id.toString(), email: user.email },
        user.password
      );

      const frontendUrl =
        process.env.FRONTEND_URL?.split(',')[0].trim().replace(/\/$/, '') ||
        'https://globalintegratedsupport.com';
      const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

      sendEmail({
        to: user.email,
        subject: 'Password Reset Request - Global Integrated Support',
        html: getPasswordResetEmail({ fullName: user.fullName, resetUrl }),
      }).catch((emailErr) => {
        logger.error({ err: emailErr }, 'Failed to send password reset email');
      });
    } else {
      // Timing attack defense
      await bcrypt.hash('GIS_TIMING_DEFENSE_DUMMY_SALT', 10);
    }
  }

  /**
   * Reset password (v1 endpoint).
   */
  static async resetPassword(token: string, newPassword: string): Promise<void> {
    const unverified = decodeToken(token) as (PasswordResetPayload & { pwdFingerprint?: string }) | null;
    if (!unverified || !unverified.userId || unverified.type !== 'password_reset') {
      const err = new Error('Reset token is invalid or has expired') as any;
      err.code = 'INVALID_TOKEN';
      err.statusCode = 400;
      throw err;
    }

    const user = await User.findById(unverified.userId).select('+password');
    if (!user || !user.isActive) {
      const err = new Error('Account not found or is inactive') as any;
      err.code = 'USER_NOT_FOUND';
      err.statusCode = 400;
      throw err;
    }

    const decoded = verifyPasswordResetToken(token, user.password);
    if (!decoded) {
      const err = new Error('Reset token is invalid or has expired') as any;
      err.code = 'INVALID_TOKEN';
      err.statusCode = 400;
      throw err;
    }

    user.password = newPassword;
    await user.save();

    // Clear any temporary login lockouts so user/admin can log in immediately with new password
    await LoginAttempt.deleteMany({ email: user.email.toLowerCase() });

    // Invalidate all active refresh sessions
    await RefreshToken.updateMany(
      { userId: user._id, revoked: false },
      { $set: { revoked: true, revokedAt: new Date() } }
    );

    logger.info({ userId: user._id.toString() }, 'Password reset successfully via v1');
  }

  /**
   * Fetch current user profile.
   */
  static async getMe(userId: string) {
    const user = await User.findById(userId);
    if (!user) {
      const err = new Error('User not found') as any;
      err.code = 'USER_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    return {
      id: user._id.toString(),
      email: user.email,
      fullName: user.fullName,
      role: user.getEffectiveRole(),
      status: user.status,
      phone: user.phone,
      phoneVerified: user.phoneVerified,
      emailVerified: user.emailVerified,
      avatarUrl: user.avatarUrl,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  /**
   * Update profile.
   */
  static async updateMe(
    userId: string,
    updates: { fullName?: string; phone?: string; avatarUrl?: string; fcmToken?: string }
  ) {
    const updateQuery: any = {};
    if (updates.fullName) updateQuery.fullName = updates.fullName;
    if (updates.phone) {
      updateQuery.phone = updates.phone;
      updateQuery.phoneVerified = false; // reset verification on phone change
    }
    if (updates.avatarUrl) updateQuery.avatarUrl = updates.avatarUrl;

    if (updates.fcmToken) {
      await User.updateOne({ _id: userId }, { $addToSet: { fcmTokens: updates.fcmToken } });
    }

    const user = await User.findByIdAndUpdate(userId, { $set: updateQuery }, { returnDocument: 'after' });
    if (!user) {
      const err = new Error('User not found') as any;
      err.code = 'USER_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    return {
      id: user._id.toString(),
      email: user.email,
      fullName: user.fullName,
      role: user.getEffectiveRole(),
      status: user.status,
      phone: user.phone,
      phoneVerified: user.phoneVerified,
      emailVerified: user.emailVerified,
      avatarUrl: user.avatarUrl,
      lastLoginAt: user.lastLoginAt,
    };
  }
}
