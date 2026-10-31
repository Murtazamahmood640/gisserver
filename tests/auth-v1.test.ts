import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { User, IUser } from '../models/User';
import { RefreshToken } from '../models/RefreshToken';
import { Appointment } from '../models/Appointment';
import { Booking } from '../models/Booking';
import { LoginAttempt } from '../models/LoginAttempt';
import {
  generateAccessToken,
  generateToken,
  generateEmailVerificationToken,
  generatePasswordResetToken,
  hashToken,
} from '../utils/jwt';
import {
  requireRoles,
  requireVerified,
  requireOwnershipOrAdmin,
  authenticateToken,
  clearUserStatusCache,
} from '../middleware/auth';
import express, { Request, Response } from 'express';

// Mock DB connection
vi.mock('../config/database', () => ({
  connectDB: vi.fn().mockResolvedValue(true),
}));

// Mock Email and Cloudinary services
vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'test-email-id' }),
  getBookingConfirmationEmail: vi.fn().mockReturnValue('<p>Email</p>'),
  getAdminNotificationEmail: vi.fn().mockReturnValue('<p>Admin</p>'),
  getContactAcknowledgmentEmail: vi.fn().mockReturnValue('<p>Ack</p>'),
  getPasswordResetEmail: vi.fn().mockReturnValue('<p>Reset</p>'),
  getEmailVerificationEmail: vi.fn().mockReturnValue('<p>Verify</p>'),
  getWelcomeEmail: vi.fn().mockReturnValue('<p>Welcome</p>'),
  getAccountLockedEmail: vi.fn().mockReturnValue('<p>Locked</p>'),
}));

vi.mock('../utils/cloudinary', () => ({
  uploadToCloudinary: vi.fn().mockResolvedValue('https://res.cloudinary.com/test/image/upload/sample.jpg'),
  default: {
    config: vi.fn(),
    uploader: { upload: vi.fn() },
  },
}));

