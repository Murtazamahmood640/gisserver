/**
 * schedule-integrity.test.ts
 *
 * Comprehensive tests for Schedule Single Source of Truth:
 * - Every code path that assigns, modifies, or ends a booking assignment
 * - Write ordering & crash recovery
 * - reconcileTechnicianSchedules() idempotency & concurrency
 * - Release & immediate overlapping re-acceptance
 * - Tracking cleanup 24h threshold
 *
 * Real MongoDB (MongoMemoryServer) — no mocks for DB or state transitions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Silence email and push
vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'mock' }),
  getTechnicianNewOfferEmail: vi.fn().mockReturnValue('<p>offer</p>'),
  getCustomerTechnicianAssignedEmail: vi.fn().mockReturnValue('<p>assigned</p>'),
  getAdminDispatchExhaustedEmail: vi.fn().mockReturnValue('<p>exhausted</p>'),
  getCustomerTechnicianEnRouteEmail: vi.fn().mockReturnValue('<p>enroute</p>'),
  getCustomerTechnicianArrivedEmail: vi.fn().mockReturnValue('<p>arrived</p>'),
  getCustomerJobCompletedEmail: vi.fn().mockReturnValue('<p>complete</p>'),
  getStatusUpdateEmail: vi.fn().mockReturnValue('<p>status</p>'),
  getTechSuspendedEmail: vi.fn().mockReturnValue('<p>suspended</p>'),
  getTechRejectedEmail: vi.fn().mockReturnValue('<p>rejected</p>'),
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
    disconnectUserSockets: vi.fn(),
  },
}));

import { User } from '../models/User';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { Booking } from '../models/Booking';
import { DispatchOffer } from '../models/DispatchOffer';
import { DispatchSettings } from '../models/DispatchSettings';
import { LocationPing } from '../models/LocationPing';
import { TechnicianLocation } from '../models/TechnicianLocation';
import { DispatchService } from '../modules/dispatch/service';
import { JobsService } from '../modules/jobs/service';
import { BookingService } from '../modules/bookings/service';
import { TechnicianService } from '../modules/technicians/service';
import { TrackingService } from '../modules/tracking/service';

let mongoServer: MongoMemoryServer;
const sharedCategoryId = new mongoose.Types.ObjectId();

async function createTech(suffix: string) {
  const user = await User.create({
    email: `tech-${suffix}@test.com`,
    password: 'Password123!',
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
      timeOff: [],
    },
    skills: { serviceIds: [], categoryIds: [sharedCategoryId] },
    serviceArea: { zipCodes: ['90210'], radiusKm: 100 },
    activeSchedule: [],
  });

  return { user, profile };
}

async function createBooking(overrides: Record<string, unknown> = {}) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return Booking.create({
    bookingNumber: `SCHED-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    categoryId: sharedCategoryId,
    serviceId: new mongoose.Types.ObjectId(),
    guest: { fullName: 'Customer One', email: 'c1@test.com', phone: '555-0100' },
    serviceSnapshot: { name: 'Full Detail', slug: 'full-detail' },
    vehicleSnapshot: { category: 'sedan', make: 'Honda', model: 'Civic', year: 2021 },
    scheduledAt: tomorrow,
    scheduledLocal: { date: '2026-11-10', slot: '10:00' },
    pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
    address: { freeText: '456 Elm St', zip: '90210', country: 'USA' },
    status: 'confirmed',
    source: 'web',
    ...overrides,
  });
}

describe('Schedule Single Source of Truth & Reconcile (real MongoDB)', () => {
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
    await LocationPing.deleteMany({});
    await TechnicianLocation.deleteMany({});
    // Ensure BookingSettings exists for rescheduleBooking
    const { BookingSettings } = await import('../models/BookingSettings');
    await BookingSettings.deleteMany({});
    await BookingSettings.create({
      slotDurationMinutes: 60,
      slotCapacity: 5,
      businessTimezone: 'America/New_York',
    });
  });

  // ── 1. Accept Offer maintains activeSchedule ──────────────────────────────

  it('path: acceptOffer adds activeSchedule entry with correct start and end', async () => {
    const { user, profile } = await createTech('accept');
    const booking = await createBooking();

    const offer = await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: user._id,
      rank: 1,
      status: 'sent',
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    });

    const res = await DispatchService.acceptOffer(offer._id.toString(), user._id.toString());
    expect(res.success).toBe(true);

    const updatedProfile = await TechnicianProfile.findOne({ userId: user._id });
    expect(updatedProfile?.activeSchedule?.length).toBe(1);
    expect(updatedProfile?.activeSchedule?.[0].bookingId.toString()).toBe(booking._id.toString());
    expect(new Date(updatedProfile!.activeSchedule![0].start).getTime()).toBe(booking.scheduledAt.getTime());
  });

  // ── 2. Manual Assign & Conflict Detection ─────────────────────────────────

  it('path: manualAssign reserves schedule, detects conflicts (409), and force-assign bypasses and audits', async () => {
    const { user } = await createTech('assign');
    const b1 = await createBooking({ scheduledAt: new Date(Date.now() + 3600000) });
    const b2 = await createBooking({ scheduledAt: new Date(Date.now() + 3600000) }); // overlapping

    // Admin assign b1
    await DispatchService.manualAssign(b1._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    let p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(1);

    // Dispatcher assigning b2 (conflict) without force fails with 409 SCHEDULE_CONFLICT
    await expect(
      DispatchService.manualAssign(
        b2._id.toString(),
        user._id.toString(),
        { userId: 'disp1', role: 'dispatcher' },
        false
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'SCHEDULE_CONFLICT' });

    // Admin force-assign b2 succeeds and audits in history
    const forced = await DispatchService.manualAssign(
      b2._id.toString(),
      user._id.toString(),
      { userId: 'admin1', role: 'admin' },
      true
    );
    expect(forced.status).toBe('assigned');

    p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(2);

    const histEntry = forced.statusHistory.find((h) => h.note?.includes('Forced manual assignment'));
    expect(histEntry).toBeDefined();
  });

  // ── 3. Manual Reassign ───────────────────────────────────────────────────

  it('path: manualReassign removes slot from old tech and adds to new tech', async () => {
    const { user: tech1 } = await createTech('reassign-old');
    const { user: tech2 } = await createTech('reassign-new');
    const booking = await createBooking();

    // Assign to tech1
    await DispatchService.manualAssign(booking._id.toString(), tech1._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    let p1 = await TechnicianProfile.findOne({ userId: tech1._id });
    expect(p1?.activeSchedule?.length).toBe(1);

    // Reassign to tech2
    await DispatchService.manualReassign(booking._id.toString(), tech2._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    p1 = await TechnicianProfile.findOne({ userId: tech1._id });
    const p2 = await TechnicianProfile.findOne({ userId: tech2._id });
    expect(p1?.activeSchedule?.length).toBe(0);
    expect(p2?.activeSchedule?.length).toBe(1);
    expect(p2?.activeSchedule?.[0].bookingId.toString()).toBe(booking._id.toString());
  });

  // ── 4. Manual Unassign ───────────────────────────────────────────────────

  it('path: manualUnassign removes slot from tech profile', async () => {
    const { user } = await createTech('unassign');
    const booking = await createBooking();

    await DispatchService.manualAssign(booking._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    await DispatchService.manualUnassign(booking._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    const p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(0);
  });

  // ── 5. Manual Redispatch ─────────────────────────────────────────────────

  it('path: manualRedispatch removes slot from previous technician', async () => {
    const { user } = await createTech('redispatch');
    const booking = await createBooking();

    await DispatchService.manualAssign(booking._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    await DispatchService.manualRedispatch(booking._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    const p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(0);
  });

  // ── 6. Technician Release & Immediate Overlapping Accept ─────────────────

  it('path: release removes slot, allowing technician to accept an overlapping booking immediately', async () => {
    const { user } = await createTech('release');
    const b1 = await createBooking({ scheduledAt: new Date(Date.now() + 7200000) });
    const b2 = await createBooking({ scheduledAt: new Date(Date.now() + 7200000) }); // same time!

    // Assign b1
    await DispatchService.manualAssign(b1._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    // Tech releases b1
    await JobsService.release(b1._id.toString(), user._id.toString(), 'Personal emergency');

    let p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(0);

    // Tech receives offer for b2 and accepts immediately
    const offer2 = await DispatchOffer.create({
      bookingId: b2._id,
      technicianUserId: user._id,
      rank: 1,
      status: 'sent',
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    });

    const res2 = await DispatchService.acceptOffer(offer2._id.toString(), user._id.toString());
    expect(res2.success).toBe(true);

    p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(1);
    expect(p?.activeSchedule?.[0].bookingId.toString()).toBe(b2._id.toString());
  });

  // ── 7. Job Completion ────────────────────────────────────────────────────

  it('path: complete removes slot from activeSchedule', async () => {
    const { user } = await createTech('complete');
    const booking = await createBooking();

    await DispatchService.manualAssign(booking._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    await JobsService.enRoute(booking._id.toString(), user._id.toString());
    await JobsService.arrived(booking._id.toString(), user._id.toString());
    await JobsService.start(booking._id.toString(), user._id.toString());
    await JobsService.complete(booking._id.toString(), user._id.toString(), { notes: 'Finished' });

    const p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(0);
  });

  // ── 8. Booking Cancel ────────────────────────────────────────────────────

  it('path: cancelBooking removes slot from assigned technician', async () => {
    const { user } = await createTech('cancel');
    const booking = await createBooking();

    await DispatchService.manualAssign(booking._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    await BookingService.cancelBooking(
      booking._id.toString(),
      { userId: 'admin1', email: 'admin@test.com', role: 'admin' },
      'Customer requested cancellation'
    );

    const p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(0);
  });

  // ── 9. Booking Reschedule (Time Change) ───────────────────────────────────

  it('path: rescheduleBooking updates activeSchedule slot to new times', async () => {
    const { user } = await createTech('resched');
    const booking = await createBooking({
      scheduledLocal: { date: '2026-11-10', slot: '10:00' },
    });

    await DispatchService.manualAssign(booking._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });

    let p = await TechnicianProfile.findOne({ userId: user._id });
    const originalStart = new Date(p!.activeSchedule![0].start).getTime();

    // Reschedule to 14:00
    await BookingService.rescheduleBooking(
      booking._id.toString(),
      { userId: 'admin1', email: 'admin@test.com', role: 'admin' },
      { date: '2026-11-10', slot: '14:00', reason: 'Customer moved time' }
    );

    p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(1);
    const newStart = new Date(p!.activeSchedule![0].start).getTime();
    expect(newStart).not.toBe(originalStart);
  });

  // ── 10. Admin Update Status: no_show / refunded ──────────────────────────

  it('path: adminUpdateStatus transitions to no_show and refunded remove slot', async () => {
    const { user } = await createTech('term-status');
    const b1 = await createBooking();
    const b2 = await createBooking();

    await DispatchService.manualAssign(b1._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });
    await DispatchService.manualAssign(b2._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    }, true);

    let p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(2);

    // Transition b1 to no_show
    await BookingService.adminUpdateStatus(b1._id.toString(), { email: 'admin@test.com' }, {
      status: 'no_show',
      note: 'Customer not at address',
    });

    p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(1);

    // Transition b2: assigned -> no_show -> refunded
    await BookingService.adminUpdateStatus(b2._id.toString(), { email: 'admin@test.com' }, {
      status: 'no_show',
      note: 'Customer not at address',
    });
    await BookingService.adminUpdateStatus(b2._id.toString(), { email: 'admin@test.com' }, {
      status: 'refunded',
      note: 'Refund processed',
    });

    p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(0);
  });

  // ── 11. Admin Delete (Soft & Hard) ────────────────────────────────────────

  it('path: adminDelete (soft & hard) removes slot from activeSchedule', async () => {
    const { user } = await createTech('delete-path');
    const bSoft = await createBooking();
    const bHard = await createBooking();

    await DispatchService.manualAssign(bSoft._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    });
    await DispatchService.manualAssign(bHard._id.toString(), user._id.toString(), {
      userId: 'admin1',
      role: 'admin',
    }, true);

    let p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(2);

    // Soft delete
    await BookingService.adminDelete(bSoft._id.toString(), false);
    p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(1);

    // Hard delete
    await BookingService.adminDelete(bHard._id.toString(), true);
    p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(0);
  });

  // ── 12. Technician Suspended & Rejected ───────────────────────────────────

  it('path: suspendTechnician and rejectApplication clear activeSchedule', async () => {
    const { user: uSusp, profile: pSusp } = await createTech('susp');
    const { user: uRej, profile: pRej } = await createTech('rej');

    // Manually plant slot
    await TechnicianProfile.updateOne(
      { _id: pSusp._id },
      { $push: { activeSchedule: { bookingId: new mongoose.Types.ObjectId(), start: new Date(), end: new Date() } } }
    );
    await TechnicianProfile.updateOne(
      { _id: pRej._id },
      { $push: { activeSchedule: { bookingId: new mongoose.Types.ObjectId(), start: new Date(), end: new Date() } } }
    );

    // Suspend
    await TechnicianService.suspendTechnician(uSusp._id.toString(), 'admin1', 'Policy violation');
    let p = await TechnicianProfile.findById(pSusp._id);
    expect(p?.activeSchedule?.length).toBe(0);

    // Set pRej to pending_review so reject is a valid transition
    await TechnicianProfile.updateOne({ _id: pRej._id }, { $set: { verificationStatus: 'pending_review' } });
    await TechnicianService.rejectApplication(uRej._id.toString(), 'admin1', 'Incomplete documents');
    p = await TechnicianProfile.findById(pRej._id);
    expect(p?.activeSchedule?.length).toBe(0);
  });

  // ── 13. Simulated Crash Between Accept Writes ─────────────────────────────

  it('reconcile: simulated crash between CAS-slot and booking-claim leaves booking unassigned; reconcile clears orphan slot', async () => {
    const { user } = await createTech('crash');
    const booking = await createBooking();

    // Simulate Step 1 of acceptOffer succeeded (slot added to profile), but process crashed before Booking update.
    // Use a past createdAt so the 120-second grace period does not protect it.
    const bStart = new Date(booking.scheduledAt);
    const bEnd = new Date(bStart.getTime() + 90 * 60 * 1000);
    await TechnicianProfile.updateOne(
      { userId: user._id },
      { $push: { activeSchedule: { bookingId: booking._id, start: bStart, end: bEnd, createdAt: new Date(Date.now() - 200_000) } } }
    );

    // Booking remains 'confirmed' and unassigned
    let p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(1);

    // Reconcile runs
    const rec = await DispatchService.reconcileTechnicianSchedules();
    expect(rec.removed).toBe(1);

    p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(0);
  });

  // ── 14. Orphan Entry & Missing Entry Reconcile ────────────────────────────

  it('reconcile: removes orphan entry and adds missing active assigned entry', async () => {
    const { user, profile } = await createTech('reconcile-both');
    const activeBooking = await createBooking({
      status: 'assigned',
      technicianId: user._id,
      assignment: { technicianUserId: user._id, assignedAt: new Date() },
    });

    // Plant an orphan entry for a non-existent booking.
    // Use a past createdAt so the 120-second grace period does not protect it.
    await TechnicianProfile.updateOne(
      { _id: profile._id },
      {
        $push: {
          activeSchedule: {
            bookingId: new mongoose.Types.ObjectId(),
            start: new Date(),
            end: new Date(),
            createdAt: new Date(Date.now() - 200_000),
          },
        },
      }
    );

    let p = await TechnicianProfile.findById(profile._id);
    expect(p?.activeSchedule?.length).toBe(1); // has orphan, lacks activeBooking

    const res = await DispatchService.reconcileTechnicianSchedules();
    expect(res.removed).toBe(1);
    expect(res.added).toBe(1);

    p = await TechnicianProfile.findById(profile._id);
    expect(p?.activeSchedule?.length).toBe(1);
    expect(p?.activeSchedule?.[0].bookingId.toString()).toBe(activeBooking._id.toString());

    // Second run is idempotent (0 removed, 0 added)
    const idempotent = await DispatchService.reconcileTechnicianSchedules();
    expect(idempotent.removed).toBe(0);
    expect(idempotent.added).toBe(0);
  });

  // ── 15. Concurrent Reconcile Runs ─────────────────────────────────────────

  it('reconcile: concurrent runs are safe and idempotent', async () => {
    const { user } = await createTech('reconcile-race');
    await createBooking({
      status: 'assigned',
      technicianId: user._id,
      assignment: { technicianUserId: user._id, assignedAt: new Date() },
    });

    // Run 5 reconcile operations simultaneously
    const results = await Promise.all([
      DispatchService.reconcileTechnicianSchedules(),
      DispatchService.reconcileTechnicianSchedules(),
      DispatchService.reconcileTechnicianSchedules(),
      DispatchService.reconcileTechnicianSchedules(),
      DispatchService.reconcileTechnicianSchedules(),
    ]);

    const totalAdded = results.reduce((sum, r) => sum + r.added, 0);
    expect(totalAdded).toBe(1); // Exactly one worker added the slot, others were no-op

    const p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(1);
  });

  // ── 16a. Grace Period: in-flight accept (<120s) survives concurrent reconcile ──

  it('reconcile: in-progress accept slot (<120s createdAt) survives a concurrent reconcile run', async () => {
    const { user } = await createTech('grace-period');
    const booking = await createBooking();

    // Simulate step 1 of acceptOffer: slot reserved with fresh createdAt (now)
    const bStart = new Date(booking.scheduledAt);
    const bEnd = new Date(bStart.getTime() + 90 * 60 * 1000);
    await TechnicianProfile.updateOne(
      { userId: user._id },
      {
        $push: {
          activeSchedule: {
            bookingId: booking._id,
            start: bStart,
            end: bEnd,
            createdAt: new Date(), // <120s old — protected
          },
        },
      }
    );

    // Booking is still unassigned (crash before step 2 would be simulated here)
    // Reconcile runs concurrently
    const rec = await DispatchService.reconcileTechnicianSchedules();

    // Slot must NOT be removed because it is within the 120-second grace window
    expect(rec.removed).toBe(0);

    const p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(1);
  });

  it('reconcile: stale orphan slot (>120s old) is removed even without a booking claim', async () => {
    const { user } = await createTech('stale-orphan');
    const booking = await createBooking();

    // Simulate a slot that was orphaned more than 120 seconds ago
    const oldCreatedAt = new Date(Date.now() - 200_000); // 200 seconds ago
    const bStart = new Date(booking.scheduledAt);
    const bEnd = new Date(bStart.getTime() + 90 * 60 * 1000);
    await TechnicianProfile.updateOne(
      { userId: user._id },
      {
        $push: {
          activeSchedule: {
            bookingId: booking._id,
            start: bStart,
            end: bEnd,
            createdAt: oldCreatedAt, // >120s old — stale
          },
        },
      }
    );

    // Booking remains unassigned (orphan)
    const rec = await DispatchService.reconcileTechnicianSchedules();
    expect(rec.removed).toBe(1);

    const p = await TechnicianProfile.findOne({ userId: user._id });
    expect(p?.activeSchedule?.length).toBe(0);
  });

  // ── 16b. Reschedule: conflict check and unassignTechnician flag ────────────

  it('path: rescheduleBooking with assigned technician that has a conflict returns 409 SCHEDULE_CONFLICT', async () => {
    const { user } = await createTech('reschedule-conflict');

    // Booking1: assigned to tech at 2026-11-10 12:00 ET = 17:00 UTC
    const b1At = new Date('2026-11-10T17:00:00.000Z');
    const booking1 = await createBooking({
      status: 'assigned',
      technicianId: user._id,
      assignment: { technicianUserId: user._id, assignedAt: new Date() },
      scheduledAt: b1At,
      scheduledLocal: { date: '2026-11-10', slot: '12:00' },
    });

    // Add booking1 slot to the tech's activeSchedule
    const b1Start = new Date(booking1.scheduledAt);
    const b1End = new Date(b1Start.getTime() + 90 * 60 * 1000);
    await TechnicianProfile.updateOne(
      { userId: user._id },
      {
        $push: {
          activeSchedule: {
            bookingId: booking1._id,
            start: b1Start,
            end: b1End,
            createdAt: new Date(),
          },
        },
      }
    );

    // Booking2: assigned to same tech at a different date
    const b2At = new Date('2026-11-11T14:00:00.000Z'); // 2026-11-11 09:00 ET
    const booking2 = await createBooking({
      status: 'assigned',
      technicianId: user._id,
      assignment: { technicianUserId: user._id, assignedAt: new Date() },
      scheduledAt: b2At,
      scheduledLocal: { date: '2026-11-11', slot: '09:00' },
    });

    // Try to reschedule booking2 to OVERLAP with booking1 (same 12:00 slot on 2026-11-10)
    const adminUser = { userId: 'admin-id', email: 'admin@test.com', role: 'admin' };
    await expect(
      BookingService.rescheduleBooking(
        booking2._id.toString(),
        adminUser,
        { date: '2026-11-10', slot: '12:00', reason: 'Conflict test' }
      )
    ).rejects.toMatchObject({ code: 'SCHEDULE_CONFLICT' });

    // booking2 must remain unchanged
    const b2 = await Booking.findById(booking2._id);
    expect(b2?.status).toBe('assigned');
  });

  it('path: rescheduleBooking with unassignTechnician=true returns booking to dispatch on conflict', async () => {
    const { user } = await createTech('reschedule-unassign');

    // Blocking booking at 2026-11-10 12:00 ET = 17:00 UTC
    const blockAt = new Date('2026-11-10T17:00:00.000Z');
    const blocking = await createBooking({
      status: 'assigned',
      technicianId: user._id,
      assignment: { technicianUserId: user._id, assignedAt: new Date() },
      scheduledAt: blockAt,
      scheduledLocal: { date: '2026-11-10', slot: '12:00' },
    });

    const blockStart = new Date(blocking.scheduledAt);
    const blockEnd = new Date(blockStart.getTime() + 90 * 60 * 1000);
    await TechnicianProfile.updateOne(
      { userId: user._id },
      {
        $push: {
          activeSchedule: {
            bookingId: blocking._id,
            start: blockStart,
            end: blockEnd,
            createdAt: new Date(),
          },
        },
      }
    );

    // Second booking assigned to same tech at a non-conflicting time, with its own slot
    const b2At = new Date('2026-11-12T14:00:00.000Z'); // 2026-11-12 09:00 ET
    const booking2 = await createBooking({
      status: 'assigned',
      technicianId: user._id,
      assignment: { technicianUserId: user._id, assignedAt: new Date() },
      scheduledAt: b2At,
      scheduledLocal: { date: '2026-11-12', slot: '09:00' },
    });

    // Also add booking2's slot to the tech so $pull is meaningful
    const b2Start = new Date(booking2.scheduledAt);
    const b2End = new Date(b2Start.getTime() + 90 * 60 * 1000);
    await TechnicianProfile.updateOne(
      { userId: user._id },
      {
        $push: {
          activeSchedule: {
            bookingId: booking2._id,
            start: b2Start,
            end: b2End,
            createdAt: new Date(),
          },
        },
      }
    );

    const adminUser = { userId: 'admin2', email: 'admin@test.com', role: 'admin' };

    // Reschedule booking2 into the conflict window; admin passes unassignTechnician=true
    // This will: detect conflict → unassign tech → proceed with reschedule
    await BookingService.rescheduleBooking(
      booking2._id.toString(),
      adminUser,
      { date: '2026-11-10', slot: '12:00', reason: 'Reschedule', unassignTechnician: true }
    );

    // booking2's slot must be gone from tech's activeSchedule
    const p = await TechnicianProfile.findOne({ userId: user._id });
    const slotForBooking2 = p?.activeSchedule?.find(
      (s: { bookingId?: { toString(): string } }) => s.bookingId?.toString() === booking2._id.toString()
    );
    expect(slotForBooking2).toBeUndefined();

    // booking2 should now be 'confirmed' (unassigned) with its new scheduled time
    const b2Updated = await Booking.findById(booking2._id);
    expect(b2Updated?.status).toBe('confirmed');
    expect(b2Updated?.scheduledLocal?.slot).toBe('12:00');
  });

  // ── 16. Tracking Cleanup (>24h threshold) ─────────────────────────────────

  it('cleanup: deletes pings and clears technicianLocations.bookingId only for bookings finished >24h ago', async () => {
    const { user } = await createTech('cleanup-test');

    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago

    // Finished old booking (>24h ago)
    const oldBooking = await createBooking({
      status: 'completed',
      completedAt: oldDate,
      updatedAt: oldDate,
    });

    // Recently completed booking (<24h ago)
    const recentBooking = await createBooking({
      status: 'completed',
      completedAt: recentDate,
      updatedAt: recentDate,
    });

    // Active in-progress booking
    const activeBooking = await createBooking({
      status: 'in_progress',
    });

    // Pings for all 3 bookings
    await LocationPing.create({
      bookingId: oldBooking._id,
      technicianUserId: user._id,
      location: { type: 'Point', coordinates: [-74.006, 40.7128] },
      at: oldDate,
    });
    await LocationPing.create({
      bookingId: recentBooking._id,
      technicianUserId: user._id,
      location: { type: 'Point', coordinates: [-74.006, 40.7128] },
      at: recentDate,
    });
    await LocationPing.create({
      bookingId: activeBooking._id,
      technicianUserId: user._id,
      location: { type: 'Point', coordinates: [-74.006, 40.7128] },
      at: new Date(),
    });

    // Technician location linked to old booking
    await TechnicianLocation.create({
      technicianUserId: user._id,
      location: { type: 'Point', coordinates: [-74.006, 40.7128] },
      bookingId: oldBooking._id,
      updatedAt: oldDate,
    });

    // Run cleanup
    const cleanupRes = await TrackingService.runTrackingCleanup();
    expect(cleanupRes.deletedPingsCount).toBe(1); // Only the old booking's ping was deleted
    expect(cleanupRes.clearedLocationsCount).toBe(1); // Cleared from technicianLocation

    // Verify recent and active pings still exist
    const remainingPings = await LocationPing.find();
    expect(remainingPings.length).toBe(2);

    const techLoc = await TechnicianLocation.findOne({ technicianUserId: user._id });
    expect(techLoc?.bookingId).toBeNull();
  });
});
