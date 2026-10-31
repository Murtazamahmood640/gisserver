/**
 * tracking-routes.test.ts
 *
 * Tests location update throttling, bounds validation, tracking auth, ETA stub.
 * Uses real MongoDB via MongoMemoryServer + supertest.
 *
 * PART 8e
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
// Mock ETA service to avoid external calls
vi.mock('../modules/tracking/etaService', () => ({
  EtaService: {
    calculateEta: vi.fn().mockResolvedValue({
      etaMinutes: 15,
      distanceKm: 5.2,
      etaSource: 'estimate',
    }),
  },
}));

import app from '../app';
import { User } from '../models/User';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { TechnicianLocation } from '../models/TechnicianLocation';
import { LocationPing } from '../models/LocationPing';
import { Booking } from '../models/Booking';
import { DispatchSettings } from '../models/DispatchSettings';
import { generateAccessToken } from '../utils/jwt';
import logger from '../config/logger';

// Patch in-memory throttle map between tests
import * as TrackingServiceModule from '../modules/tracking/service';
import { TrackingService } from '../modules/tracking/service';

let mongoServer: MongoMemoryServer;

async function createTechUser(suffix: string, approved = true) {
  const user = await User.create({
    email: `track-tech-${suffix}@test.com`,
    password: 'P@ssword1!',
    fullName: `Track Tech ${suffix}`,
    role: 'technician',
    status: 'active',
    emailVerified: true,
  });
  if (approved) {
    await TechnicianProfile.create({
      userId: user._id,
      displayName: `Track Tech ${suffix}`,
      verificationStatus: 'approved',
      availability: { isOnline: true, weeklySchedule: [] },
      skills: { serviceIds: [], categoryIds: [] },
      serviceArea: { zipCodes: [] },
    });
  }
  const token = generateAccessToken({
    userId: user._id.toString(),
    email: user.email,
    role: 'technician', status: 'active', emailVerified: true });
  return { user, token };
}

async function createAdminUser(suffix: string) {
  const user = await User.create({
    email: `track-admin-${suffix}@test.com`,
    password: 'P@ssword1!',
    fullName: `Track Admin ${suffix}`,
    role: 'admin',
    status: 'active',
    emailVerified: true,
  });
  return generateAccessToken({ userId: user._id.toString(), email: user.email, role: 'admin', status: 'active', emailVerified: true });
}

async function createBookingWithTech(techUserId: mongoose.Types.ObjectId, status: string) {
  const techObjId = new mongoose.Types.ObjectId(techUserId.toString());
  return Booking.create({
    bookingNumber: `GIS-TRK-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
    serviceId: new mongoose.Types.ObjectId(),
    categoryId: new mongoose.Types.ObjectId(),
    guest: { fullName: 'Track Cust', email: 'trk@test.com', phone: '555-7777' },
    serviceSnapshot: { name: 'Track Test', slug: 'track-test' },
    vehicleSnapshot: { category: 'sedan', make: 'T', model: 'C', year: 2022 },
    scheduledAt: new Date(Date.now() + 60_000),
    scheduledLocal: { date: '2026-11-10', slot: '10:00' },
    pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
    address: { freeText: '123 Main', zip: '90210', country: 'USA' },
    location: { type: 'Point', coordinates: [-118.2437, 34.0522] },
    status,
    source: 'web',
    technicianId: techObjId,
    assignment: { technicianUserId: techObjId, assignedAt: new Date(), assignedBy: 'admin' },
    dispatch: { status: 'assigned', attempts: 1 },
  });
}

describe('Tracking Routes: Throttling, Auth & ETA (real MongoDB)', () => {
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
    await TechnicianLocation.deleteMany({});
    await LocationPing.deleteMany({});
    await Booking.deleteMany({});
    await DispatchSettings.deleteMany({});
    // Create fresh settings with short interval for testing
    await DispatchSettings.create({ locationMinIntervalSeconds: 5 });
    // Reset in-memory throttle map between tests
    (TrackingServiceModule as { lastUpdateMap?: Map<string, number> }).lastUpdateMap?.clear?.();
  });

  // ── POST /api/v1/tracking/me/location ───────────────────────────────────

  it('no token → 401', async () => {
    const res = await request(app)
      .post('/api/v1/tracking/me/location')
      .send({ lat: 34.05, lng: -118.24 });
    expect(res.status).toBe(401);
  });

  it('non-technician (admin) → 403', async () => {
    const adminToken = await createAdminUser('loc-admin');
    const res = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lat: 34.05, lng: -118.24 });
    expect(res.status).toBe(403);
  });

  it('approved technician can update location → 200 with upserted doc', async () => {
    const { user, token } = await createTechUser('loc-ok');
    const res = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 34.05, lng: -118.24, heading: 180, speed: 30, accuracy: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);

    // Verify persisted in DB
    const loc = await TechnicianLocation.findOne({ technicianUserId: user._id });
    expect(loc).not.toBeNull();
    expect(loc?.location?.coordinates?.[0]).toBeCloseTo(-118.24);
    expect(loc?.location?.coordinates?.[1]).toBeCloseTo(34.05);
  });

  it('location bounds validation: lat > 90 → 400', async () => {
    const { token } = await createTechUser('loc-bounds-lat');
    const res = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 91, lng: -118.24 }); // invalid lat
    expect(res.status).toBe(400);
  });

  it('location bounds validation: lng < -180 → 400', async () => {
    const { token } = await createTechUser('loc-bounds-lng');
    const res = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 34.05, lng: -181 }); // invalid lng
    expect(res.status).toBe(400);
  });

  it('second update within throttle window → 429 with Retry-After header', async () => {
    const { token } = await createTechUser('loc-throttle');

    // First call — succeeds
    const first = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 34.05, lng: -118.24 });
    expect(first.status).toBe(200);

    // Immediate second call — should be throttled
    const second = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 34.06, lng: -118.25 });
    expect(second.status).toBe(429);
    expect(second.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(second.headers['retry-after']).toBeDefined();
  });

  it('location update during active job creates a LocationPing', async () => {
    const { user, token } = await createTechUser('loc-ping');
    await createBookingWithTech(user._id, 'technician_en_route');

    const res = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 34.05, lng: -118.24 });

    expect(res.status).toBe(200);
    expect(res.body.data.activeBookingId).toBeDefined();

    const pingCount = await LocationPing.countDocuments({ technicianUserId: user._id });
    expect(pingCount).toBe(1);
  });

  // ── GET /api/v1/bookings/:id/tracking ────────────────────────────────────

  it('tracking not available when booking status is confirmed (not in allowTrackingStatuses) → 403', async () => {
    const adminToken = await createAdminUser('trk-admin');
    const { user: tech } = await createTechUser('trk-confirmed');
    const booking = await createBookingWithTech(tech._id, 'confirmed');

    // Set location so the tech has one
    await TechnicianLocation.create({
      technicianUserId: tech._id,
      location: { type: 'Point', coordinates: [-118.24, 34.05] },
      updatedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/bookings/${booking._id}/tracking`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('TRACKING_NOT_AVAILABLE');
  });

  it('admin can get tracking when booking is technician_en_route → 200 with location & ETA', async () => {
    const adminToken = await createAdminUser('trk-admin2');
    const { user: tech } = await createTechUser('trk-enroute');
    const booking = await createBookingWithTech(tech._id, 'technician_en_route');

    await TechnicianLocation.create({
      technicianUserId: tech._id,
      location: { type: 'Point', coordinates: [-118.24, 34.05] },
      updatedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/bookings/${booking._id}/tracking`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.location).toBeDefined();
    expect(res.body.data.location.lat).toBeCloseTo(34.05);
    expect(res.body.data.etaMinutes).toBe(15);
  });

  it('other customer → 403 on tracking endpoint', async () => {
    const { user: tech } = await createTechUser('trk-other-cust');
    const booking = await createBookingWithTech(tech._id, 'technician_en_route');

    const otherCustomer = await User.create({
      email: `other-cust-${Date.now()}@test.com`,
      password: 'P@ssword1!',
      fullName: 'Other Customer',
      role: 'customer',
      status: 'active',
      emailVerified: true,
    });
    const customerToken = generateAccessToken({
      userId: otherCustomer._id.toString(),
      email: otherCustomer.email,
      role: 'customer', status: 'active', emailVerified: true });

    const res = await request(app)
      .get(`/api/v1/bookings/${booking._id}/tracking`)
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(403);
  });

  // ── Additional Bounds Validation ─────────────────────────────────────────

  it('location bounds validation: lat < -90 → 400', async () => {
    const { token } = await createTechUser('bounds-lat-min');
    const res = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: -91, lng: -118.24 });
    expect(res.status).toBe(400);
  });

  it('location bounds validation: lng > 180 → 400', async () => {
    const { token } = await createTechUser('bounds-lng-max');
    const res = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 34.05, lng: 181 });
    expect(res.status).toBe(400);
  });

  // ── Pings Stored Only During Active Job ──────────────────────────────────

  it('pings stored ONLY during an active job: idle technician creates 0 LocationPings', async () => {
    const { user, token } = await createTechUser('loc-idle');

    // No active booking
    const res = await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 34.05, lng: -118.24 });

    expect(res.status).toBe(200);
    expect(res.body.data.activeBookingId).toBeUndefined();

    // Verify current location is recorded, but audit ping trail is NOT
    const loc = await TechnicianLocation.findOne({ technicianUserId: user._id });
    expect(loc).not.toBeNull();
    const pings = await LocationPing.find({ technicianUserId: user._id });
    expect(pings).toHaveLength(0);
  });

  // ── Tracking Cleanup Task ────────────────────────────────────────────────

  it('cleanup task: pings deleted and technicianLocations.bookingId cleared 24h after completion or cancellation', async () => {
    const { user: tech } = await createTechUser('cleanup-tech');
    const past25h = new Date(Date.now() - 25 * 60 * 60 * 1000);

    // Completed booking >24h ago
    const completedBooking = await createBookingWithTech(tech._id, 'completed');
    completedBooking.completedAt = past25h;
    completedBooking.updatedAt = past25h;
    await completedBooking.save();

    // Location pings for this completed booking
    await LocationPing.create({
      bookingId: completedBooking._id,
      technicianUserId: tech._id,
      location: { type: 'Point', coordinates: [-118.24, 34.05] },
      at: past25h,
    });

    // Technician location pointing to completedBooking
    await TechnicianLocation.findOneAndUpdate(
      { technicianUserId: tech._id },
      {
        $set: {
          location: { type: 'Point', coordinates: [-118.24, 34.05] },
          bookingId: completedBooking._id,
          updatedAt: past25h,
        },
      },
      { upsert: true }
    );

    // Run cleanup
    const result = await TrackingService.runTrackingCleanup();
    expect(result.deletedPingsCount).toBeGreaterThanOrEqual(1);
    expect(result.clearedLocationsCount).toBeGreaterThanOrEqual(1);

    // Verify pings deleted
    const remainingPings = await LocationPing.find({ bookingId: completedBooking._id });
    expect(remainingPings).toHaveLength(0);

    // Verify technicianLocation.bookingId cleared
    const updatedLoc = await TechnicianLocation.findOne({ technicianUserId: tech._id });
    expect(updatedLoc?.bookingId).toBeNull();
  });

  // ── TTL Index Definitions ────────────────────────────────────────────────

  it('TTL index definitions: TechnicianLocation (24h) and LocationPing (7d)', () => {
    const techLocIndexes = TechnicianLocation.schema.indexes();
    const locPingIndexes = LocationPing.schema.indexes();

    // TechnicianLocation: updatedAt expireAfterSeconds: 86400 (24h)
    const techLocTtl = techLocIndexes.find(
      ([fields, opts]: [Record<string, unknown>, Record<string, unknown>]) =>
        fields.updatedAt === 1 && opts?.expireAfterSeconds === 86400
    );
    expect(techLocTtl).toBeDefined();

    // LocationPing: at expireAfterSeconds: 604800 (7 days)
    const pingTtl = locPingIndexes.find(
      ([fields, opts]: [Record<string, unknown>, Record<string, unknown>]) =>
        fields.at === 1 && opts?.expireAfterSeconds === 604800
    );
    expect(pingTtl).toBeDefined();
  });

  // ── Tracking 403 on Cancelled Status ─────────────────────────────────────

  it('tracking returns 403 when booking status is cancelled', async () => {
    const adminToken = await createAdminUser('trk-cancelled-admin');
    const { user: tech } = await createTechUser('trk-cancelled-tech');
    const booking = await createBookingWithTech(tech._id, 'cancelled');

    const res = await request(app)
      .get(`/api/v1/bookings/${booking._id}/tracking`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('TRACKING_NOT_AVAILABLE');
  });

  // ── Log Spy: No Coordinates in Any Log Line ──────────────────────────────

  it('log spy: no coordinates (lat, lng) appear in any log line during location update', async () => {
    const { token } = await createTechUser('loc-log-spy');

    const loggedLines: string[] = [];
    const safeStringify = (args: unknown[]) => {
      try {
        return args.map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a, Object.keys(a as object).slice(0, 20)) : String(a))).join(' ');
      } catch {
        return String(args[0] || '');
      }
    };
    const spyDebug = vi.spyOn(logger, 'debug').mockImplementation((...args: unknown[]) => {
      loggedLines.push(safeStringify(args));
    });
    const spyInfo = vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
      loggedLines.push(safeStringify(args));
    });
    const spyWarn = vi.spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => {
      loggedLines.push(safeStringify(args));
    });

    const lat = 34.05999;
    const lng = -118.24999;

    await request(app)
      .post('/api/v1/tracking/me/location')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat, lng });

    spyDebug.mockRestore();
    spyInfo.mockRestore();
    spyWarn.mockRestore();

    // Verify coordinate numbers do not appear in any log output
    const allLogs = loggedLines.join(' ');
    expect(allLogs).not.toContain(String(lat));
    expect(allLogs).not.toContain(String(lng));
  });

  // ── Non-tracking Endpoint Does Not Expose Location History ───────────────

  it('dispatch board does not return location history pings', async () => {
    const adminToken = await createAdminUser('board-audit-admin');
    const { user: tech } = await createTechUser('board-audit-tech');
    const booking = await createBookingWithTech(tech._id, 'technician_en_route');

    // Create location pings
    await LocationPing.create({
      bookingId: booking._id,
      technicianUserId: tech._id,
      location: { type: 'Point', coordinates: [-118.24, 34.05] },
      at: new Date(),
    });

    const res = await request(app)
      .get('/api/v1/dispatch/board')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const bodyStr = JSON.stringify(res.body);
    // Board should not contain pings array or audit trails
    expect(bodyStr).not.toContain('"pings"');
  });
});