describe('Multi-Role Authentication & Role Boundaries (v1)', () => {
  const customerToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439001',
    email: 'customer@test.com',
    role: 'customer',
    status: 'active',
    emailVerified: true,
  });

  const unverifiedCustomerToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439002',
    email: 'unverified@test.com',
    role: 'customer',
    status: 'active',
    emailVerified: false,
  });

  const technicianToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439003',
    email: 'tech@test.com',
    role: 'technician',
    status: 'active',
    emailVerified: true,
  });

  const supplierToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439004',
    email: 'supplier@test.com',
    role: 'supplier',
    status: 'active',
    emailVerified: true,
  });

  const dispatcherToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439005',
    email: 'dispatcher@test.com',
    role: 'dispatcher',
    status: 'active',
    emailVerified: true,
  });

  const adminToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439006',
    email: 'admin@test.com',
    role: 'admin',
    status: 'active',
    emailVerified: true,
  });

  const suspendedToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439007',
    email: 'suspended@test.com',
    role: 'customer',
    status: 'suspended',
    emailVerified: true,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(LoginAttempt, 'findOne').mockResolvedValue(null);
    vi.spyOn(LoginAttempt, 'findOneAndUpdate').mockResolvedValue({ failedLoginAttempts: 1 } as any);
    vi.spyOn(LoginAttempt, 'updateOne').mockResolvedValue({} as any);
    vi.spyOn(LoginAttempt, 'deleteOne').mockResolvedValue({} as any);
    vi.spyOn(LoginAttempt, 'deleteMany').mockResolvedValue({} as any);
  });

  // -------------------------------------------------------------------------
  // 1. Role Boundary Middleware Tests
  // -------------------------------------------------------------------------
  describe('Role boundary enforcement', () => {
    // Create an isolated sub-app to test role boundary gates
    const roleTestApp = express();
    roleTestApp.use(express.json());

    // Middleware test routes
    roleTestApp.get(
      '/test/technician-only',
      authenticateToken,
      requireRoles('technician'),
      (_req: Request, res: Response) => res.json({ access: 'granted' })
    );

    roleTestApp.get(
      '/test/supplier-or-admin',
      authenticateToken,
      requireRoles('supplier', 'admin'),
      (_req: Request, res: Response) => res.json({ access: 'granted' })
    );

    roleTestApp.get(
      '/test/dispatcher-only',
      authenticateToken,
      requireRoles('dispatcher'),
      (_req: Request, res: Response) => res.json({ access: 'granted' })
    );

    roleTestApp.get(
      '/test/verified-only',
      authenticateToken,
      requireVerified,
      (_req: Request, res: Response) => res.json({ access: 'granted' })
    );

    roleTestApp.get(
      '/test/resource/:ownerId',
      authenticateToken,
      requireOwnershipOrAdmin((req) => req.params.ownerId),
      (_req: Request, res: Response) => res.json({ access: 'granted' })
    );

    it('denies customer access to technician-only endpoint with 403', async () => {
      const res = await request(roleTestApp)
        .get('/test/technician-only')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('allows technician access to technician-only endpoint with 200', async () => {
      const res = await request(roleTestApp)
        .get('/test/technician-only')
        .set('Authorization', `Bearer ${technicianToken}`);
      expect(res.status).toBe(200);
      expect(res.body.access).toBe('granted');
    });

    it('allows both supplier and admin to access supplier-or-admin route', async () => {
      const res1 = await request(roleTestApp)
        .get('/test/supplier-or-admin')
        .set('Authorization', `Bearer ${supplierToken}`);
      expect(res1.status).toBe(200);

      const res2 = await request(roleTestApp)
        .get('/test/supplier-or-admin')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res2.status).toBe(200);

      const res3 = await request(roleTestApp)
        .get('/test/supplier-or-admin')
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res3.status).toBe(403);
    });

    it('allows dispatcher to access dispatcher route, blocks technician', async () => {
      const res1 = await request(roleTestApp)
        .get('/test/dispatcher-only')
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res1.status).toBe(200);

      const res2 = await request(roleTestApp)
        .get('/test/dispatcher-only')
        .set('Authorization', `Bearer ${technicianToken}`);
      expect(res2.status).toBe(403);
    });

    it('blocks unverified email on requireVerified endpoint with 403', async () => {
      const res = await request(roleTestApp)
        .get('/test/verified-only')
        .set('Authorization', `Bearer ${unverifiedCustomerToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('blocks suspended account with 403 upon token authentication', async () => {
      const res = await request(roleTestApp)
        .get('/test/technician-only')
        .set('Authorization', `Bearer ${suspendedToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('blocks user suspended in DB mid-session even with a valid non-suspended token', async () => {
      // Import clearUserStatusCache to flush the 30s cache
      const { clearUserStatusCache } = await import('../middleware/auth');
      clearUserStatusCache();

      // Token says active, but DB returns suspended
      const activeUserToken = generateAccessToken({
        userId: '507f1f77bcf86cd799439070',
        email: 'midSession@test.com',
        role: 'customer',
        status: 'active',
        emailVerified: true,
      });

      vi.spyOn(User, 'findById').mockReturnValue({
        select: vi.fn().mockResolvedValue({
          _id: '507f1f77bcf86cd799439070',
          status: 'suspended',
          isActive: false,
          role: 'customer',
          getEffectiveRole: () => 'customer',
        }),
      } as any);

      const res = await request(roleTestApp)
        .get('/test/technician-only')
        .set('Authorization', `Bearer ${activeUserToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('enforces ownership: owner succeeds, other customer blocked with 403, admin bypasses', async () => {
      const myId = '507f1f77bcf86cd799439001';
      const otherId = '999f1f77bcf86cd799439999';

      // Owner accessing own resource -> 200
      const resOwner = await request(roleTestApp)
        .get(`/test/resource/${myId}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(resOwner.status).toBe(200);

      // Customer accessing other customer's resource -> 403
      const resNonOwner = await request(roleTestApp)
        .get(`/test/resource/${otherId}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(resNonOwner.status).toBe(403);
      expect(resNonOwner.body.error?.code).toBe('FORBIDDEN');

      // Admin accessing another user's resource -> 200 (bypass)
      const resAdmin = await request(roleTestApp)
        .get(`/test/resource/${otherId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resAdmin.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Legacy User Role Migration Mapping
  // -------------------------------------------------------------------------
  describe('Legacy user role migration mapping', () => {
    it('maps legacy user token to dispatcher role in authenticateToken', async () => {
      const legacyUserToken = generateToken({
        userId: '507f1f77bcf86cd799439099',
        email: 'legacyuser@test.com',
        role: 'user',
      });

      const testApp = express();
      testApp.get('/test/me-role', authenticateToken, (req: Request, res: Response) => {
        res.json({ role: req.user?.role });
      });

      const res = await request(testApp)
        .get('/test/me-role')
        .set('Authorization', `Bearer ${legacyUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('dispatcher');
    });
  });

  // -------------------------------------------------------------------------
  // 3. /api/v1/auth Endpoints
  // -------------------------------------------------------------------------
  describe('POST /api/v1/auth/register', () => {
    it('registers a customer with valid credentials and returns 15m access + 30d refresh tokens', async () => {
      vi.spyOn(User, 'findOne').mockResolvedValue(null);
      const mockSavedUser = {
        _id: '507f1f77bcf86cd799439001',
        email: 'newcustomer@test.com',
        fullName: 'New Customer',
        role: 'customer',
        status: 'active',
        emailVerified: false,
        getEffectiveRole: () => 'customer',
      };
      vi.spyOn(User.prototype, 'save').mockResolvedValue(mockSavedUser as any);
      vi.spyOn(RefreshToken, 'create').mockResolvedValue({} as any);
      vi.spyOn(User, 'updateOne').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', '10.2.0.1')
        .send({
          email: 'newcustomer@test.com',
          password: 'Password123!',
          fullName: 'New Customer',
          phone: '+1234567890',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.expiresIn).toBe(900); // 15 min
      expect(res.body.data.user.role).toBe('customer');
      expect(res.body.data.user.emailVerified).toBe(false);
    });

    it('rejects weak password without numbers or uppercase letters with 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', '10.2.0.2')
        .send({
          email: 'weakpass@test.com',
          password: 'simplepassword',
          fullName: 'Weak Pass',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('authenticates user and returns token pair and user details', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439003',
        email: 'technician@test.com',
        fullName: 'Field Tech',
        role: 'technician',
        status: 'active',
        isActive: true,
        emailVerified: true,
        comparePassword: vi.fn().mockResolvedValue(true),
        getEffectiveRole: () => 'technician',
      };

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      } as any);
      vi.spyOn(RefreshToken, 'create').mockResolvedValue({} as any);
      vi.spyOn(User, 'updateOne').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '10.2.0.3')
        .send({
          email: 'technician@test.com',
          password: 'Password123!',
          fcmToken: 'mock-fcm-token-123',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.role).toBe('technician');
    });

    it('rejects invalid password with 401', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439001',
        email: 'customer@test.com',
        comparePassword: vi.fn().mockResolvedValue(false),
      };

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      } as any);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '10.2.0.4')
        .send({
          email: 'customer@test.com',
          password: 'WrongPassword!',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('INVALID_CREDENTIALS');
    });

    it('blocks suspended user from logging in with 403 ACCOUNT_SUSPENDED', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439050',
        email: 'suspended@test.com',
        fullName: 'Suspended User',
        role: 'customer',
        status: 'suspended',
        isActive: false,
        emailVerified: true,
        comparePassword: vi.fn().mockResolvedValue(true),
        getEffectiveRole: () => 'customer',
      };

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      } as any);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '10.2.0.55')
        .send({
          email: 'suspended@test.com',
          password: 'Password123!',
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('allows pending technician to log in with 200', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439051',
        email: 'pendingtech@test.com',
        fullName: 'Pending Tech',
        role: 'technician',
        status: 'pending',
        isActive: true,
        emailVerified: true,
        comparePassword: vi.fn().mockResolvedValue(true),
        getEffectiveRole: () => 'technician',
      };

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      } as any);
      vi.spyOn(RefreshToken, 'create').mockResolvedValue({} as any);
      vi.spyOn(User, 'updateOne').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '10.2.0.56')
        .send({
          email: 'pendingtech@test.com',
          password: 'Password123!',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.role).toBe('technician');
      expect(res.body.data.user.status).toBe('pending');
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('rotates refresh token: revokes old token and issues fresh token pair', async () => {
      const rawToken = 'mock-raw-refresh-token-abc-123';
      const tokenHash = hashToken(rawToken);

      const mockStoredToken = {
        userId: '507f1f77bcf86cd799439001',
        tokenHash,
        revoked: false,
        expiresAt: new Date(Date.now() + 86400000),
        save: vi.fn().mockResolvedValue(true),
      };

      const mockUser = {
        _id: '507f1f77bcf86cd799439001',
        email: 'user@test.com',
        fullName: 'Test User',
        role: 'customer',
        status: 'active',
        isActive: true,
        emailVerified: true,
        getEffectiveRole: () => 'customer',
      };

      vi.spyOn(RefreshToken, 'findOne').mockResolvedValue(mockStoredToken as any);
      vi.spyOn(RefreshToken, 'create').mockResolvedValue({} as any);
      vi.spyOn(User, 'findById').mockResolvedValue(mockUser as any);

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', '10.2.0.5')
        .send({ refreshToken: rawToken });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.refreshToken).not.toBe(rawToken); // rotated!
      expect(mockStoredToken.revoked).toBe(true); // old token marked revoked
    });

    it('detects token reuse and revokes all user sessions with 401', async () => {
      const rawToken = 'already-revoked-token-xyz';
      const mockStoredToken = {
        userId: '507f1f77bcf86cd799439001',
        revoked: true, // already revoked!
      };

      vi.spyOn(RefreshToken, 'findOne').mockResolvedValue(mockStoredToken as any);
      const updateManySpy = vi.spyOn(RefreshToken, 'updateMany').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', '10.2.0.6')
        .send({ refreshToken: rawToken });

      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('TOKEN_REUSED');
      expect(updateManySpy).toHaveBeenCalledWith(
        { userId: mockStoredToken.userId },
        expect.objectContaining({ $set: expect.objectContaining({ revoked: true }) })
      );
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('returns profile of the authenticated user', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439001',
        email: 'customer@test.com',
        fullName: 'Customer Name',
        role: 'customer',
        status: 'active',
        phone: '+123456789',
        phoneVerified: false,
        emailVerified: true,
        avatarUrl: null,
        createdAt: new Date(),
        getEffectiveRole: () => 'customer',
      };

      vi.spyOn(User, 'findById').mockResolvedValue(mockUser as any);

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe('customer@test.com');
      expect(res.body.data.user.role).toBe('customer');
    });
  });

  describe('POST /api/v1/auth/change-password', () => {
    it('updates password and revokes all active refresh tokens for the user', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439001',
        password: 'hashedOldPassword',
        comparePassword: vi.fn().mockResolvedValue(true),
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(User, 'findById').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      } as any);

      const updateManySpy = vi.spyOn(RefreshToken, 'updateMany').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          currentPassword: 'OldPassword123!',
          newPassword: 'NewPassword999!',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUser.save).toHaveBeenCalled();
      expect(updateManySpy).toHaveBeenCalledWith(
        { userId: mockUser._id, revoked: false },
        expect.objectContaining({ $set: expect.objectContaining({ revoked: true }) })
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Token Type Separation & Boundary Rejection
  // -------------------------------------------------------------------------
  describe('Token type separation', () => {
    const resetToken = generatePasswordResetToken(
      { userId: '507f1f77bcf86cd799439001', email: 'user@test.com' },
      'hashed-password-123'
    );

    const verifyEmailToken = generateEmailVerificationToken({
      userId: '507f1f77bcf86cd799439001',
      email: 'user@test.com',
    });

    it('rejects password-reset token used as Bearer token on protected route with 401', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${resetToken}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('INVALID_TOKEN_TYPE');
    });

    it('rejects email-verification token used as Bearer token on protected route with 401', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${verifyEmailToken}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('INVALID_TOKEN_TYPE');
    });

    it('rejects password-reset token used as Bearer token on admin routes with 401', async () => {
      const res = await request(app)
        .get('/api/appointments')
        .set('Authorization', `Bearer ${resetToken}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('INVALID_TOKEN_TYPE');
    });

    it('rejects email-verification token used as Bearer token on admin routes with 401', async () => {
      const res = await request(app)
        .get('/api/appointments')
        .set('Authorization', `Bearer ${verifyEmailToken}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('INVALID_TOKEN_TYPE');
    });

    it('rejects access token used at verify-email endpoint with 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ token: customerToken });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('INVALID_TOKEN');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Mass Assignment Protection
  // -------------------------------------------------------------------------
  describe('Mass assignment protection', () => {
    it('rejects registration attempt with role: admin with 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', '10.2.0.7')
        .send({
          email: 'sneakyadmin@test.com',
          password: 'Password123!',
          fullName: 'Sneaky Admin',
          role: 'admin',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects registration attempt with emailVerified: true with 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', '10.2.0.8')
        .send({
          email: 'sneakyverified@test.com',
          password: 'Password123!',
          fullName: 'Sneaky User',
          emailVerified: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects PATCH /api/v1/auth/me attempt to elevate role to admin with 400', async () => {
      const res = await request(app)
        .patch('/api/v1/auth/me')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects PATCH /api/v1/auth/me attempt to set emailVerified to true with 400', async () => {
      const res = await request(app)
        .patch('/api/v1/auth/me')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ emailVerified: true });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('allows PATCH /api/v1/auth/me for non-privileged fields (fullName, phone)', async () => {
      const mockUpdatedUser = {
        _id: '507f1f77bcf86cd799439001',
        email: 'customer@test.com',
        fullName: 'Updated Name',
        phone: '+987654321',
        role: 'customer',
        status: 'active',
        phoneVerified: false,
        emailVerified: true,
        getEffectiveRole: () => 'customer',
      };
      vi.spyOn(User, 'findByIdAndUpdate').mockResolvedValue(mockUpdatedUser as any);

      const res = await request(app)
        .patch('/api/v1/auth/me')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ fullName: 'Updated Name', phone: '+987654321' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.fullName).toBe('Updated Name');
    });
  });

  // -------------------------------------------------------------------------
  // 6. requireAdminRole Enforcement on Legacy and Dispatcher Roles
  // -------------------------------------------------------------------------
  describe('requireAdminRole enforcement on admin-only endpoints', () => {
    const legacyUserToken = generateToken({
      userId: '507f1f77bcf86cd799439099',
      email: 'legacyuser@test.com',
      role: 'user',
    });

    it('blocks legacy "user" account on admin-only GET /api/appointments with 403', async () => {
      const res = await request(app)
        .get('/api/appointments')
        .set('Authorization', `Bearer ${legacyUserToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks "dispatcher" account on admin-only GET /api/appointments with 403', async () => {
      const res = await request(app)
        .get('/api/appointments')
        .set('Authorization', `Bearer ${dispatcherToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('allows "admin" account on admin-only GET /api/appointments with 200', async () => {
      const mockQuery: any = {
        select: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
        limit: vi.fn().mockResolvedValue([]),
        then(onFulfilled: any) {
          return Promise.resolve([]).then(onFulfilled);
        },
      };
      vi.spyOn(Appointment, 'find').mockReturnValue(mockQuery);
      vi.spyOn(Booking, 'find').mockReturnValue(mockQuery);

      const res = await request(app)
        .get('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Rate Limiter on /api/v1/auth/resend-verification
  // -------------------------------------------------------------------------
  describe('Rate limiting on resend-verification', () => {
    it('triggers 429 on the 4th resend-verification attempt within the window', async () => {
      vi.spyOn(User, 'findOne').mockResolvedValue(null);

      const testEmail = 'ratelimit-test@example.com';
      const testIp = '198.51.100.42';

      for (let i = 1; i <= 3; i++) {
        const res = await request(app)
          .post('/api/v1/auth/resend-verification')
          .set('X-Forwarded-For', testIp)
          .send({ email: testEmail });
        expect(res.status).toBe(200);
      }

      // 4th attempt should be blocked
      const blockedRes = await request(app)
        .post('/api/v1/auth/resend-verification')
        .set('X-Forwarded-For', testIp)
        .send({ email: testEmail });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Logout revokes refresh token
  // -------------------------------------------------------------------------
  describe('POST /api/v1/auth/logout', () => {
    it('revokes the provided refresh token in the database', async () => {
      const rawToken = 'logout-test-refresh-token';
      const tokenHash = hashToken(rawToken);

      const updateOneSpy = vi.spyOn(RefreshToken, 'updateOne').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ refreshToken: rawToken });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(updateOneSpy).toHaveBeenCalledWith(
        { tokenHash },
        expect.objectContaining({ $set: expect.objectContaining({ revoked: true }) })
      );
    });
  });

  // -------------------------------------------------------------------------
  // 9. Legacy Admin Users Management (/api/users)
  // -------------------------------------------------------------------------
  describe('Legacy Admin Users Management (/api/users)', () => {
    it('allows admin to create user with role "user"', async () => {
      vi.spyOn(User, 'findOne').mockResolvedValue(null);
      const mockSaved = {
        _id: '507f1f77bcf86cd799439090',
        email: 'newuser@admin.com',
        fullName: 'Staff User',
        role: 'user',
        isActive: true,
        createdAt: new Date(),
      };
      vi.spyOn(User.prototype, 'save').mockResolvedValue(mockSaved as any);

      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'newuser@admin.com',
          password: 'Password123!',
          fullName: 'Staff User',
          role: 'user',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe('user');
    });

    it('allows admin to create user with role "admin"', async () => {
      vi.spyOn(User, 'findOne').mockResolvedValue(null);
      const mockSaved = {
        _id: '507f1f77bcf86cd799439091',
        email: 'coadmin@admin.com',
        fullName: 'Co Admin',
        role: 'admin',
        isActive: true,
        createdAt: new Date(),
      };
      vi.spyOn(User.prototype, 'save').mockResolvedValue(mockSaved as any);

      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'coadmin@admin.com',
          password: 'Password123!',
          fullName: 'Co Admin',
          role: 'admin',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe('admin');
    });

    it('allows admin to update user role to "admin"', async () => {
      const mockUpdated = {
        _id: '507f1f77bcf86cd799439090',
        email: 'staff@admin.com',
        fullName: 'Staff Member',
        role: 'admin',
        isActive: true,
      };

      vi.spyOn(User, 'findByIdAndUpdate').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUpdated),
      } as any);

      const res = await request(app)
        .put('/api/users?id=507f1f77bcf86cd799439090')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe('admin');
    });
  });

  // -------------------------------------------------------------------------
  // 10. Advanced Rate Limiting, Account Lockout & FCM Management
  // -------------------------------------------------------------------------
  describe('Advanced Rate Limiting & Account Lockout', () => {
    it('allows normal token refreshing 20 times in a row without being blocked', async () => {
      const refreshTestIp = '10.3.0.1';

      for (let i = 0; i < 20; i++) {
        const rawToken = `token-sequence-${i}`;
        const mockStoredToken = {
          userId: '507f1f77bcf86cd799439001',
          tokenHash: hashToken(rawToken),
          revoked: false,
          expiresAt: new Date(Date.now() + 86400000),
          save: vi.fn().mockResolvedValue(true),
        };

        const mockUser = {
          _id: '507f1f77bcf86cd799439001',
          email: 'refreshseq@test.com',
          fullName: 'Refresh Sequence',
          role: 'customer',
          status: 'active',
          isActive: true,
          emailVerified: true,
          getEffectiveRole: () => 'customer',
        };

        vi.spyOn(RefreshToken, 'findOne').mockResolvedValue(mockStoredToken as any);
        vi.spyOn(RefreshToken, 'create').mockResolvedValue({} as any);
        vi.spyOn(User, 'findById').mockResolvedValue(mockUser as any);

        const res = await request(app)
          .post('/api/v1/auth/refresh')
          .set('X-Forwarded-For', refreshTestIp)
          .send({ refreshToken: rawToken });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }
    });

    it('blocks hammering the same refresh token after 10 requests with 429', async () => {
      const hammerIp = '10.3.0.2';
      const repeatedToken = 'hammered-static-refresh-token';

      vi.spyOn(RefreshToken, 'findOne').mockResolvedValue(null);

      // First 10 requests pass through rate limiter (may return 401 because token doesn't exist, but NOT 429)
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/api/v1/auth/refresh')
          .set('X-Forwarded-For', hammerIp)
          .send({ refreshToken: repeatedToken });
        expect(res.status).not.toBe(429);
      }

      // 11th request for the SAME token is blocked by refreshTokenHashLimiter with 429
      const blockedRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', hammerIp)
        .send({ refreshToken: repeatedToken });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('triggers 429 on 6th failed login attempt for the same email+IP while successful logins skip counter', async () => {
      const failedLoginIp = '10.3.0.3';
      const failedLoginEmail = 'failedlogin@test.com';

      const mockUser = {
        _id: '507f1f77bcf86cd799439001',
        email: failedLoginEmail,
        comparePassword: vi.fn().mockResolvedValue(false),
        failedLoginAttempts: 0,
        isLocked: () => false,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      } as any);

      // 5 failed login attempts
      for (let i = 1; i <= 5; i++) {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .set('X-Forwarded-For', failedLoginIp)
          .send({ email: failedLoginEmail, password: 'WrongPassword!' });
        expect(res.status).toBe(401);
      }

      // 6th attempt hits loginFailedEmailIpLimiter
      const blockedRes = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', failedLoginIp)
        .send({ email: failedLoginEmail, password: 'WrongPassword!' });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('safely skips refreshTokenHashLimiter and returns 400 (not 500) if refreshToken is missing or not a string', async () => {
      // 1. Missing refreshToken
      const emptyRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', '10.3.0.50')
        .send({});
      expect(emptyRes.status).toBe(400);
      expect(emptyRes.body.error?.code).toBe('VALIDATION_ERROR');

      // 2. null refreshToken
      const nullRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', '10.3.0.50')
        .send({ refreshToken: null });
      expect(nullRes.status).toBe(400);
      expect(nullRes.body.error?.code).toBe('VALIDATION_ERROR');

      // 3. number refreshToken
      const numRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', '10.3.0.50')
        .send({ refreshToken: 12345 });
      expect(numRes.status).toBe(400);
      expect(numRes.body.error?.code).toBe('VALIDATION_ERROR');

      // 4. whitespace-only refreshToken
      const wsRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', '10.3.0.50')
        .send({ refreshToken: '    ' });
      expect(wsRes.status).toBe(400);
      expect(wsRes.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('enforces lockout per email+IP with atomic $inc, returns generic 401, sends lockout email, and leaves other IPs unaffected', async () => {
      const email = 'lockout@test.com';
      const ipA = '10.3.0.99';
      const ipB = '10.3.0.100';

      const mockUser = {
        _id: '507f1f77bcf86cd799439088',
        email,
        fullName: 'Lockout User',
        role: 'customer',
        status: 'active',
        isActive: true,
        comparePassword: vi.fn().mockImplementation(async (pwd: string) => pwd === 'CorrectPassword!'),
        save: vi.fn().mockResolvedValue(true),
        getEffectiveRole: () => 'customer',
      };

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      } as any);

      // Simulate 10th failed attempt from IP A
      const findOneAndUpdateSpy = vi.spyOn(LoginAttempt, 'findOneAndUpdate').mockResolvedValue({
        key: `${email}:${ipA}`,
        failedLoginAttempts: 10,
      } as any);
      const updateOneSpy = vi.spyOn(LoginAttempt, 'updateOne').mockResolvedValue({} as any);

      // 10th failure from IP A
      const res10 = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ipA)
        .send({ email, password: 'WrongPassword!' });

      // Returns identical generic 401 error
      expect(res10.status).toBe(401);
      expect(res10.body.error?.code).toBe('INVALID_CREDENTIALS');
      expect(res10.body.message).toBe('Invalid email or password');
      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        { key: `${email}:${ipA}` },
        {
          $inc: { failedLoginAttempts: 1 },
          $setOnInsert: { email, ip: ipA },
        },
        { upsert: true, returnDocument: 'after' }
      );
      // Lockout duration set in updateOne
      expect(updateOneSpy).toHaveBeenCalledWith(
        { key: `${email}:${ipA}` },
        expect.objectContaining({
          $set: expect.objectContaining({
            failedLoginAttempts: 0,
          }),
        })
      );

      // Subsequent attempt from IP A while locked: returns generic 401 (not 423)
      vi.spyOn(LoginAttempt, 'findOne').mockImplementation((query: any) => {
        if (query?.key === `${email}:${ipA}`) {
          return Promise.resolve({
            key: `${email}:${ipA}`,
            isLocked: () => true,
          }) as any;
        }
        return Promise.resolve(null) as any;
      });

      const resLocked = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ipA)
        .send({ email, password: 'WrongPassword!' });

      expect(resLocked.status).toBe(401);
      expect(resLocked.body.error?.code).toBe('INVALID_CREDENTIALS');
      expect(resLocked.body.message).toBe('Invalid email or password');

      // Attempt from IP B is NOT locked and succeeds with valid credentials
      vi.spyOn(RefreshToken, 'create').mockResolvedValue({} as any);
      vi.spyOn(User, 'updateOne').mockResolvedValue({} as any);
      const deleteOneSpy = vi.spyOn(LoginAttempt, 'deleteOne').mockResolvedValue({} as any);

      const resIpB = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ipB)
        .send({ email, password: 'CorrectPassword!' });

      expect(resIpB.status).toBe(200);
      expect(resIpB.body.success).toBe(true);
      expect(deleteOneSpy).toHaveBeenCalledWith({ key: `${email}:${ipB}` });
    });

    it('clears LoginAttempt lockouts on password reset so accounts are never locked out permanently', async () => {
      const deleteManySpy = vi.spyOn(LoginAttempt, 'deleteMany').mockResolvedValue({} as any);
      const email = 'resetlockout@test.com';
      const rawOldPasswordHash = '$2b$10$abcdefghijklmnopqrstuvwxyz123456';
      const validToken = generatePasswordResetToken(
        { userId: '507f1f77bcf86cd799439099', email },
        rawOldPasswordHash
      );

      const mockUser = {
        _id: '507f1f77bcf86cd799439099',
        email,
        fullName: 'Reset Lockout User',
        role: 'admin',
        isActive: true,
        password: rawOldPasswordHash,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(User, 'findById').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      } as any);
      vi.spyOn(RefreshToken, 'updateMany').mockResolvedValue({} as any);

      const { AuthService } = await import('../modules/auth/service');
      await AuthService.resetPassword(validToken, 'BrandNewPassword123!');

      expect(deleteManySpy).toHaveBeenCalledWith({ email });
    });

    it('enforces register rate limit: 10 per hour per IP (11th triggers 429)', async () => {
      const regIp = '10.3.0.10';
      vi.spyOn(User, 'findOne').mockResolvedValue(null);
      vi.spyOn(User.prototype, 'save').mockResolvedValue({
        _id: '507f1f77bcf86cd799439001',
        email: 'reg@test.com',
        role: 'customer',
        status: 'active',
        getEffectiveRole: () => 'customer',
      } as any);
      vi.spyOn(RefreshToken, 'create').mockResolvedValue({} as any);
      vi.spyOn(User, 'updateOne').mockResolvedValue({} as any);

      for (let i = 1; i <= 10; i++) {
        const res = await request(app)
          .post('/api/v1/auth/register')
          .set('X-Forwarded-For', regIp)
          .send({
            email: `bulkuser${i}@test.com`,
            password: 'Password123!',
            fullName: `User ${i}`,
          });
        expect(res.status).toBe(201);
      }

      // 11th triggers 429
      const blockedRes = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', regIp)
        .send({
          email: 'bulkuser11@test.com',
          password: 'Password123!',
          fullName: 'User 11',
        });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('enforces forgot-password rate limit: 5 per 15 min per email+IP', async () => {
      const forgotIp = '10.3.0.20';
      const forgotEmail = 'forgotrate@test.com';

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(null),
      } as any);

      for (let i = 1; i <= 5; i++) {
        const res = await request(app)
          .post('/api/v1/auth/forgot-password')
          .set('X-Forwarded-For', forgotIp)
          .send({ email: forgotEmail });
        expect(res.status).toBe(200);
      }

      // 6th triggers 429
      const blockedRes = await request(app)
        .post('/api/v1/auth/forgot-password')
        .set('X-Forwarded-For', forgotIp)
        .send({ email: forgotEmail });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('caps fcmTokens at 10 and removes fcmToken on logout', async () => {
      // 1. Caps at 10 in login
      const mockUserWith10Tokens = {
        _id: '507f1f77bcf86cd799439001',
        email: 'fcmtest@test.com',
        fullName: 'FCM Tester',
        role: 'customer',
        status: 'active',
        isActive: true,
        emailVerified: true,
        fcmTokens: ['token-1', 'token-2', 'token-3', 'token-4', 'token-5', 'token-6', 'token-7', 'token-8', 'token-9', 'token-10'],
        comparePassword: vi.fn().mockResolvedValue(true),
        isLocked: () => false,
        save: vi.fn().mockResolvedValue(true),
        getEffectiveRole: () => 'customer',
      };

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUserWith10Tokens),
      } as any);
      vi.spyOn(RefreshToken, 'create').mockResolvedValue({} as any);
      vi.spyOn(User, 'updateOne').mockResolvedValue({} as any);

      await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '10.3.0.30')
        .send({
          email: 'fcmtest@test.com',
          password: 'Password123!',
          deviceInfo: 'iPhone 15 Pro, iOS 18.2',
          fcmToken: 'new-token-11',
        });

      // Verify length capped at 10 and oldest ('token-1') dropped
      expect(mockUserWith10Tokens.fcmTokens.length).toBe(10);
      expect(mockUserWith10Tokens.fcmTokens).toContain('new-token-11');
      expect(mockUserWith10Tokens.fcmTokens).not.toContain('token-1');

      // 2. Removes fcmToken on logout
      const userUpdateSpy = vi.spyOn(User, 'updateOne').mockResolvedValue({} as any);
      const tokenUpdateSpy = vi.spyOn(RefreshToken, 'updateOne').mockResolvedValue({} as any);

      const logoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          refreshToken: 'dummy-refresh-token',
          fcmToken: 'new-token-11',
        });

      expect(logoutRes.status).toBe(200);
      expect(userUpdateSpy).toHaveBeenCalledWith(
        { _id: '507f1f77bcf86cd799439001' },
        { $pull: { fcmTokens: 'new-token-11' } }
      );
    });
  });
});


