import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { generateToken, generateAccessToken, generatePasswordResetToken } from '../utils/jwt';
import { Appointment } from '../models/Appointment';
import { Blog } from '../models/Blog';
import { Coupon } from '../models/Coupon';
import { Feedback } from '../models/Feedback';
import { User } from '../models/User';
import { Contact } from '../models/Contact';
import { Booking } from '../models/Booking';
import { Service } from '../models/Service';

// Mock DB connection to avoid external network dependencies during tests
vi.mock('../config/database', () => ({
  connectDB: vi.fn().mockResolvedValue(true),
}));

// Mock BookingService
vi.mock('../modules/bookings/service', () => ({
  BookingService: {
    createBooking: vi.fn().mockResolvedValue({
      _id: '507f1f77bcf86cd799439099',
      bookingNumber: 'GIS-000001',
      guest: { fullName: 'Jane Customer', email: 'customer@example.com', phone: '555-123-4567' },
      vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2023 },
      serviceSnapshot: { name: 'Super Wax Detail', slug: 'super-wax-detail' },
      addons: [],
      address: { freeText: '123 Main St, Springfield, IL', country: 'USA' },
      scheduledLocal: { date: '2026-10-15', slot: '10:00' },
      pricing: {
        baseCents: 27899, addonsCents: 0, discountCents: 0, couponCode: null,
        couponPercent: 0, taxCents: 0, totalCents: 27899,
        commissionPercent: 15, processingPercent: 3,
        commissionCents: 4185, processingCents: 837, providerPayoutCents: 22877
      },
      status: 'pending',
      statusHistory: [{ status: 'pending', by: 'customer@example.com', at: new Date() }],
      source: 'web',
      legacyAppointmentId: '507f1f77bcf86cd799439099',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  },
}));

// Mock Email and Cloudinary services
vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'test-email-id' }),
  getBookingConfirmationEmail: vi.fn().mockReturnValue('<p>Email</p>'),
  getAdminNotificationEmail: vi.fn().mockReturnValue('<p>Admin</p>'),
  getContactAcknowledgmentEmail: vi.fn().mockReturnValue('<p>Ack</p>'),
  getPasswordResetEmail: vi.fn().mockReturnValue('<p>Reset</p>'),
  getStatusUpdateEmail: vi.fn().mockReturnValue('<p>Status</p>'),
}));

vi.mock('../utils/cloudinary', () => ({
  uploadToCloudinary: vi.fn().mockResolvedValue('https://res.cloudinary.com/test/image/upload/sample.jpg'),
  default: {
    config: vi.fn(),
    uploader: { upload: vi.fn() },
  },
}));

function mockChainableQuery(data: any = []) {
  const query: any = {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockImplementation(() => Promise.resolve(data)),
    limit: vi.fn().mockImplementation(() => Promise.resolve(data)),
    then(onFulfilled: any, onRejected?: any) {
      return Promise.resolve(data).then(onFulfilled, onRejected);
    },
  };
  return query;
}

