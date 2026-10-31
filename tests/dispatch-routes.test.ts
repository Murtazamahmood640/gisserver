/**
 * dispatch-routes.test.ts
 *
 * Tests auth on every dispatch endpoint, force-assign restrictions,
 * and dispatch settings.
 * Uses real MongoDB via MongoMemoryServer + supertest.
 *
 * PART 8d
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'mock' }),
  getTechnicianNewOfferEmail: vi.fn().mockReturnValue('<p></p>'),
  getCustomerTechnicianAssignedEmail: vi.fn().mockReturnValue('<p></p>'),
  getAdminDispatchExhaustedEmail: vi.fn().mockReturnValue('<p></p>'),
  getCustomerTechnicianEnRouteEmail: vi.fn().mockReturnValue('<p></p>'),
  getCustomerTechnicianArrivedEmail: vi.fn().mockReturnValue('<p></p>'),
  getCustomerJobCompletedEmail: vi.fn().mockReturnValue('<p></p>'),
}));
vi.mock('../services/pushService', () => ({ pushService: { sendToUser: vi.fn() } }));
vi.mock('../realtime/emitter', () => ({
  realtimeEmitter: {
    emitBookingStatus: vi.fn(), emitBookingAssigned: vi.fn(), emitOfferNew: vi.fn(),
    emitOfferExpired: vi.fn(), emitDispatchBoardUpdate: vi.fn(),
    emitTechnicianLocation: vi.fn(), emitTrackingEta: vi.fn(),
  },
}));

import app from '../app';
import { User } from '../models/User';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { Booking } from '../models/Booking';
import { DispatchOffer } from '../models/DispatchOffer';
import { DispatchSettings } from '../models/DispatchSettings';
import { generateAccessToken } from '../utils/jwt';

let mongoServer: MongoMemoryServer;

async function createUser(role: string, suffix: string) {
  const user = await User.create({
    email: `dr-${role}-${suffix}@test.com`,
    password: 'P@ssword1!',
    fullName: `${role} ${suffix}`,
    role,
    status: 'active',
    emailVerified: true,
  });
  const token = generateAccessToken({ userId: user._id.toString(), email: user.email, role: role as 'admin' | 'dispatcher' | 'technician' | 'customer', status: "active", emailVerified: true });
  return { user, token };
}

async function createApprovedTech(suffix: string) {
  const { user, token } = await createUser('technician', suffix);
  await TechnicianProfile.create({
    userId: user._id,
    displayName: `Tech ${suffix}`,
    verificationStatus: 'approved',
    availability: { isOnline: true, weeklySchedule: [] },
    skills: { serviceIds: [], categoryIds: [] },
    serviceArea: { zipCodes: [] },
  });
  return { user, token };
}

async function createConfirmedBooking() {
  return Booking.create({
    bookingNumber: `GIS-DR-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
    serviceId: new mongoose.Types.ObjectId(),
    categoryId: new mongoose.Types.ObjectId(),
    guest: { fullName: 'Test Customer', email: 'dr-cust@test.com', phone: '555-5555' },
    serviceSnapshot: { name: 'Test Service', slug: 'test-service' },
    vehicleSnapshot: { category: 'sedan', make: 'T', model: 'C', year: 2022 },
    scheduledAt: new Date(Date.now() + 86_400_000),
    scheduledLocal: { date: '2026-11-10', slot: '10:00' },
    pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
    address: { freeText: '123 Main St', zip: '90210', country: 'USA' },
    status: 'confirmed',
    source: 'web',
  });
}

describe('Dispatch Routes: Auth Matrix & Restrictions (real MongoDB)', () => {
  let adminToken: string;
  let dispatcherToken: string;
  let techToken: string;
  let customerToken: string;
  let techUser: Awaited<ReturnType<typeof createUser>>['user'];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.disconnect();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await TechnicianProfile.deleteMany({});
    await Booking.deleteMany({});
    await DispatchOffer.deleteMany({});
    await DispatchSettings.deleteMany({});
    await DispatchSettings.create({});

    const admin = await createUser('admin', 'a');
    adminToken = admin.token;
    const dispatcher = await createUser('dispatcher', 'b');
    dispatcherToken = dispatcher.token;
    const customer = await createUser('customer', 'c');
    customerToken = customer.token;
    const tech = await createApprovedTech('d');
    techToken = tech.token;
    techUser = tech.user;
  });

  // ── GET /api/v1/dispatch/board ───────────────────────────────────────────

  describe('GET /api/v1/dispatch/board', () => {
    it('admin → 200 with required board shape and NO technician coordinates', async () => {
      const res = await request(app).get('/api/v1/dispatch/board').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.unassigned)).toBe(true);
      expect(Array.isArray(res.body.data.offered)).toBe(true);
      expect(Array.isArray(res.body.data.active)).toBe(true);
      expect(Array.isArray(res.body.data.onlineTechnicians)).toBe(true);

      function hasFieldDeep(obj: unknown, key: string): boolean {
        if (!obj || typeof obj !== 'object') return false;
        if (Array.isArray(obj)) return obj.some((item) => hasFieldDeep(item, key));
        for (const [k, v] of Object.entries(obj)) {
          if (k === key) return true;
          if (hasFieldDeep(v, key)) return true;
        }
        return false;
      }

      expect(hasFieldDeep(res.body.data, 'coordinates')).toBe(false);
      expect(JSON.stringify(res.body.data)).not.toContain('"coordinates"');
      expect(JSON.stringify(res.body.data.onlineTechnicians)).not.toContain('"lat"');
      expect(JSON.stringify(res.body.data.onlineTechnicians)).not.toContain('"lng"');
    });

    it('dispatcher → 200', async () => {
      const res = await request(app).get('/api/v1/dispatch/board').set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res.status).toBe(200);
    });

    it('technician → 403', async () => {
      const res = await request(app).get('/api/v1/dispatch/board').set('Authorization', `Bearer ${techToken}`);
      expect(res.status).toBe(403);
    });

    it('customer → 403', async () => {
      const res = await request(app).get('/api/v1/dispatch/board').set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
    });

    it('no token → 401', async () => {
      const res = await request(app).get('/api/v1/dispatch/board');
      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/v1/dispatch/bookings/:id/candidates ─────────────────────────

  describe('GET /api/v1/dispatch/bookings/:id/candidates', () => {
    it('admin → 200 with eligibility data', async () => {
      const booking = await createConfirmedBooking();
      const res = await request(app)
        .get(`/api/v1/dispatch/bookings/${booking._id}/candidates`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('dispatcher → 200 with explain=true returning eligibility details and exclusion reasons', async () => {
      const booking = await createConfirmedBooking();
      const suspendedUser = await User.create({
        email: 'ineligible-tech@test.com',
        password: 'P@ssword1!',
        fullName: 'Suspended Tech',
        role: 'technician',
        status: 'suspended',
        emailVerified: true,
      });
      await TechnicianProfile.create({
        userId: suspendedUser._id,
        displayName: 'Suspended Tech',
        verificationStatus: 'approved',
        availability: { isOnline: true, weeklySchedule: [] },
        skills: { serviceIds: [], categoryIds: [] },
        serviceArea: { zipCodes: [] },
      });

      const res = await request(app)
        .get(`/api/v1/dispatch/bookings/${booking._id}/candidates?explain=true`)
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const ineligibleCandidate = res.body.data.find(
        (c: { technicianUserId: string }) => c.technicianUserId === suspendedUser._id.toString()
      );
      expect(ineligibleCandidate).toBeDefined();
      expect(ineligibleCandidate?.eligible).toBe(false);
      expect(ineligibleCandidate).toHaveProperty('exclusionReason');
      expect(typeof ineligibleCandidate?.exclusionReason).toBe('string');
    });

    it('technician → 403', async () => {
      const booking = await createConfirmedBooking();
      const res = await request(app)
        .get(`/api/v1/dispatch/bookings/${booking._id}/candidates`)
        .set('Authorization', `Bearer ${techToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ── POST /api/v1/dispatch/bookings/:id/assign ─────────────────────────────

  describe('POST /api/v1/dispatch/bookings/:id/assign', () => {
    it('admin with force=true → 200', async () => {
      const booking = await createConfirmedBooking();
      const res = await request(app)
        .post(`/api/v1/dispatch/bookings/${booking._id}/assign`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ technicianUserId: techUser._id.toString(), force: true });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('assigned');
    });

    it('dispatcher with force=true → 403 FORBIDDEN', async () => {
      const booking = await createConfirmedBooking();
      const res = await request(app)
        .post(`/api/v1/dispatch/bookings/${booking._id}/assign`)
        .set('Authorization', `Bearer ${dispatcherToken}`)
        .send({ technicianUserId: techUser._id.toString(), force: true });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('technician → 403', async () => {
      const booking = await createConfirmedBooking();
      const res = await request(app)
        .post(`/api/v1/dispatch/bookings/${booking._id}/assign`)
        .set('Authorization', `Bearer ${techToken}`)
        .send({ technicianUserId: techUser._id.toString(), force: true });
      expect(res.status).toBe(403);
    });

    it('customer → 403', async () => {
      const booking = await createConfirmedBooking();
      const res = await request(app)
        .post(`/api/v1/dispatch/bookings/${booking._id}/assign`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ technicianUserId: techUser._id.toString(), force: true });
      expect(res.status).toBe(403);
    });
  });

  // ── POST /api/v1/dispatch/bookings/:id/unassign ──────────────────────────

  describe('POST /api/v1/dispatch/bookings/:id/unassign', () => {
    it('admin → 200, booking reverts to confirmed', async () => {
      const techObjId = new mongoose.Types.ObjectId(techUser._id.toString());
      const booking = await Booking.create({
        bookingNumber: `GIS-UA-${Date.now()}`,
        serviceId: new mongoose.Types.ObjectId(),
        categoryId: new mongoose.Types.ObjectId(),
        guest: { fullName: 'Cust', email: 'ua@test.com', phone: '555-0001' },
        serviceSnapshot: { name: 'S', slug: 's' },
        vehicleSnapshot: { category: 'sedan', make: 'T', model: 'C', year: 2022 },
        scheduledAt: new Date(Date.now() + 86_400_000),
        scheduledLocal: { date: '2026-11-10', slot: '10:00' },
        pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
        address: { freeText: '123 Main', zip: '90210', country: 'USA' },
        status: 'assigned',
        source: 'web',
        technicianId: techObjId,
        assignment: { technicianUserId: techObjId, assignedAt: new Date(), assignedBy: 'admin' },
      });
      const res = await request(app)
        .post(`/api/v1/dispatch/bookings/${booking._id}/unassign`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('confirmed');
    });

    it('technician → 403', async () => {
      const booking = await createConfirmedBooking();
      const res = await request(app)
        .post(`/api/v1/dispatch/bookings/${booking._id}/unassign`)
        .set('Authorization', `Bearer ${techToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ── GET /api/v1/admin/dispatch-settings ──────────────────────────────────

  describe('GET /api/v1/admin/dispatch-settings', () => {
    it('admin → 200 with settings', async () => {
      const res = await request(app)
        .get('/api/v1/admin/dispatch-settings')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('autoDispatch');
    });

    it('dispatcher → 200', async () => {
      const res = await request(app)
        .get('/api/v1/admin/dispatch-settings')
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res.status).toBe(200);
    });

    it('technician → 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/dispatch-settings')
        .set('Authorization', `Bearer ${techToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ── PUT /api/v1/admin/dispatch-settings ──────────────────────────────────

  describe('PUT /api/v1/admin/dispatch-settings', () => {
    it('admin → 200, settings updated', async () => {
      const res = await request(app)
        .put('/api/v1/admin/dispatch-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ autoDispatch: true, offerTimeoutSecondsAsap: 90 });
      expect(res.status).toBe(200);
      expect(res.body.data.autoDispatch).toBe(true);
      expect(res.body.data.offerTimeoutSecondsAsap).toBe(90);
    });

    it('dispatcher → 403 (admin-only write)', async () => {
      const res = await request(app)
        .put('/api/v1/admin/dispatch-settings')
        .set('Authorization', `Bearer ${dispatcherToken}`)
        .send({ autoDispatch: true });
      expect(res.status).toBe(403);
    });

    it('technician → 403', async () => {
      const res = await request(app)
        .put('/api/v1/admin/dispatch-settings')
        .set('Authorization', `Bearer ${techToken}`)
        .send({ autoDispatch: true });
      expect(res.status).toBe(403);
    });
  });

  // ── GET /api/v1/dispatch/bookings/:id/offers ─────────────────────────────

  describe('GET /api/v1/dispatch/bookings/:id/offers', () => {
    it('admin and dispatcher can access (200), customer gets 403', async () => {
      const booking = await createConfirmedBooking();
      await DispatchOffer.create({
        bookingId: booking._id,
        technicianUserId: techUser._id,
        status: 'sent',
        sentAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
        rank: 1,
        source: 'manual',
      });

      const adminRes = await request(app)
        .get(`/api/v1/dispatch/bookings/${booking._id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(200);
      expect(Array.isArray(adminRes.body.data)).toBe(true);
      expect(adminRes.body.data.length).toBe(1);

      const dispatcherRes = await request(app)
        .get(`/api/v1/dispatch/bookings/${booking._id}/offers`)
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(dispatcherRes.status).toBe(200);
      expect(Array.isArray(dispatcherRes.body.data)).toBe(true);

      const customerRes = await request(app)
        .get(`/api/v1/dispatch/bookings/${booking._id}/offers`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(customerRes.status).toBe(403);
    });
  });

  // ── GET /api/v1/admin/counts ─────────────────────────────────────────────

  describe('GET /api/v1/admin/counts', () => {
    it('includes unassignedBookings: confirmed bookings without tech, excluding deleted or assigned', async () => {
      // 1. Unassigned confirmed booking (should be counted)
      await createConfirmedBooking();

      // 2. Assigned confirmed booking (should NOT be counted)
      const assignedBooking = await createConfirmedBooking();
      assignedBooking.status = 'assigned';
      assignedBooking.technicianId = new mongoose.Types.ObjectId();
      assignedBooking.assignment = {
        technicianUserId: assignedBooking.technicianId,
        assignedAt: new Date(),
        assignedBy: 'admin',
      };
      await assignedBooking.save();

      // 3. Soft-deleted confirmed booking (should NOT be counted)
      const deletedBooking = await createConfirmedBooking();
      deletedBooking.isDeleted = true;
      deletedBooking.deletedAt = new Date();
      await deletedBooking.save();

      // 4. Pending booking (should NOT be counted)
      const pendingBooking = await createConfirmedBooking();
      pendingBooking.status = 'pending';
      await pendingBooking.save();

      const res = await request(app)
        .get('/api/v1/admin/counts')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('unassignedBookings');
      expect(res.body.data.unassignedBookings).toBe(1);
    });
  });
});
