import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app';
import { User } from '../models/User';
import { RefreshToken } from '../models/RefreshToken';
import { Booking } from '../models/Booking';
import * as pricingModule from '../modules/bookings/pricing';
import * as authServiceModule from '../modules/auth/service';
import crypto from 'crypto';

// Mock DB connection & external services
vi.mock('../config/database', () => ({
  connectDB: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'test-email-id' }),
  getWelcomeEmail: vi.fn().mockReturnValue('<p>Welcome</p>'),
  getEmailVerificationEmail: vi.fn().mockReturnValue('<p>Verify</p>'),
  getBookingConfirmationEmail: vi.fn().mockReturnValue('<p>Booking</p>'),
}));

vi.mock('../utils/cloudinary', () => ({
  uploadToCloudinary: vi.fn().mockResolvedValue('https://res.cloudinary.com/test/image.jpg'),
  default: { config: vi.fn(), uploader: { upload: vi.fn() } },
}));

describe('Backend Additions: Web Auth, Quote & Guest Booking Access', () => {
  const serviceId = new mongoose.Types.ObjectId().toString();
  const categoryId = new mongoose.Types.ObjectId().toString();
  const addon1Id = new mongoose.Types.ObjectId().toString();
  const addon2Id = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. POST /api/v1/bookings/quote
  // -------------------------------------------------------------------------
  describe('POST /api/v1/bookings/quote', () => {
    it('calculates full server pricing snapshot in cents plus display fields without creating a booking', async () => {
      vi.spyOn(pricingModule, 'calculateBookingPricing').mockResolvedValue({
        pricing: {
          baseCents: 15000,
          addonsCents: 8000,
          discountCents: 2300,
          couponCode: 'SAVE10',
          couponPercent: 10,
          taxCents: 0,
          totalCents: 20700,
          commissionPercent: 15,
          processingPercent: 3,
          commissionCents: 3105,
          processingCents: 621,
          providerPayoutCents: 16974,
        },
        service: {
          _id: new mongoose.Types.ObjectId(serviceId),
          categoryId: new mongoose.Types.ObjectId(categoryId),
          name: 'Full Detail Package',
          slug: 'full-detail',
          durationMinutes: 120,
        },
        category: {
          _id: new mongoose.Types.ObjectId(categoryId),
          name: 'Mobile Detailing',
          slug: 'mobile-detailing',
        },
        vehicleCategory: 'sedan',
        addons: [
          { addonId: new mongoose.Types.ObjectId(addon1Id), name: 'Pet Hair Removal', priceCents: 3000 },
          { addonId: new mongoose.Types.ObjectId(addon2Id), name: 'Ceramic Coating Spray', priceCents: 5000 },
        ],
      });

      const res = await request(app)
        .post('/api/v1/bookings/quote')
        .send({
          serviceId,
          vehicleCategory: 'sedan',
          addonIds: [addon1Id, addon2Id],
          couponCode: 'SAVE10',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();

      const { pricing, service, category, vehicleCategory, addons, display } = res.body.data;

      // Base: 15000, Addons: 8000. Discount 10%: 2300. Total: 20700
      expect(pricing.baseCents).toBe(15000);
      expect(pricing.addonsCents).toBe(8000);
      expect(pricing.discountCents).toBe(2300);
      expect(pricing.couponCode).toBe('SAVE10');
      expect(pricing.couponPercent).toBe(10);
      expect(pricing.totalCents).toBe(20700);

      // Display formatted fields
      expect(display.basePrice).toBe('150.00');
      expect(display.addonsPrice).toBe('80.00');
      expect(display.discount).toBe('23.00');
      expect(display.total).toBe('207.00');
      expect(display.currency).toBe('USD');

      // Metadata
      expect(service.name).toBe('Full Detail Package');
      expect(category.name).toBe('Mobile Detailing');
      expect(vehicleCategory).toBe('sedan');
      expect(addons).toHaveLength(2);
    });

    it('rejects invalid or inactive service with 400', async () => {
      const err = new Error("Service 'unknown-service' is unavailable or inactive") as any;
      err.statusCode = 400;
      err.code = 'SERVICE_UNAVAILABLE';
      vi.spyOn(pricingModule, 'calculateBookingPricing').mockRejectedValue(err);

      const res = await request(app)
        .post('/api/v1/bookings/quote')
        .send({
          serviceId: 'unknown-service',
          vehicleCategory: 'sedan',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('rejects missing vehicle category pricing with 400', async () => {
      const err = new Error("Pricing for service not found") as any;
      err.statusCode = 400;
      err.code = 'PRICE_NOT_FOUND';
      vi.spyOn(pricingModule, 'calculateBookingPricing').mockRejectedValue(err);

      const res = await request(app)
        .post('/api/v1/bookings/quote')
        .send({
          serviceId,
          vehicleCategory: 'truck',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRICE_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // 2. GET /api/v1/bookings/guest/:id
  // -------------------------------------------------------------------------
  describe('GET /api/v1/bookings/guest/:id', () => {
    it('returns booking with token and sanitizes internal fields for guests', async () => {
      const rawToken = 'guest_secret_access_token_12345';
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const bookingId = new mongoose.Types.ObjectId().toString();

      const fakeBooking = {
        _id: bookingId,
        bookingNumber: 'GIS-GUEST-01',
        guest: { fullName: 'Guest Person', email: 'guest@test.com', phone: '555-1234' },
        guestAccessTokenHash: tokenHash,
        vehicleSnapshot: { category: 'sedan', make: 'Honda', model: 'Civic', year: 2022 },
        serviceSnapshot: { name: 'Full Detail Package', slug: 'full-detail', categoryId },
        address: { freeText: '100 Guest Way' },
        scheduledAt: new Date(Date.now() + 86400000 * 2),
        scheduledLocal: { date: '2026-10-20', slot: '10:00' },
        pricing: {
          baseCents: 15000,
          addonsCents: 0,
          discountCents: 0,
          taxCents: 0,
          totalCents: 15000,
          commissionPercent: 15,
          processingPercent: 3,
          commissionCents: 2250,
          processingCents: 450,
          providerPayoutCents: 12300,
        },
        status: 'pending',
        statusHistory: [{ status: 'pending', by: 'guest@test.com', at: new Date() }],
        source: 'web',
        toObject: function () {
          return { ...this };
        },
      };

      vi.spyOn(Booking, 'findOne').mockResolvedValue(fakeBooking as any);

      // 1. Calling without token returns 403
      const unauthRes = await request(app).get(`/api/v1/bookings/guest/${bookingId}`);
      expect(unauthRes.status).toBe(403);

      // 2. Calling with correct X-Booking-Token header returns 200 with sanitized data
      const res = await request(app)
        .get(`/api/v1/bookings/guest/${bookingId}`)
        .set('X-Booking-Token', rawToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const returnedBooking = res.body.data;
      expect(returnedBooking.bookingNumber).toBe('GIS-GUEST-01');
      expect(returnedBooking.guest.fullName).toBe('Guest Person');

      // Internal fields MUST NOT be exposed to guests
      expect(returnedBooking.guestAccessTokenHash).toBeUndefined();
      expect(returnedBooking.deletedAt).toBeUndefined();
      expect(returnedBooking.pricing.baseCents).toBe(15000);
      expect(returnedBooking.pricing.totalCents).toBe(15000);
      expect(returnedBooking.pricing.commissionPercent).toBeUndefined();
      expect(returnedBooking.pricing.commissionCents).toBeUndefined();
      expect(returnedBooking.pricing.processingPercent).toBeUndefined();
      expect(returnedBooking.pricing.processingCents).toBeUndefined();
      expect(returnedBooking.pricing.providerPayoutCents).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Web Auth: httpOnly refresh cookie, CSRF & Mobile Backwards Compatibility
  // -------------------------------------------------------------------------
  describe('Web Auth: httpOnly cookie vs mobile mode', () => {
    const webOrigin = 'https://globalintegratedsupport.com';

    it('in mobile mode (no X-Client header), returns refreshToken in JSON body and sets no cookie', async () => {
      vi.spyOn(authServiceModule.AuthService, 'register').mockResolvedValue({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        expiresIn: 900,
        tokenType: 'Bearer',
        user: {
          id: '507f1f77bcf86cd799439001',
          email: 'mobileuser@example.com',
          fullName: 'Mobile User',
          role: 'customer',
          status: 'active',
          emailVerified: false,
        },
      });

      const regRes = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'mobileuser@example.com',
          password: 'Password123',
          fullName: 'Mobile User',
        });

      expect(regRes.status).toBe(201);
      expect(regRes.body.data.refreshToken).toBe('refresh-token-456');
      expect(regRes.headers['set-cookie']).toBeUndefined();

      // Mobile login
      vi.spyOn(authServiceModule.AuthService, 'login').mockResolvedValue({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        expiresIn: 900,
        tokenType: 'Bearer',
        user: {
          id: '507f1f77bcf86cd799439001',
          email: 'mobileuser@example.com',
          fullName: 'Mobile User',
          role: 'customer',
          status: 'active',
          emailVerified: false,
        },
      });

      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'mobileuser@example.com',
          password: 'Password123',
        });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.data.refreshToken).toBe('refresh-token-456');
      expect(loginRes.headers['set-cookie']).toBeUndefined();
    });

    it('in web mode (X-Client: web), sets httpOnly Secure cookie and omits refreshToken from body on register and login', async () => {
      vi.spyOn(authServiceModule.AuthService, 'register').mockResolvedValue({
        accessToken: 'access-token-web-1',
        refreshToken: 'refresh-token-web-1',
        expiresIn: 900,
        tokenType: 'Bearer',
        user: {
          id: '507f1f77bcf86cd799439001',
          email: 'webuser@example.com',
          fullName: 'Web User',
          role: 'customer',
          status: 'active',
          emailVerified: false,
        },
      });

      const regRes = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Client', 'web')
        .set('Origin', webOrigin)
        .send({
          email: 'webuser@example.com',
          password: 'Password123',
          fullName: 'Web User',
        });

      expect(regRes.status).toBe(201);
      expect(regRes.body.data.accessToken).toBe('access-token-web-1');
      expect(regRes.body.data.refreshToken).toBeUndefined();

      const regSetCookie = regRes.headers['set-cookie'];
      expect(regSetCookie).toBeDefined();
      const cookieStr = Array.isArray(regSetCookie) ? regSetCookie.join('; ') : regSetCookie;
      expect(cookieStr).toContain('refreshToken=refresh-token-web-1');
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('SameSite=Lax');
      expect(cookieStr).toContain('Path=/api/v1/auth');

      // Login
      vi.spyOn(authServiceModule.AuthService, 'login').mockResolvedValue({
        accessToken: 'access-token-web-2',
        refreshToken: 'refresh-token-web-2',
        expiresIn: 900,
        tokenType: 'Bearer',
        user: {
          id: '507f1f77bcf86cd799439001',
          email: 'webuser@example.com',
          fullName: 'Web User',
          role: 'customer',
          status: 'active',
          emailVerified: false,
        },
      });

      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Client', 'web')
        .set('Origin', webOrigin)
        .send({
          email: 'webuser@example.com',
          password: 'Password123',
        });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.data.accessToken).toBe('access-token-web-2');
      expect(loginRes.body.data.refreshToken).toBeUndefined();

      const loginSetCookie = loginRes.headers['set-cookie'];
      expect(loginSetCookie).toBeDefined();
      const loginCookieStr = Array.isArray(loginSetCookie) ? loginSetCookie.join('; ') : loginSetCookie;
      expect(loginCookieStr).toContain('refreshToken=refresh-token-web-2');
      expect(loginCookieStr).toContain('HttpOnly');
    });

    it('in web mode, /refresh reads from cookie, rotates cookie, and returns no refreshToken in body', async () => {
      const initialCookieToken = 'initial-cookie-refresh-token';
      const rotatedCookieToken = 'rotated-cookie-refresh-token';

      vi.spyOn(authServiceModule.AuthService, 'refresh').mockResolvedValue({
        accessToken: 'new-access-token-rot',
        refreshToken: rotatedCookieToken,
        expiresIn: 900,
        tokenType: 'Bearer',
        user: {
          id: '507f1f77bcf86cd799439001',
          email: 'webuser@example.com',
          fullName: 'Web User',
          role: 'customer',
          status: 'active',
          emailVerified: true,
        },
      });

      const refreshRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Client', 'web')
        .set('Origin', webOrigin)
        .set('Cookie', `refreshToken=${initialCookieToken}`)
        .send({});

      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.data.accessToken).toBe('new-access-token-rot');
      expect(refreshRes.body.data.refreshToken).toBeUndefined();

      // Rotated cookie set
      const newSetCookie = refreshRes.headers['set-cookie'];
      expect(newSetCookie).toBeDefined();
      const newCookieStr = Array.isArray(newSetCookie) ? newSetCookie.join('; ') : newSetCookie;
      expect(newCookieStr).toContain(`refreshToken=${rotatedCookieToken}`);
      expect(newCookieStr).toContain('HttpOnly');
    });

    it('rejects /refresh and /logout with 403 when X-Client: web is provided without matching Origin (CSRF protection)', async () => {
      // 1. Missing Origin
      const noOriginRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Client', 'web')
        .set('Cookie', 'refreshToken=fake_token')
        .send({});

      expect(noOriginRes.status).toBe(403);
      expect(noOriginRes.body.error.code).toBe('CSRF_FORBIDDEN');

      // 2. Unauthorized Origin (attacker.com)
      const badOriginRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('X-Client', 'web')
        .set('Origin', 'https://malicious-site.com')
        .set('Cookie', 'refreshToken=fake_token')
        .send({});

      expect(badOriginRes.status).toBe(403);
      expect(['CSRF_FORBIDDEN', 'CORS_FORBIDDEN']).toContain(badOriginRes.body.error?.code);

      // 3. Missing Origin on /logout in cookie mode
      const noOriginLogoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('X-Client', 'web')
        .set('Cookie', 'refreshToken=fake_token')
        .send({});

      expect(noOriginLogoutRes.status).toBe(403);
      expect(noOriginLogoutRes.body.error.code).toBe('CSRF_FORBIDDEN');

      // 4. Unauthorized Origin on /logout in cookie mode
      const badOriginLogoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('X-Client', 'web')
        .set('Origin', 'https://malicious-site.com')
        .set('Cookie', 'refreshToken=fake_token')
        .send({});

      expect(badOriginLogoutRes.status).toBe(403);
      expect(['CSRF_FORBIDDEN', 'CORS_FORBIDDEN']).toContain(badOriginLogoutRes.body.error?.code);
    });

    it('in web mode, /logout revokes the token and clears the cookie', async () => {
      const logoutSpy = vi.spyOn(authServiceModule.AuthService, 'logout').mockResolvedValue(undefined);

      // Generating valid customer token for Authorization header
      const { generateAccessToken } = await import('../utils/jwt');
      const testToken = generateAccessToken({
        userId: '507f1f77bcf86cd799439001',
        email: 'webuser@example.com',
        role: 'customer',
        status: 'active',
        emailVerified: true,
      });

      const logoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${testToken}`)
        .set('X-Client', 'web')
        .set('Origin', webOrigin)
        .set('Cookie', 'refreshToken=my-cookie-refresh-token')
        .send({});

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.message).toBe('Logged out successfully');

      // AuthService.logout called with the cookie token
      expect(logoutSpy).toHaveBeenCalledWith('my-cookie-refresh-token', '507f1f77bcf86cd799439001', undefined);

      // Cookie should be cleared
      const clearSetCookie = logoutRes.headers['set-cookie'];
      expect(clearSetCookie).toBeDefined();
      const clearStr = Array.isArray(clearSetCookie) ? clearSetCookie.join('; ') : clearSetCookie;
      expect(clearStr).toMatch(/Expires=|Max-Age=0/i);
    });
  });
});