describe('Security Hardening & RBAC Test Suite', () => {
  const adminToken = generateToken({
    userId: '507f1f77bcf86cd799439011',
    email: 'admin@globalintegratedsupport.com',
    role: 'admin',
  });

  const userToken = generateToken({
    userId: '507f1f77bcf86cd799439022',
    email: 'user@example.com',
    role: 'user',
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Unauthenticated requests must receive 401
  // -------------------------------------------------------------------------
  describe('Unauthenticated requests (401 Unauthorized)', () => {
    const protectedRoutes = [
      { method: 'get', path: '/api/appointments' },
      { method: 'put', path: '/api/appointments/507f1f77bcf86cd799439011' },
      { method: 'delete', path: '/api/appointments/507f1f77bcf86cd799439011' },
      { method: 'post', path: '/api/blogs' },
      { method: 'put', path: '/api/blogs/507f1f77bcf86cd799439011' },
      { method: 'delete', path: '/api/blogs/507f1f77bcf86cd799439011' },
      { method: 'get', path: '/api/blogs?all=true' },
      { method: 'post', path: '/api/upload' },
      { method: 'delete', path: '/api/contact/507f1f77bcf86cd799439011' },
      { method: 'put', path: '/api/contact/507f1f77bcf86cd799439011' },
      { method: 'delete', path: '/api/contact/507f1f77bcf86cd799439011' },
      { method: 'get', path: '/api/feedback' },
      { method: 'put', path: '/api/feedback/507f1f77bcf86cd799439011' },
      { method: 'delete', path: '/api/feedback/507f1f77bcf86cd799439011' },
      { method: 'post', path: '/api/feedback/sync-facebook' },
      { method: 'get', path: '/api/coupons' },
      { method: 'post', path: '/api/coupons' },
      { method: 'put', path: '/api/coupons/507f1f77bcf86cd799439011' },
      { method: 'delete', path: '/api/coupons/507f1f77bcf86cd799439011' },
      { method: 'get', path: '/api/users' },
      { method: 'post', path: '/api/users' },
      { method: 'put', path: '/api/users/507f1f77bcf86cd799439011' },
      { method: 'delete', path: '/api/users/507f1f77bcf86cd799439011' },
    ];

    for (const route of protectedRoutes) {
      it(`blocks unauthenticated ${route.method.toUpperCase()} ${route.path} with 401`, async () => {
        const req = (request(app) as any)[route.method](route.path);
        const res = await req;
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error?.code).toBe('UNAUTHORIZED');
      });
    }

    it('rejects requests with invalid/malformed tokens with 401', async () => {
      const res = await request(app)
        .get('/api/appointments')
        .set('Authorization', 'Bearer invalid-token-string');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Non-admin users must receive 403 Forbidden
  // -------------------------------------------------------------------------
  describe('Non-admin access (403 Forbidden)', () => {
    const adminOnlyRoutes = [
      { method: 'get', path: '/api/appointments' },
      { method: 'post', path: '/api/blogs' },
      { method: 'post', path: '/api/upload' },
      { method: 'get', path: '/api/users' },
      // /api/contact GET is now allowed for dispatchers; DELETE is admin-only
      { method: 'delete', path: '/api/contact/507f1f77bcf86cd799439011' },
      { method: 'post', path: '/api/coupons' },
    ];

    for (const route of adminOnlyRoutes) {
      it(`denies non-admin ${route.method.toUpperCase()} ${route.path} with 403`, async () => {
        const req = (request(app) as any)[route.method](route.path)
          .set('Authorization', `Bearer ${userToken}`);
        const res = await req;
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error?.code).toBe('FORBIDDEN');
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Admin token succeeds
  // -------------------------------------------------------------------------
  describe('Admin access succeeds', () => {
    it('allows admin to list appointments without 401 or 403', async () => {
      vi.spyOn(Appointment, 'find').mockReturnValue(mockChainableQuery([]) as any);
      vi.spyOn(Booking, 'find').mockReturnValue(mockChainableQuery([]) as any);

      const res = await request(app)
        .get('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('allows admin to list coupons without 401 or 403', async () => {
      vi.spyOn(Coupon, 'find').mockReturnValue(mockChainableQuery([]) as any);

      const res = await request(app)
        .get('/api/coupons')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Public endpoints stay accessible
  // -------------------------------------------------------------------------
  describe('Public routes remain accessible', () => {
    it('GET /api/health responds with 200 and correct shape when DB is up', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.db).toBe('connected');
      expect(typeof res.body.uptime).toBe('number');
      expect(typeof res.body.version).toBe('string');
      expect(typeof res.body.timestamp).toBe('string');
      expect(typeof res.body.responseTimeMs).toBe('number');
      // Must not expose secrets or env values
      expect(res.body.mongoUri).toBeUndefined();
      expect(res.body.jwtSecret).toBeUndefined();
    });

    it('GET /api/health returns 503 with status "degraded" when DB is down', async () => {
      // Override the mock to simulate a DB failure for this test only
      const { connectDB } = await import('../config/database');
      vi.mocked(connectDB).mockRejectedValueOnce(new Error('simulated DB failure'));

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.db).toBe('disconnected');
    });

    it('GET /api/coupons?active=true is accessible publicly', async () => {
      vi.spyOn(Coupon, 'find').mockReturnValue(mockChainableQuery([]) as any);

      const res = await request(app).get('/api/coupons?active=true');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('GET /api/feedback?status=publish is accessible publicly', async () => {
      vi.spyOn(Feedback, 'find').mockReturnValue(mockChainableQuery([]) as any);

      const res = await request(app).get('/api/feedback?status=publish');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('GET /api/blogs (published list) is accessible publicly', async () => {
      vi.spyOn(Blog, 'find').mockReturnValue(mockChainableQuery([]) as any);

      const res = await request(app).get('/api/blogs');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Zod Validation on forms
  // -------------------------------------------------------------------------
  describe('Zod Validation Enforcement (400 Bad Request)', () => {
    it('rejects POST /api/appointments with invalid payload and gives field details', async () => {
      const res = await request(app)
        .post('/api/appointments')
        .send({
          fullName: '',
          email: 'not-an-email',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(res.body.error?.details)).toBe(true);
      expect(res.body.error.details.length).toBeGreaterThan(0);
    });

    it('rejects POST /api/contact with missing fields', async () => {
      const res = await request(app)
        .post('/api/contact')
        .send({ fullName: 'John Doe' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects POST /api/feedback with out-of-range rating', async () => {
      const res = await request(app)
        .post('/api/feedback')
        .send({
          name: 'Jane Doe',
          rating: 10, // Max is 5
          feedback: 'Great service!',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Public appointment booking flow
  // -------------------------------------------------------------------------
  describe('Public appointment booking flow', () => {
    it('successfully books appointment when valid data is provided', async () => {
      const validAppointment = {
        fullName: 'Jane Customer',
        phone: '555-123-4567',
        email: 'customer@example.com',
        address: '123 Main St, Springfield, IL',
        serviceType: 'Super Wax Detail',
        vehicleCategory: 'Sedan',
        year: '2023',
        make: 'Toyota',
        vehicleModel: 'Camry',
        date: '2026-10-15',
        timeSlot: '10:00 AM',
        basePrice: 219.99,
        totalPrice: 219.99,
        addons: [],
        coupons: [],
      };

      vi.spyOn(Appointment.prototype, 'save').mockImplementation(function (this: any) {
        this._id = '507f1f77bcf86cd799439099';
        return Promise.resolve(this);
      });
      vi.spyOn(Service, 'find').mockReturnValue(mockChainableQuery([
        { _id: '507f1f77bcf86cd799439001', name: 'Super Wax Detail', slug: 'super-wax-detail', isActive: true },
      ]) as any);
      vi.spyOn(Service, 'findOne').mockResolvedValue({ _id: '507f1f77bcf86cd799439001', name: 'Super Wax Detail', slug: 'super-wax-detail', isActive: true } as any);

      const res = await request(app)
        .post('/api/appointments')
        .set('X-Forwarded-For', '10.77.1.1')
        .send(validAppointment);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.fullName).toBe('Jane Customer');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Upload endpoint security & validation
  // -------------------------------------------------------------------------
  describe('Upload route validation (/api/upload)', () => {
    it('rejects upload without image payload with 400', async () => {
      const res = await request(app)
        .post('/api/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects non-image payload (e.g. text/plain) with 400', async () => {
      const fakeTextBase64 = Buffer.from('hello world not an image').toString('base64');
      const res = await request(app)
        .post('/api/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ image: `data:text/plain;base64,${fakeTextBase64}` });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('INVALID_FILE_TYPE');
    });

    it('accepts valid base64 PNG image for admin', async () => {
      // 1x1 transparent PNG base64
      const pngBase64 =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

      const res = await request(app)
        .post('/api/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ image: pngBase64 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // 8. Rate limiting & Trust Proxy enforcement
  // -------------------------------------------------------------------------
  describe('Rate Limiting & Trust Proxy enforcement', () => {
    it('triggers 429 when login attempts exceed limit (5 attempts)', async () => {
      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(null),
        then(onFulfilled: any) {
          return Promise.resolve(null).then(onFulfilled);
        },
      } as any);

      let triggered429 = false;
      let lastBody: any = null;

      for (let i = 0; i < 7; i++) {
        const res = await request(app)
          .post('/api/auth/login')
          .set('X-Forwarded-For', '198.51.100.50')
          .send({ email: 'bad@example.com', password: 'wrong' });

        if (res.status === 429) {
          triggered429 = true;
          lastBody = res.body;
          break;
        }
      }

      expect(triggered429).toBe(true);
      expect(lastBody?.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('separately counts rate limits for different X-Forwarded-For client IPs', async () => {
      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(null),
        then(onFulfilled: any) {
          return Promise.resolve(null).then(onFulfilled);
        },
      } as any);

      const clientIp1 = '198.51.100.101';
      const clientIp2 = '198.51.100.102';

      // Exhaust client IP 1 limit
      for (let i = 0; i < 6; i++) {
        await request(app)
          .post('/api/auth/login')
          .set('X-Forwarded-For', clientIp1)
          .send({ email: 'bad1@example.com', password: 'wrong' });
      }

      // Verify client IP 1 is blocked with 429
      const resIp1 = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', clientIp1)
        .send({ email: 'bad1@example.com', password: 'wrong' });
      expect(resIp1.status).toBe(429);

      // Verify client IP 2 is NOT blocked (gets 401 invalid credentials)
      const resIp2 = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', clientIp2)
        .send({ email: 'bad2@example.com', password: 'wrong' });
      expect(resIp2.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Single-Use Password Reset Tokens & Timing Attack Defense
  // -------------------------------------------------------------------------
  describe('Password Reset Security & Timing Attack Resistance', () => {
    it('ensures password reset tokens are single-use and invalid after password change', async () => {
      const initialPasswordHash = '$2a$10$oldpasswordhashfingerprint001';
      let currentPasswordHash = initialPasswordHash;

      const mockUser: any = {
        _id: '507f1f77bcf86cd799439033',
        email: 'admin@gis.com',
        role: 'admin',
        isActive: true,
        get password() {
          return currentPasswordHash;
        },
        set password(val: string) {
          // When password is changed, a new hash is generated
          currentPasswordHash = `$2a$10$newhashafterchange${val}`;
        },
        save: vi.fn().mockImplementation(function (this: any) {
          return Promise.resolve(this);
        }),
      };

      vi.spyOn(User, 'findById').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      } as any);

      // 1. Generate token using current password hash
      const resetToken = generatePasswordResetToken(
        { userId: mockUser._id, email: mockUser.email },
        initialPasswordHash
      );

      // 2. First reset attempt succeeds
      const firstAttempt = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: resetToken, newPassword: 'SuperSecret123!' });

      expect(firstAttempt.status).toBe(200);
      expect(firstAttempt.body.success).toBe(true);

      // 3. Second attempt with the exact same token MUST fail with 400
      const secondAttempt = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: resetToken, newPassword: 'AnotherSecret456!' });

      expect(secondAttempt.status).toBe(400);
      expect(secondAttempt.body.success).toBe(false);
      expect(secondAttempt.body.error?.code).toBe('INVALID_TOKEN');
    });

    it('returns identical responses whether or not forgot-password email exists', async () => {
      // Scenario A: Email exists
      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue({
          _id: '507f1f77bcf86cd799439044',
          email: 'exists@gis.com',
          isActive: true,
          password: '$2a$10$hashedpasswordforexistinguser',
        }),
      } as any);

      const resExists = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'exists@gis.com' });

      expect(resExists.status).toBe(200);
      expect(resExists.body).toEqual({
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent.',
      });

      // Scenario B: Email does not exist
      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(null),
      } as any);

      const resNotExists = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'nonexistent@gis.com' });

      expect(resNotExists.status).toBe(200);
      expect(resNotExists.body).toEqual(resExists.body);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Public Feedback Sanitization (Never exposes email or internal fields)
  // -------------------------------------------------------------------------
  describe('Public Feedback Sanitization (GET /api/feedback?status=publish)', () => {
    it('returns only name, rating, title, feedback, source, createdAt, profileUrl and excludes email', async () => {
      const mockRawFeedback = [
        {
          _id: '507f1f77bcf86cd799439055',
          name: 'Sarah Connor',
          email: 'sarah.private@secretmail.com', // Must NOT be returned
          rating: 5,
          title: 'Outstanding detailing',
          feedback: 'My car looks brand new!',
          source: 'manual',
          status: 'publish', // Internal field, must NOT be in public payload
          externalId: 'ext-fb-12345', // Must NOT be returned
          profileUrl: 'https://example.com/avatar.jpg',
          createdAt: new Date('2026-09-01T10:00:00Z'),
          updatedAt: new Date('2026-09-02T10:00:00Z'),
          __v: 0,
        },
      ];

      vi.spyOn(Feedback, 'find').mockReturnValue(mockChainableQuery(mockRawFeedback) as any);

      const res = await request(app).get('/api/feedback?status=publish');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);

      const publicItem = res.body.data[0];
      // Permitted public fields
      expect(publicItem.name).toBe('Sarah Connor');
      expect(publicItem.rating).toBe(5);
      expect(publicItem.title).toBe('Outstanding detailing');
      expect(publicItem.feedback).toBe('My car looks brand new!');
      expect(publicItem.source).toBe('manual');
      expect(publicItem.profileUrl).toBe('https://example.com/avatar.jpg');
      expect(publicItem.createdAt).toBeTruthy();

      // Forbidden sensitive and internal fields
      expect(publicItem.email).toBeUndefined();
      expect(publicItem._id).toBeUndefined();
      expect(publicItem.status).toBeUndefined();
      expect(publicItem.externalId).toBeUndefined();
      expect(publicItem.updatedAt).toBeUndefined();
      expect(publicItem.__v).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Blog isolation (Unpublished posts never returned publicly)
  // -------------------------------------------------------------------------
  describe('Blog Isolation & Access Control', () => {
    it('requires admin token for GET /api/blogs?all=true (401 without token, 403 for user)', async () => {
      // 401 unauthenticated
      const unauth = await request(app).get('/api/blogs?all=true');
      expect(unauth.status).toBe(401);

      // 403 non-admin
      const forbidden = await request(app)
        .get('/api/blogs?all=true')
        .set('Authorization', `Bearer ${userToken}`);
      expect(forbidden.status).toBe(403);

      // 200 admin succeeds
      vi.spyOn(Blog, 'find').mockReturnValue(mockChainableQuery([]) as any);
      const allowed = await request(app)
        .get('/api/blogs?all=true')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(allowed.status).toBe(200);
    });

    it('never returns unpublished posts to public GET /api/blogs', async () => {
      let capturedQuery: any = null;
      vi.spyOn(Blog, 'find').mockImplementation((q: any) => {
        capturedQuery = q;
        return mockChainableQuery([]) as any;
      });

      const res = await request(app).get('/api/blogs');
      expect(res.status).toBe(200);
      expect(capturedQuery).toEqual({ published: true });
    });

    it('returns 404 for unpublished blog post requested by slug via public GET /api/blogs/:slug', async () => {
      vi.spyOn(Blog, 'findOne').mockResolvedValue(null);

      const res = await request(app).get('/api/blogs/unpublished-secret-draft');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Blog not found');
    });
  });

  // -------------------------------------------------------------------------
  // 12. Security Headers & Logger Redaction
  // -------------------------------------------------------------------------
  describe('Security Headers & Logger Redaction', () => {
    it('sets Referrer-Policy: no-referrer header via helmet on responses', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('pino-http serializer redacts/strips query strings and never logs X-Booking-Token or Authorization', async () => {
      const { serializePinoReq } = await import('../app');

      const mockReq = {
        id: 'req-test-123',
        method: 'GET',
        url: '/api/v1/bookings/507f1f77bcf86cd799439011?token=raw_secret_guest_token_12345&foo=bar',
        headers: {
          'user-agent': 'Mozilla/5.0 Test Agent',
          'content-type': 'application/json',
          host: 'localhost:3000',
          'x-booking-token': 'super-secret-token',
          authorization: 'Bearer secret-jwt-bearer-token',
          cookie: 'session=secret-cookie',
        },
      };

      const serialized = serializePinoReq(mockReq);

      // Query string must be stripped from url
      expect(serialized.url).toBe('/api/v1/bookings/507f1f77bcf86cd799439011');
      expect(serialized.url).not.toContain('token');
      expect(serialized.url).not.toContain('raw_secret_guest_token_12345');

      // Sensitive headers must never be logged
      expect((serialized.headers as any)['x-booking-token']).toBeUndefined();
      expect((serialized.headers as any)['authorization']).toBeUndefined();
      expect((serialized.headers as any)['cookie']).toBeUndefined();

      // Whitelisted safe headers preserved
      expect(serialized.headers['user-agent']).toBe('Mozilla/5.0 Test Agent');
      expect(serialized.headers['content-type']).toBe('application/json');
      expect(serialized.headers.host).toBe('localhost:3000');
    });
  });

  // -------------------------------------------------------------------------
  // 13. Legacy Login & Live User Status Check
  // -------------------------------------------------------------------------
  describe('13. Legacy Login & Live User Status Check', () => {
    it('blocks suspended user from logging in via /api/auth/login with 403 ACCOUNT_SUSPENDED', async () => {
      const mockSuspended = {
        _id: '507f1f77bcf86cd799439050',
        email: 'suspended-legacy@test.com',
        fullName: 'Suspended Admin',
        role: 'admin',
        status: 'suspended',
        isActive: false,
        comparePassword: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockSuspended),
      } as any);

      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.221')
        .send({ email: 'suspended-legacy@test.com', password: 'Password123!' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('allows pending technician to log in via /api/auth/login with 200', async () => {
      const mockPendingTech = {
        _id: '507f1f77bcf86cd799439051',
        email: 'pending-tech-legacy@test.com',
        fullName: 'Pending Tech',
        role: 'technician',
        status: 'pending',
        isActive: true,
        comparePassword: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(User, 'findOne').mockReturnValue({
        select: vi.fn().mockResolvedValue(mockPendingTech),
      } as any);

      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.222')
        .send({ email: 'pending-tech-legacy@test.com', password: 'Password123!' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
    });

    it('blocks legacy admin token with 403 ACCOUNT_SUSPENDED when user status becomes suspended', async () => {
      const { clearUserStatusCache } = await import('../middleware/auth');
      clearUserStatusCache();

      const suspendedAdminToken = generateToken({
        userId: '507f1f77bcf86cd799439088',
        email: 'suspendedadmin@test.com',
        role: 'admin',
      });

      // DB returns suspended user
      vi.spyOn(User, 'findById').mockReturnValue({
        select: vi.fn().mockResolvedValue({
          _id: '507f1f77bcf86cd799439088',
          status: 'suspended',
          isActive: false,
          role: 'admin',
        }),
      } as any);

      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${suspendedAdminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('ACCOUNT_SUSPENDED');

      // Now reinstate the user
      clearUserStatusCache();
      vi.spyOn(User, 'findById').mockReturnValue({
        select: vi.fn().mockResolvedValue({
          _id: '507f1f77bcf86cd799439088',
          status: 'active',
          isActive: true,
          role: 'admin',
        }),
      } as any);
      vi.spyOn(User, 'find').mockReturnValue(mockChainableQuery([{ _id: '507f1f77bcf86cd799439088' }]));

      const reinstatedRes = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${suspendedAdminToken}`);

      expect(reinstatedRes.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // 14. Dispatcher & Legacy user Role Permissions Matrix
  // -------------------------------------------------------------------------
  describe('14. Dispatcher & Legacy user Role Permissions Matrix', () => {
    const dispatcherToken = generateToken({
      userId: '507f1f77bcf86cd799439033',
      email: 'dispatcher@example.com',
      role: 'dispatcher',
    });

    const legacyUserToken = generateToken({
      userId: '507f1f77bcf86cd799439044',
      email: 'legacyuser@example.com',
      role: 'user',
    });

    beforeEach(async () => {
      const { clearUserStatusCache } = await import('../middleware/auth');
      clearUserStatusCache();
      vi.spyOn(User, 'findById').mockImplementation((id: any) => ({
        select: vi.fn().mockImplementation(() => {
          const strId = id?.toString();
          if (strId === '507f1f77bcf86cd799439077') {
            return Promise.resolve({ _id: id, status: 'active', isActive: true, role: 'customer' });
          }
          if (strId === '507f1f77bcf86cd799439078') {
            return Promise.resolve({ _id: id, status: 'active', isActive: true, role: 'technician' });
          }
          return Promise.resolve({
            _id: id || '507f1f77bcf86cd799439033',
            status: 'active',
            isActive: true,
            role: 'dispatcher',
          });
        }),
      } as any));
    });

    it('allows dispatcher and legacy user on GET /api/contact', async () => {
      vi.spyOn(Contact, 'find').mockReturnValue(mockChainableQuery([]));

      const resDisp = await request(app)
        .get('/api/contact')
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(resDisp.status).toBe(200);

      const resLegacy = await request(app)
        .get('/api/contact')
        .set('Authorization', `Bearer ${legacyUserToken}`);
      expect(resLegacy.status).toBe(200);
    });

    it('allows dispatcher and legacy user on PUT /api/contact/:id', async () => {
      vi.spyOn(Contact, 'findByIdAndUpdate').mockResolvedValue({ _id: '507f1f77bcf86cd799439099', status: 'Reviewed' } as any);

      const resDisp = await request(app)
        .put('/api/contact/507f1f77bcf86cd799439099')
        .set('Authorization', `Bearer ${dispatcherToken}`)
        .send({ status: 'Reviewed' });
      expect(resDisp.status).toBe(200);

      const resLegacy = await request(app)
        .put('/api/contact/507f1f77bcf86cd799439099')
        .set('Authorization', `Bearer ${legacyUserToken}`)
        .send({ status: 'Reviewed' });
      expect(resLegacy.status).toBe(200);
    });

    it('blocks dispatcher and legacy user on DELETE /api/contact/:id (403)', async () => {
      const resDisp = await request(app)
        .delete('/api/contact/507f1f77bcf86cd799439099')
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(resDisp.status).toBe(403);

      const resLegacy = await request(app)
        .delete('/api/contact/507f1f77bcf86cd799439099')
        .set('Authorization', `Bearer ${legacyUserToken}`);
      expect(resLegacy.status).toBe(403);
    });

    it('allows dispatcher and legacy user on GET /api/feedback', async () => {
      vi.spyOn(Feedback, 'find').mockReturnValue(mockChainableQuery([]));

      const resDisp = await request(app)
        .get('/api/feedback')
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(resDisp.status).toBe(200);

      const resLegacy = await request(app)
        .get('/api/feedback')
        .set('Authorization', `Bearer ${legacyUserToken}`);
      expect(resLegacy.status).toBe(200);
    });

    it('blocks dispatcher and legacy user on PUT /api/feedback/:id (403)', async () => {
      const resDisp = await request(app)
        .put('/api/feedback/507f1f77bcf86cd799439099')
        .set('Authorization', `Bearer ${dispatcherToken}`)
        .send({ status: 'publish' });
      expect(resDisp.status).toBe(403);

      const resLegacy = await request(app)
        .put('/api/feedback/507f1f77bcf86cd799439099')
        .set('Authorization', `Bearer ${legacyUserToken}`)
        .send({ status: 'publish' });
      expect(resLegacy.status).toBe(403);
    });

    it('blocks dispatcher and legacy user on DELETE /api/feedback/:id (403)', async () => {
      const resDisp = await request(app)
        .delete('/api/feedback/507f1f77bcf86cd799439099')
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(resDisp.status).toBe(403);

      const resLegacy = await request(app)
        .delete('/api/feedback/507f1f77bcf86cd799439099')
        .set('Authorization', `Bearer ${legacyUserToken}`);
      expect(resLegacy.status).toBe(403);
    });

    it('blocks dispatcher and legacy user on POST /api/feedback/sync-facebook (403)', async () => {
      const resDisp = await request(app)
        .post('/api/feedback/sync-facebook')
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(resDisp.status).toBe(403);

      const resLegacy = await request(app)
        .post('/api/feedback/sync-facebook')
        .set('Authorization', `Bearer ${legacyUserToken}`);
      expect(resLegacy.status).toBe(403);
    });

    it('blocks customer and technician tokens on /api/contact and /api/feedback (403)', async () => {
      const customerToken = generateAccessToken({
        userId: '507f1f77bcf86cd799439077',
        email: 'cust@example.com',
        role: 'customer',
        status: 'active',
        emailVerified: true,
      });

      const techToken = generateAccessToken({
        userId: '507f1f77bcf86cd799439078',
        email: 'tech@example.com',
        role: 'technician',
        status: 'active',
        emailVerified: true,
      });

      // GET /api/contact
      const resCustContact = await request(app).get('/api/contact').set('Authorization', `Bearer ${customerToken}`);
      expect(resCustContact.status).toBe(403);
      const resTechContact = await request(app).get('/api/contact').set('Authorization', `Bearer ${techToken}`);
      expect(resTechContact.status).toBe(403);

      // PUT /api/contact/:id
      const resCustContactPut = await request(app).put('/api/contact/507f1f77bcf86cd799439099').set('Authorization', `Bearer ${customerToken}`).send({ status: 'Reviewed' });
      expect(resCustContactPut.status).toBe(403);
      const resTechContactPut = await request(app).put('/api/contact/507f1f77bcf86cd799439099').set('Authorization', `Bearer ${techToken}`).send({ status: 'Reviewed' });
      expect(resTechContactPut.status).toBe(403);

      // GET /api/feedback (non-public, without ?status=publish)
      const resCustFeedback = await request(app).get('/api/feedback').set('Authorization', `Bearer ${customerToken}`);
      expect(resCustFeedback.status).toBe(403);
      const resTechFeedback = await request(app).get('/api/feedback').set('Authorization', `Bearer ${techToken}`);
      expect(resTechFeedback.status).toBe(403);
    });

    it('proves legacy user role gets 403 on all admin-only routes', async () => {
      // 1. users
      const rUsersGet = await request(app).get('/api/users').set('Authorization', `Bearer ${legacyUserToken}`);
      expect(rUsersGet.status).toBe(403);
      const rUsersPost = await request(app).post('/api/users').set('Authorization', `Bearer ${legacyUserToken}`).send({ email: 'new@x.com' });
      expect(rUsersPost.status).toBe(403);

      // 2. catalog admin
      const rCat = await request(app).post('/api/v1/catalog/admin/categories').set('Authorization', `Bearer ${legacyUserToken}`).send({ name: 'Cat', slug: 'cat' });
      expect(rCat.status).toBe(403);

      // 3. pricing admin
      const rPrice = await request(app).post('/api/v1/pricing/admin/prices').set('Authorization', `Bearer ${legacyUserToken}`).send({ serviceId: '507f1f77bcf86cd799439011', vehicleCategory: 'sedan', price: 10000 });
      expect(rPrice.status).toBe(403);

      // 4. coupons writes
      const rCouponPost = await request(app).post('/api/coupons').set('Authorization', `Bearer ${legacyUserToken}`).send({ code: 'DISC' });
      expect(rCouponPost.status).toBe(403);
      const rCouponPut = await request(app).put('/api/coupons/507f1f77bcf86cd799439011').set('Authorization', `Bearer ${legacyUserToken}`).send({ code: 'DISC' });
      expect(rCouponPut.status).toBe(403);
      const rCouponDel = await request(app).delete('/api/coupons/507f1f77bcf86cd799439011').set('Authorization', `Bearer ${legacyUserToken}`);
      expect(rCouponDel.status).toBe(403);

      // 5. blogs writes
      const rBlogPost = await request(app).post('/api/blogs').set('Authorization', `Bearer ${legacyUserToken}`).send({ title: 'Blog' });
      expect(rBlogPost.status).toBe(403);
      const rBlogPut = await request(app).put('/api/blogs/507f1f77bcf86cd799439011').set('Authorization', `Bearer ${legacyUserToken}`).send({ title: 'Blog' });
      expect(rBlogPut.status).toBe(403);
      const rBlogDel = await request(app).delete('/api/blogs/507f1f77bcf86cd799439011').set('Authorization', `Bearer ${legacyUserToken}`);
      expect(rBlogDel.status).toBe(403);

      // 6. upload
      const rUpload = await request(app).post('/api/upload').set('Authorization', `Bearer ${legacyUserToken}`).send({ image: 'data:image/png;base64,...' });
      expect(rUpload.status).toBe(403);

      // 7. booking-settings PUT
      const rSettings = await request(app).put('/api/v1/admin/booking-settings').set('Authorization', `Bearer ${legacyUserToken}`).send({ slotCapacity: 3 });
      expect(rSettings.status).toBe(403);

      // 8. technician approve/reject/suspend/reinstate
      const rApprove = await request(app).post('/api/v1/technicians/507f1f77bcf86cd799439011/approve').set('Authorization', `Bearer ${legacyUserToken}`);
      expect(rApprove.status).toBe(403);
      const rReject = await request(app).post('/api/v1/technicians/507f1f77bcf86cd799439011/reject').set('Authorization', `Bearer ${legacyUserToken}`).send({ reason: 'no' });
      expect(rReject.status).toBe(403);
      const rSuspend = await request(app).post('/api/v1/technicians/507f1f77bcf86cd799439011/suspend').set('Authorization', `Bearer ${legacyUserToken}`).send({ reason: 'no' });
      expect(rSuspend.status).toBe(403);
      const rReinstate = await request(app).post('/api/v1/technicians/507f1f77bcf86cd799439011/reinstate').set('Authorization', `Bearer ${legacyUserToken}`);
      expect(rReinstate.status).toBe(403);

      // 9. customer suspend
      const rCustSuspend = await request(app).post('/api/v1/admin/customers/507f1f77bcf86cd799439011/suspend').set('Authorization', `Bearer ${legacyUserToken}`).send({ reason: 'no' });
      expect(rCustSuspend.status).toBe(403);

      // 10. DELETE booking
      const rDelBooking = await request(app).delete('/api/appointments/507f1f77bcf86cd799439011').set('Authorization', `Bearer ${legacyUserToken}`);
      expect(rDelBooking.status).toBe(403);

      // 11. Technician document URL (Admin only, legacy user gets 403)
      const rDocUrl = await request(app)
        .get('/api/v1/technicians/507f1f77bcf86cd799439011/documents/507f1f77bcf86cd799439022/url')
        .set('Authorization', `Bearer ${legacyUserToken}`);
      expect(rDocUrl.status).toBe(403);
    });
  });
});
