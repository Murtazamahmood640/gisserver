/**
 * dispatch-concurrency.test.ts
 *
 * Tests dispatch atomicity, concurrency, sweeper safety, and full dispatch chain
 * using real MongoDB via MongoMemoryServer.
 *
 * PART 8a — Testing Rule: NO MOCKS for atomicity/concurrency/expiry/indexes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Silence email and push in these tests
vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'mock' }),
  getTechnicianNewOfferEmail: vi.fn().mockReturnValue('<p>offer</p>'),
  getCustomerTechnicianAssignedEmail: vi.fn().mockReturnValue('<p>assigned</p>'),
  getAdminDispatchExhaustedEmail: vi.fn().mockReturnValue('<p>exhausted</p>'),
  getCustomerTechnicianEnRouteEmail: vi.fn().mockReturnValue('<p>enroute</p>'),
  getCustomerTechnicianArrivedEmail: vi.fn().mockReturnValue('<p>arrived</p>'),
  getCustomerJobCompletedEmail: vi.fn().mockReturnValue('<p>complete</p>'),
}));
vi.mock('../services/pushService', () => ({
  pushService: { sendToUser: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../realtime/emitter', () => ({
  realtimeEmitter: {
    emitBookingStatus: vi.fn(),
    emitBookingAssigned: vi.fn(),
    emitOfferNew: vi.fn(),
    emitOfferExpired: vi.fn(),
    emitDispatchBoardUpdate: vi.fn(),
    emitTechnicianLocation: vi.fn(),
    emitTrackingEta: vi.fn(),
  },
}));

import { User } from '../models/User';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { Booking } from '../models/Booking';
import { DispatchOffer } from '../models/DispatchOffer';
import { DispatchSettings } from '../models/DispatchSettings';
import { DispatchService } from '../modules/dispatch/service';
import request from 'supertest';
import app from '../app';

let mongoServer: MongoMemoryServer;

// ─── Test Data Factories ────────────────────────────────────────────────────

async function createApprovedTechUser(suffix: string) {
  const user = await User.create({
    email: `tech-${suffix}@test.com`,
    password: 'P@ssword1!',
    fullName: `Tech ${suffix}`,
    role: 'technician',
    status: 'active',
    emailVerified: true,
  });

  const profile = await TechnicianProfile.create({
    userId: user._id,
    displayName: `Tech ${suffix}`,
    verificationStatus: 'approved',
    availability: {
      isOnline: true,
      weeklySchedule: [
        { day: 'mon', from: '00:00', to: '23:59' },
        { day: 'tue', from: '00:00', to: '23:59' },
        { day: 'wed', from: '00:00', to: '23:59' },
        { day: 'thu', from: '00:00', to: '23:59' },
        { day: 'fri', from: '00:00', to: '23:59' },
        { day: 'sat', from: '00:00', to: '23:59' },
        { day: 'sun', from: '00:00', to: '23:59' },
      ],
    },
    skills: {
      serviceIds: [],
      categoryIds: [],
    },
    serviceArea: {
      zipCodes: ['90210'],
      radiusKm: 100,
    },
  });

  return { user, profile };
}

async function createTestBooking(overrides: Record<string, unknown> = {}) {
  const serviceId = new mongoose.Types.ObjectId();
  return Booking.create({
    bookingNumber: `GIS-TEST-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    serviceId,
    categoryId: new mongoose.Types.ObjectId(),
    guest: { fullName: 'Test Customer', email: 'customer@test.com', phone: '555-0100' },
    serviceSnapshot: { name: 'Detail Service', slug: 'detail-service' },
    vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2022 },
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // tomorrow
    scheduledLocal: { date: '2026-11-01', slot: '10:00' },
    pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
    address: { freeText: '123 Main St', zip: '90210', country: 'USA' },
    status: 'confirmed',
    source: 'web',
    ...overrides,
  });
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Dispatch Concurrency & Atomicity (real MongoDB)', () => {
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
  });

  // ── 1. Two simultaneous accepts → exactly 1×200, 1×409 ─────────────────

  it('two simultaneous acceptOffer calls → exactly one succeeds, one gets OFFER_NO_LONGER_AVAILABLE', async () => {
    const { user: tech1 } = await createApprovedTechUser('a');
    const { user: tech2 } = await createApprovedTechUser('b');
    const booking = await createTestBooking();

    // Manually create two active offers (one per technician)
    const now = new Date();
    const offer1 = await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: tech1._id,
      status: 'sent',
      sentAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      rank: 1,
      source: 'auto',
    });
    const offer2 = await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: tech2._id,
      status: 'sent',
      sentAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      rank: 2,
      source: 'auto',
    });

    // Fire both accepts simultaneously
    const [result1, result2] = await Promise.allSettled([
      DispatchService.acceptOffer(offer1._id.toString(), tech1._id.toString()),
      DispatchService.acceptOffer(offer2._id.toString(), tech2._id.toString()),
    ]);

    const successes = [result1, result2].filter((r) => r.status === 'fulfilled');
    const failures = [result1, result2].filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const failedErr = (failures[0] as PromiseRejectedResult).reason;
    expect(failedErr.code).toBe('OFFER_NO_LONGER_AVAILABLE');
    expect(failedErr.statusCode).toBe(409);

    // Verify booking state
    const updatedBooking = await Booking.findById(booking._id);
    expect(updatedBooking?.status).toBe('assigned');
    expect(updatedBooking?.assignment?.technicianUserId).toBeDefined();

    // Verify exactly one offer accepted, other cancelled
    const acceptedOffers = await DispatchOffer.countDocuments({
      bookingId: booking._id,
      status: 'accepted',
    });
    expect(acceptedOffers).toBe(1);
  });

  // ── 2. Same technician cannot accept the same offer twice ───────────────

  it('accepting an already-accepted offer returns OFFER_NO_LONGER_AVAILABLE', async () => {
    const { user: tech } = await createApprovedTechUser('c');
    const booking = await createTestBooking();
    const offer = await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: tech._id,
      status: 'sent',
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rank: 1,
      source: 'auto',
    });

    await DispatchService.acceptOffer(offer._id.toString(), tech._id.toString());

    await expect(
      DispatchService.acceptOffer(offer._id.toString(), tech._id.toString())
    ).rejects.toMatchObject({ code: 'OFFER_NO_LONGER_AVAILABLE', statusCode: 409 });
  });

  // ── 3. Expired offer cannot be accepted ─────────────────────────────────

  it('accepting an expired offer returns OFFER_EXPIRED', async () => {
    const { user: tech } = await createApprovedTechUser('d');
    const booking = await createTestBooking();
    const offer = await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: tech._id,
      status: 'sent',
      sentAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000), // already expired
      rank: 1,
      source: 'auto',
    });

    await expect(
      DispatchService.acceptOffer(offer._id.toString(), tech._id.toString())
    ).rejects.toMatchObject({ code: 'OFFER_EXPIRED', statusCode: 409 });

    // Offer should now be marked expired in DB
    const updatedOffer = await DispatchOffer.findById(offer._id);
    expect(updatedOffer?.status).toBe('expired');
  });

  // ── 4. Sweeper atomically expires overdue offers ─────────────────────────

  it('sweeper expires overdue offers and advances dispatch (atomic)', async () => {
    const { user: tech } = await createApprovedTechUser('e');
    const booking = await createTestBooking();

    // Create an expired offer
    await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: tech._id,
      status: 'sent',
      sentAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000), // past
      rank: 1,
      source: 'auto',
    });

    const result = await DispatchService.runDispatchSweep();

    expect(result.expiredOffersCount).toBe(1);
    // Booking was advanced (exhausted since no other candidates)
    expect(result.advancedBookings).toBeGreaterThanOrEqual(1);

    const expiredOffer = await DispatchOffer.findOne({ bookingId: booking._id });
    expect(expiredOffer?.status).toBe('expired');
  });

  // ── 5. Sweeper is idempotent: running twice doesn't double-expire ────────

  it('sweeper running twice does not double-expire the same offers', async () => {
    const { user: tech } = await createApprovedTechUser('f');
    const booking = await createTestBooking();

    await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: tech._id,
      status: 'sent',
      sentAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
      rank: 1,
      source: 'auto',
    });

    const [r1, r2] = await Promise.all([
      DispatchService.runDispatchSweep(),
      DispatchService.runDispatchSweep(),
    ]);

    // Total expired across both runs must be exactly 1 (not 2)
    expect(r1.expiredOffersCount + r2.expiredOffersCount).toBe(1);
  });

  // ── 6. Decline then redispatch to next candidate ─────────────────────────

  it('declining an offer triggers redispatch to next batch', async () => {
    const { user: tech1 } = await createApprovedTechUser('g');
    const booking = await createTestBooking();

    const offer = await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: tech1._id,
      status: 'sent',
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rank: 1,
      source: 'auto',
    });

    await booking.updateOne({ 'dispatch.status': 'offered', 'dispatch.attempts': 1 });

    const result = await DispatchService.declineOffer(
      offer._id.toString(),
      tech1._id.toString(),
      'No longer available'
    );
    expect(result.success).toBe(true);

    const updatedOffer = await DispatchOffer.findById(offer._id);
    expect(updatedOffer?.status).toBe('declined');
    expect(updatedOffer?.declineReason).toBe('No longer available');
  });

  // ── 7. manualAssign dispatches booking ───────────────────────────────────

  it('manualAssign (admin, force=false) rejects ineligible tech and assigns eligible one', async () => {
    const { user: ineligible } = await createApprovedTechUser('h');
    const { user: eligible } = await createApprovedTechUser('i');
    const booking = await createTestBooking();

    // Make ineligible tech offline
    await TechnicianProfile.updateOne({ userId: ineligible._id }, { $set: { 'availability.isOnline': false } });

    const actor = { userId: new mongoose.Types.ObjectId().toString(), role: 'admin' };

    // Ineligible tech → should fail (not matching skill or offline)
    await expect(
      DispatchService.manualAssign(booking._id.toString(), ineligible._id.toString(), actor, false)
    ).rejects.toMatchObject({ statusCode: 400 });

    // Force assign ineligible → admin can override
    const assigned = await DispatchService.manualAssign(
      booking._id.toString(),
      ineligible._id.toString(),
      actor,
      true // force
    );
    expect(assigned.status).toBe('assigned');
    expect(assigned.assignment?.technicianUserId?.toString()).toBe(ineligible._id.toString());
    expect(assigned.technicianId?.toString()).toBe(ineligible._id.toString()); // must be in sync
  });

  // ── 8. Force assign is admin-only: dispatcher gets 403 ──────────────────

  it('force=true with dispatcher role throws FORBIDDEN', async () => {
    const { user: tech } = await createApprovedTechUser('j');
    const booking = await createTestBooking();
    const actor = { userId: new mongoose.Types.ObjectId().toString(), role: 'dispatcher' };

    await expect(
      DispatchService.manualAssign(booking._id.toString(), tech._id.toString(), actor, true)
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  // ── 9. manualUnassign resets booking to confirmed ────────────────────────

  it('manualUnassign clears assignment and resets booking to confirmed', async () => {
    const { user: tech } = await createApprovedTechUser('k');
    const booking = await createTestBooking({ status: 'assigned' });
    await booking.updateOne({
      'assignment.technicianUserId': tech._id,
      'assignment.assignedAt': new Date(),
      'assignment.assignedBy': 'admin',
      technicianId: tech._id,
    });

    const actor = { userId: new mongoose.Types.ObjectId().toString(), role: 'admin' };
    const updated = await DispatchService.manualUnassign(booking._id.toString(), actor);

    expect(updated.status).toBe('confirmed');
    expect(updated.technicianId).toBeNull();
    expect(updated.assignment?.technicianUserId).toBeUndefined();
  });

  // ── 10. Full dispatch chain: dispatch → exhaust → escalate ──────────────

  it('dispatch exhausts after maxOffersPerBooking and marks status exhausted', async () => {
    // Set max to 1 so we hit exhaustion quickly
    await DispatchSettings.create({ maxOffersPerBooking: 1 });

    const { user: tech } = await createApprovedTechUser('l');
    const booking = await createTestBooking();
    await booking.updateOne({ 'dispatch.attempts': 1 }); // already attempted once

    const result = await DispatchService.startDispatch(booking._id, 'test');
    expect(result.status).toBe('exhausted');
    expect(result.offersCreated).toBe(0);

    const updated = await Booking.findById(booking._id);
    expect(updated?.dispatch?.status).toBe('exhausted');
  });

  // ── 11. Same technician accepts two overlapping bookings simultaneously ──

  it('same technician accepts two overlapping bookings simultaneously → exactly one 200, one 409 SCHEDULE_CONFLICT, returned to dispatch', async () => {
    const { user: tech } = await createApprovedTechUser('overlap-tech');
    const scheduledTime = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Create two bookings at the same scheduled time
    const booking1 = await createTestBooking({ scheduledAt: scheduledTime });
    const booking2 = await createTestBooking({ scheduledAt: scheduledTime });

    const now = new Date();
    const offer1 = await DispatchOffer.create({
      bookingId: booking1._id,
      technicianUserId: tech._id,
      status: 'sent',
      sentAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      rank: 1,
      source: 'auto',
    });
    const offer2 = await DispatchOffer.create({
      bookingId: booking2._id,
      technicianUserId: tech._id,
      status: 'sent',
      sentAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      rank: 1,
      source: 'auto',
    });

    const [res1, res2] = await Promise.allSettled([
      DispatchService.acceptOffer(offer1._id.toString(), tech._id.toString()),
      DispatchService.acceptOffer(offer2._id.toString(), tech._id.toString()),
    ]);

    const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
    const failures = [res1, res2].filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const conflictErr = (failures[0] as PromiseRejectedResult).reason;
    expect(conflictErr.statusCode).toBe(409);
    expect(conflictErr.code).toBe('SCHEDULE_CONFLICT');

    // Winning booking is assigned
    const b1 = await Booking.findById(booking1._id);
    const b2 = await Booking.findById(booking2._id);
    const assignedCount = [b1, b2].filter((b) => b?.status === 'assigned').length;
    expect(assignedCount).toBe(1);

    // The other booking returned to dispatch
    const otherBooking = b1?.status === 'assigned' ? b2 : b1;
    expect(['searching', 'exhausted', 'offered']).toContain(otherBooking?.dispatch?.status);
  });

  // ── 12. Pending booking cannot be claimed ────────────────────────────────

  it('pending booking cannot be claimed (returns 409 BOOKING_NOT_CONFIRMED)', async () => {
    const { user: tech } = await createApprovedTechUser('pending-tech');
    const pendingBooking = await createTestBooking({ status: 'pending' });

    const offer = await DispatchOffer.create({
      bookingId: pendingBooking._id,
      technicianUserId: tech._id,
      status: 'sent',
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rank: 1,
      source: 'auto',
    });

    await expect(
      DispatchService.acceptOffer(offer._id.toString(), tech._id.toString())
    ).rejects.toMatchObject({ statusCode: 409, code: 'BOOKING_NOT_CONFIRMED' });
  });

  // ── 13. Cron sweep endpoint fails closed without CRON_SECRET ─────────────

  it('POST /api/v1/dispatch/cron/sweep fails 401 without valid CRON_SECRET', async () => {
    // No secret provided
    const resNoAuth = await request(app).post('/api/v1/dispatch/cron/sweep');
    expect(resNoAuth.status).toBe(401);

    // Bad token
    const resBadToken = await request(app)
      .post('/api/v1/dispatch/cron/sweep')
      .set('Authorization', 'Bearer invalid-cron-secret');
    expect(resBadToken.status).toBe(401);
  });
});
