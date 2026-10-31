import { z } from 'zod';

export const registerSchema = z
  .object({
    email: z.string().trim().email('Valid email address is required').toLowerCase(),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters long')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number'),
    fullName: z.string().trim().min(2, 'Full name must be at least 2 characters'),
    firstName: z.string().trim().optional(),
    lastName: z.string().trim().optional(),
    phone: z.string().trim().min(7, 'Valid phone number is required').optional(),
    phoneCountryCode: z.string().trim().optional(),
    deviceInfo: z.string().trim().optional(),
    fcmToken: z.string().trim().optional(),
    termsAccepted: z.boolean().optional(),
  })
  .strict();

export const v1LoginSchema = z
  .object({
    email: z.string().trim().email('Valid email address is required').toLowerCase(),
    password: z.string().min(1, 'Password is required'),
    deviceInfo: z.string().trim().optional(),
    fcmToken: z.string().trim().optional(),
  })
  .strict();

export const logoutSchema = z
  .object({
    refreshToken: z.string().trim().optional(),
    fcmToken: z.string().trim().optional(),
  })
  .strict();

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
});

export const resendVerificationSchema = z.object({
  email: z.string().trim().email('Valid email address is required').toLowerCase(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(8, 'New password must be at least 8 characters long')
    .regex(/[A-Z]/, 'New password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'New password must contain at least one number'),
});

export const forgotPasswordV1Schema = z.object({
  email: z.string().trim().email('Valid email address is required').toLowerCase(),
});

export const resetPasswordV1Schema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z
    .string()
    .min(8, 'New password must be at least 8 characters long')
    .regex(/[A-Z]/, 'New password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'New password must contain at least one number'),
});

export const updateMeSchema = z
  .object({
    fullName: z.string().trim().min(2).optional(),
    phone: z.string().trim().min(7).optional(),
    avatarUrl: z.string().url('Must be a valid URL').optional(),
    fcmToken: z.string().trim().optional(),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof v1LoginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
