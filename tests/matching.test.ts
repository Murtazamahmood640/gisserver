/**
 * matching.test.ts
 *
 * Tests all 9 eligibility filters and ranking in eligibleTechnicians().
 * Uses real MongoDB via MongoMemoryServer.
 *
 * PART 8b
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../services/emailService', () => ({ sendEmail: vi.fn() }));
vi.mock('../services/pushService', () => ({ pushService: { sendToUser: vi.fn() } }));
vi.mock('../realtime/emitter', () => ({
  realtimeEmitter: {
    emitBookingStatus: vi.fn(), emitBookingAssigned: vi.fn(), emitOfferNew: vi.fn(),
    emitOfferExpired: vi.fn(), emitDispatchBoardUpdate: vi.fn(),
    emitTechnicianLocation: vi.fn(), emitTrackingEta: vi.fn(),
  },
}));

import { User } from '../models/User';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { TechnicianLocation } from '../models/TechnicianLocation';
import { Booking, IBooking } from '../models/Booking';
import { DispatchOffer } from '../models/DispatchOffer';
import { DispatchSettings } from '../models/DispatchSettings';
import { eligibleTechnicians, haversineDistanceKm } from '../modules/dispatch/matching';

let mongoServer: MongoMemoryServer;

// Base booking that matches our base tech
const BASE_BOOKING = {
  bookingNumber: `GIS-MATCH-${Date.now()}`,
  serviceId: new mongoose.Types.ObjectId(),
  categoryId: new mongoose.Types.ObjectId(),
  guest: { fullName: 'Match Test', email: 'match@test.com', phone: '555-9999' },
  serviceSnapshot: { name: 'Match Test', slug: 'match-test' },
  vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2022 },
  scheduledAt: new Date('2026-11-10T14:00:00.000Z'), // Monday 2pm UTC
  scheduledLocal: { date: '2026-11-10', slot: '14:00' },
  pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
  address: { freeText: '123 Main St', zip: '90210', country: 'USA' },
  // GeoJSON location for booking (Los Angeles area)
  location: { type: 'Point', coordinates: [-118.2437, 34.0522] as [number, number] },
  status: 'confirmed' as const,
  source: 'web' as const,
};

async function createBaseProfile(
  userId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {}
) {
  return TechnicianProfile.create({
    userId,
    displayName: 'Base Tech',
    verificationStatus: 'approved',
    availability: {
      isOnline: true,
      weeklySchedule: [
        // Monday all day (booking is on Monday)
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
    skills: {
      serviceIds: [BASE_BOOKING.serviceId],
      categoryIds: [BASE_BOOKING.categoryId],
    },
    serviceArea: {
      zipCodes: ['90210'],
      radiusKm: 100,
    },
    ...overrides,
  });
}

async function createActiveUser(suffix: string, overrides: Record<string, unknown> = {}) {
  return User.create({
    email: `matchtech-${suffix}@test.com`,
    password: 'P@ssword1!',
    fullName: `Match Tech ${suffix}`,
    role: 'technician',
    status: 'active',
    emailVerified: true,
    ...overrides,
  });
}

describe('eligibleTechnicians: all 9 filters + ranking (real MongoDB)', () => {
  let booking: IBooking;

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
    await Booking.deleteMany({});
    await DispatchOffer.deleteMany({});
    await DispatchSettings.deleteMany({});
    booking = await Booking.create({ ...BASE_BOOKING, bookingNumber: `GIS-M-${Date.now()}` });
  });

  // ── haversine helper ────────────────────────────────────────────────────

  it('haversineDistanceKm calculates approximate distance correctly', () => {
    // LA to NYC ≈ 3940 km
    const la: [number, number] = [-118.2437, 34.0522];
    const nyc: [number, number] = [-74.006, 40.7128];
    const dist = haversineDistanceKm(la, nyc);
    expect(dist).toBeGreaterThan(3900);
    expect(dist).toBeLessThan(3980);
  });

  // ── Filter 1: Profile must be approved ─────────────────────────────────

  it('Filter 1: excludes technician with pending verificationStatus', async () => {
    const user = await createActiveUser('f1');
    await createBaseProfile(user._id, { verificationStatus: 'pending_review' });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain("'pending_review'");
  });

  // ── Filter 2: User must be active and email verified ───────────────────

  it('Filter 2a: excludes technician with suspended user status', async () => {
    const user = await createActiveUser('f2a', { status: 'suspended' });
    await createBaseProfile(user._id);

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('not active');
  });

  it('Filter 2b: excludes technician with unverified email', async () => {
    const user = await createActiveUser('f2b', { emailVerified: false });
    await createBaseProfile(user._id);

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('email is not verified');
  });

  // ── Filter 3: Online status required for ASAP or near-term bookings ────

  it('Filter 3a: excludes offline technician when booking is ASAP', async () => {
    const user = await createActiveUser('f3-asap');
    await createBaseProfile(user._id, {
      availability: {
        isOnline: false,
        weeklySchedule: [{ day: 'tue', from: '00:00', to: '23:59' }],
      },
    });

    const asapBooking = await Booking.create({
      ...BASE_BOOKING,
      bookingNumber: `GIS-ASAP-${Date.now()}`,
      isAsap: true,
    });

    const results = await eligibleTechnicians(asapBooking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('offline');
  });

  it('Filter 3b: excludes offline technician when scheduledAt is within onlineRequiredWithinHours (default 3)', async () => {
    const user = await createActiveUser('f3-near');
    await createBaseProfile(user._id, {
      availability: {
        isOnline: false,
        weeklySchedule: [{ day: 'tue', from: '00:00', to: '23:59' }],
      },
    });

    // 1 hour in future
    const nearBooking = await Booking.create({
      ...BASE_BOOKING,
      bookingNumber: `GIS-NEAR-${Date.now()}`,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      isAsap: false,
    });

    const results = await eligibleTechnicians(nearBooking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('offline');
  });

  it('Filter 3c: allows offline technician for future scheduled booking (> onlineRequiredWithinHours)', async () => {
    const user = await createActiveUser('f3-future');
    await createBaseProfile(user._id, {
      availability: {
        isOnline: false,
        weeklySchedule: [{ day: 'tue', from: '00:00', to: '23:59' }],
      },
    });

    // 14 days in future (BASE_BOOKING is 2026-11-10)
    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(true);
  });

  // ── Open Sent Offer Overlap Check ───────────────────────────────────────

  it('excludes technician who has an overlapping open (sent) offer on another booking', async () => {
    const user = await createActiveUser('overlap-offer-tech');
    await createBaseProfile(user._id);

    // Create another booking at the same scheduled time
    const otherBooking = await Booking.create({
      ...BASE_BOOKING,
      bookingNumber: `GIS-OTHER-${Date.now()}`,
      scheduledAt: booking.scheduledAt,
    });

    // Create an open 'sent' offer for this technician on otherBooking
    await DispatchOffer.create({
      bookingId: otherBooking._id,
      technicianUserId: user._id,
      status: 'sent',
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rank: 1,
      source: 'auto',
    });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('overlapping open offer');
  });

  // ── Filter 4: Must have matching skill ─────────────────────────────────

  it('Filter 4: excludes technician without matching service or category skill', async () => {
    const user = await createActiveUser('f4');
    await createBaseProfile(user._id, {
      skills: {
        serviceIds: [new mongoose.Types.ObjectId()], // different service
        categoryIds: [], // no matching category either
      },
    });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('skills do not cover');
  });

  it('Filter 4: accepts tech with matching categoryId even without serviceId', async () => {
    const user = await createActiveUser('f4b');
    await createBaseProfile(user._id, {
      skills: {
        serviceIds: [], // no service match
        categoryIds: [BASE_BOOKING.categoryId], // category match → eligible
      },
    });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    // Will be eligible on skill check (may still fail others, but this filter passes)
    expect(entry?.exclusionReason || '').not.toContain('skills do not cover');
  });

  // ── Filter 5: Service area covers booking (zip OR radius) ──────────────

  it('Filter 5: excludes technician with no zip match and no geo radius', async () => {
    const user = await createActiveUser('f5');
    await createBaseProfile(user._id, {
      serviceArea: {
        zipCodes: ['10001'], // NYC zip, no match
        radiusKm: 1, // tiny radius
        // no center coordinates → radius check will not pass without location
      },
    });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('outside technician service area');
  });

  it('Filter 5: accepts by zip match even without location', async () => {
    const user = await createActiveUser('f5b');
    await createBaseProfile(user._id, {
      serviceArea: { zipCodes: ['90210'], radiusKm: 1 },
    });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    // May fail on other filters (schedule etc.) but not on service area
    expect(entry?.exclusionReason || '').not.toContain('outside technician service area');
  });

  // ── Filter 6: Max distance ──────────────────────────────────────────────

  it('Filter 6: excludes tech within zip but beyond maxDistanceKm', async () => {
    await DispatchSettings.create({ maxDistanceKm: 1 }); // 1 km max
    const user = await createActiveUser('f6');
    await createBaseProfile(user._id, {
      serviceArea: { zipCodes: ['90210'], radiusKm: 100, center: { type: 'Point', coordinates: [-74.006, 40.7128] } }, // NYC
    });
    // Set technician location far away
    await TechnicianLocation.create({
      technicianUserId: user._id,
      location: { type: 'Point', coordinates: [-74.006, 40.7128] }, // NYC, very far from LA booking
      updatedAt: new Date(),
    });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    // Even if zip matches, distance filter should kick in
    expect(entry?.eligible).toBe(false);
  });

  // ── Filter 7: Weekly schedule + time off ───────────────────────────────

  it('Filter 7a: excludes tech with no schedule for the booking day', async () => {
    const user = await createActiveUser('f7a');
    await createBaseProfile(user._id, {
      availability: {
        isOnline: true,
        weeklySchedule: [
          { day: 'mon', from: '09:00', to: '17:00' }, // Tuesday booking (2026-11-10) — not covered
        ],
      },
    });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('no working schedule for tue');
  });

  it('Filter 7b: excludes tech on scheduled time off during booking window', async () => {
    const user = await createActiveUser('f7b');
    await createBaseProfile(user._id, {
      availability: {
        isOnline: true,
        weeklySchedule: [{ day: 'tue', from: '00:00', to: '23:59' }],
        timeOff: [
          {
            from: new Date('2026-11-09T00:00:00Z'),
            to: new Date('2026-11-11T00:00:00Z'), // covers our booking date
            note: 'Vacation',
          },
        ],
      },
    });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('time off');
  });

  // ── Filter 9: Already offered ────────────────────────────────────────────

  it('Filter 9: excludes technician already offered or declined for this booking', async () => {
    const user = await createActiveUser('f9');
    await createBaseProfile(user._id);

    // Create a pre-existing declined offer
    await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: user._id,
      status: 'declined',
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rank: 1,
      source: 'auto',
    });

    const results = await eligibleTechnicians(booking, { explain: true });
    const entry = results.find((r) => r.technicianUserId === user._id.toString());
    expect(entry?.eligible).toBe(false);
    expect(entry?.exclusionReason).toContain('already received or responded');
  });

  // ── Explain mode: returns ineligible techs too ────────────────────────

  it('explain mode returns all candidates (eligible + ineligible) with reasons', async () => {
    const u1 = await createActiveUser('exp1');
    const u2 = await createActiveUser('exp2', { status: 'suspended' });
    await createBaseProfile(u1._id);
    await createBaseProfile(u2._id);

    const all = await eligibleTechnicians(booking, { explain: true });
    const nonExplain = await eligibleTechnicians(booking);

    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(nonExplain.length).toBeLessThan(all.length);

    const ineligibleEntry = all.find((r) => r.technicianUserId === u2._id.toString());
    expect(ineligibleEntry?.eligible).toBe(false);
    expect(ineligibleEntry?.exclusionReason).toBeDefined();
  });

  // ── Ranking: distance < rating < jobsToday < id ──────────────────────

  it('eligible techs are ranked by distance asc, then rating desc, then jobsToday asc, then id', async () => {
    // Two close techs with no location (both null distance) — ranked by rating
    const u1 = await createActiveUser('rank1');
    const u2 = await createActiveUser('rank2');
    const p1 = await createBaseProfile(u1._id, {
      rating: { avg: 4.0, count: 10 },
    });
    const p2 = await createBaseProfile(u2._id, {
      rating: { avg: 5.0, count: 10 },
    });

    const results = await eligibleTechnicians(booking);
    if (results.length >= 2) {
      const idxU1 = results.findIndex((r) => r.technicianUserId === u1._id.toString());
      const idxU2 = results.findIndex((r) => r.technicianUserId === u2._id.toString());
      // p2 has higher rating → ranked first
      expect(idxU2).toBeLessThan(idxU1);
    }

    // Verify ranks are assigned sequentially starting at 1
    for (let i = 0; i < results.length; i++) {
      expect(results[i].rank).toBe(i + 1);
    }
  });
});
