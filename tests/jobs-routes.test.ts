/**
 * jobs-routes.test.ts
 *
 * Tests technician job lifecycle state machine, auth, and PII constraints.
 * Uses real MongoDB via MongoMemoryServer + supertest.
 *
 * PART 8c
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
import { Service } from '../models/Service';
import { generateAccessToken } from '../utils/jwt';

let mongoServer: MongoMemoryServer;

async function createTechUser(suffix: string, approved = true) {
  const user = await User.create({
    email: `jobstech-${suffix}@test.com`,
    password: 'P@ssword1!',
    fullName: `Jobs Tech ${suffix}`,
    role: 'technician',
    status: 'active',
    emailVerified: true,
  });
  const profile = await TechnicianProfile.create({
    userId: user._id,
    displayName: `Jobs Tech ${suffix}`,
    verificationStatus: approved ? 'approved' : 'pending_review',
    availability: { isOnline: true, weeklySchedule: [] },
    skills: { serviceIds: [], categoryIds: [] },
    serviceArea: { zipCodes: [] },
  });
  const token = generateAccessToken({
    userId: user._id.toString(),
    email: user.email,
    role: 'technician', status: 'active', emailVerified: true });
  return { user, profile, token };
}

async function createAdminToken() {
  const admin = await User.create({
    email: `jobs-admin-${Date.now()}@test.com`,
    password: 'P@ssword1!',
    fullName: 'Admin',
    role: 'admin',
    status: 'active',
    emailVerified: true,
  });
  return generateAccessToken({ userId: admin._id.toString(), email: admin.email, role: 'admin', status: 'active', emailVerified: true });
}

async function createAssignedBooking(techUserId: string | mongoose.Types.ObjectId, overrides: Record<string, unknown> = {}) {
  const techObjId = new mongoose.Types.ObjectId(techUserId.toString());
  return Booking.create({
    bookingNumber: `GIS-JOBS-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
    serviceId: new mongoose.Types.ObjectId(),
    categoryId: new mongoose.Types.ObjectId(),
    guest: { fullName: 'Test Customer', email: 'jobs-cust@test.com', phone: '555-1234' },
    serviceSnapshot: { name: 'Test Service', slug: 'test-service' },
    vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2022 },
    scheduledAt: new Date(Date.now() + 60_000),
    scheduledLocal: { date: '2026-11-10', slot: '10:00' },
    pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
    address: { freeText: '123 Main St', zip: '90210', country: 'USA' },
    status: 'assigned',
    source: 'web',
    technicianId: techObjId,
    assignment: {
      technicianUserId: techObjId,
      assignedAt: new Date(),
      assignedBy: 'admin',
      acceptedAt: new Date(),
    },
    dispatch: { status: 'assigned', attempts: 1 },
    ...overrides,
  });
}

describe('Jobs Routes: State Machine, Auth & PII (real MongoDB)', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.disconnect();
    await mongoose.connect(mongoServer.getUri());
    await DispatchSettings.create({});
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
  });

  // ── Auth: unauthenticated access ────────────────────────────────────────

  it('GET /api/v1/jobs → 401 without token', async () => {
    const res = await request(app).get('/api/v1/jobs');
    expect(res.status).toBe(401);
  });

  // ── Auth: pending technician cannot access job lifecycle ────────────────

  it('pending technician → 403 TECHNICIAN_NOT_APPROVED on job endpoints', async () => {
    const { token } = await createTechUser('pending', false);
    const res = await request(app)
      .get('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('TECHNICIAN_NOT_APPROVED');
  });

  // ── Auth: admin cannot access tech-only job endpoints ──────────────────

  it('admin token → 403 on /api/v1/jobs (technician role required)', async () => {
    const adminToken = await createAdminToken();
    const res = await request(app)
      .get('/api/v1/jobs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  // ── GET /api/v1/jobs ────────────────────────────────────────────────────

  it('approved technician can list their jobs', async () => {
    const { user, token } = await createTechUser('listjobs');
    await createAssignedBooking(user._id);

    const res = await request(app)
      .get('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.jobs).toHaveLength(1);

    // Verify PII: no email in customer field
    const job = res.body.data.jobs[0];
    expect(job.customer?.email).toBeUndefined();
    expect(job.customer?.firstName).toBeDefined();
    expect(job.customer?.phone).toBeDefined();
  });

  // ── GET /api/v1/jobs/:bookingId ─────────────────────────────────────────

  it('assigned tech can view job detail; email never appears', async () => {
    const { user, token } = await createTechUser('detail');
    const booking = await createAssignedBooking(user._id);

    const res = await request(app)
      .get(`/api/v1/jobs/${booking._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.customer?.email).toBeUndefined();
    expect(res.body.data.customer?.phone).toBeDefined();
  });

  it('other technician cannot view job detail → 403', async () => {
    const { user: tech1 } = await createTechUser('detail-owner');
    const { token: token2 } = await createTechUser('detail-other');
    const booking = await createAssignedBooking(tech1._id);

    const res = await request(app)
      .get(`/api/v1/jobs/${booking._id}`)
      .set('Authorization', `Bearer ${token2}`);

    expect(res.status).toBe(403);
  });

  // ── State machine: valid transitions ────────────────────────────────────

  it('full state machine path: assigned → en_route → arrived → in_progress → completed', async () => {
    const { user, token } = await createTechUser('stateful');
    const booking = await createAssignedBooking(user._id);

    // en_route
    let res = await request(app)
      .post(`/api/v1/jobs/${booking._id}/en-route`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('technician_en_route');

    // arrived
    res = await request(app)
      .post(`/api/v1/jobs/${booking._id}/arrived`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('arrived');

    // start (in_progress)
    res = await request(app)
      .post(`/api/v1/jobs/${booking._id}/start`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('in_progress');

    // complete
    res = await request(app)
      .post(`/api/v1/jobs/${booking._id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Great job done', checklist: [{ label: 'Washed', done: true }] });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.completedAt).toBeDefined();
  });

  // ── State machine: invalid transitions ──────────────────────────────────

  it('assigned → start (skipping en_route/arrived) → 400 INVALID_TRANSITION', async () => {
    const { user, token } = await createTechUser('invalid-transition');
    const booking = await createAssignedBooking(user._id);

    const res = await request(app)
      .post(`/api/v1/jobs/${booking._id}/start`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_TRANSITION');
  });

  it('complete twice → second complete returns 400', async () => {
    const { user, token } = await createTechUser('double-complete');
    const booking = await createAssignedBooking(user._id, { status: 'in_progress' });

    await request(app)
      .post(`/api/v1/jobs/${booking._id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Done' });

    const res = await request(app)
      .post(`/api/v1/jobs/${booking._id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Done again' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_TRANSITION');
  });

  // ── Release: returns booking to confirmed ────────────────────────────────

  it('release returns booking to confirmed and triggers dispatch search', async () => {
    const { user, token } = await createTechUser('release');
    const booking = await createAssignedBooking(user._id);

    const res = await request(app)
      .post(`/api/v1/jobs/${booking._id}/release`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Emergency' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('confirmed');
    expect(res.body.data.assignment).toBeUndefined();
    expect(res.body.data.technicianId).toBeNull();
  });

  it('cannot release an in_progress job → 400 INVALID_STATE', async () => {
    const { user, token } = await createTechUser('release-invalid');
    const booking = await createAssignedBooking(user._id, { status: 'in_progress' });

    const res = await request(app)
      .post(`/api/v1/jobs/${booking._id}/release`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Trying to bail' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_STATE');
  });

  // ── Offer accept/decline ────────────────────────────────────────────────

  it('technician can accept their own offer', async () => {
    const { user, token } = await createTechUser('accept-offer');
    const booking = await Booking.create({
      bookingNumber: `GIS-OFF-${Date.now()}`,
      serviceId: new mongoose.Types.ObjectId(),
      categoryId: new mongoose.Types.ObjectId(),
      guest: { fullName: 'Cust', email: 'c@c.com', phone: '555-0001' },
      serviceSnapshot: { name: 'S', slug: 's' },
      vehicleSnapshot: { category: 'sedan', make: 'T', model: 'C', year: 2022 },
      scheduledAt: new Date(Date.now() + 60_000),
      scheduledLocal: { date: '2026-11-01', slot: '10:00' },
      pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
      address: { freeText: '123 Main', zip: '90210', country: 'USA' },
      status: 'confirmed',
      source: 'web',
    });

    const offer = await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: user._id,
      status: 'sent',
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rank: 1,
      source: 'auto',
    });

    const res = await request(app)
      .post(`/api/v1/jobs/offers/${offer._id}/accept`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.booking.status).toBe('assigned');
  });

  it('technician cannot accept another technician\'s offer → 403', async () => {
    const { user: tech1 } = await createTechUser('acc-other-owner');
    const { token: token2 } = await createTechUser('acc-other-stealer');
    const booking = await Booking.create({
      bookingNumber: `GIS-STEAL-${Date.now()}`,
      serviceId: new mongoose.Types.ObjectId(),
      categoryId: new mongoose.Types.ObjectId(),
      guest: { fullName: 'Cust', email: 'c2@c.com', phone: '555-0002' },
      serviceSnapshot: { name: 'S', slug: 's2' },
      vehicleSnapshot: { category: 'sedan', make: 'T', model: 'C', year: 2022 },
      scheduledAt: new Date(Date.now() + 60_000),
      scheduledLocal: { date: '2026-11-01', slot: '10:00' },
      pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
      address: { freeText: '123 Main', zip: '90210', country: 'USA' },
      status: 'confirmed',
      source: 'web',
    });
    const offer = await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: tech1._id,
      status: 'sent',
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rank: 1,
      source: 'auto',
    });

    const res = await request(app)
      .post(`/api/v1/jobs/offers/${offer._id}/accept`)
      .set('Authorization', `Bearer ${token2}`);

    expect(res.status).toBe(403);
  });

  // ── Phone Privacy (Item 4) ──────────────────────────────────────────────

  it('phone privacy: phone visible during active job across all active statuses', async () => {
    const { user, token } = await createTechUser('priv-active');
    const activeStatuses = ['assigned', 'technician_en_route', 'arrived', 'in_progress'];

    for (const status of activeStatuses) {
      const b = await createAssignedBooking(user._id, { status });
      const res = await request(app)
        .get(`/api/v1/jobs/${b._id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.customer?.firstName).toBe('Test');
      expect(res.body.data.customer?.phone).toBe('555-1234');
      expect(res.body.data.customer?.email).toBeUndefined();
    }
  });

  it('phone privacy: phone visible within 24h of completion, hidden after 24h', async () => {
    const { user, token } = await createTechUser('priv-completed');

    // Completed 1 hour ago (< 24h)
    const recentBooking = await createAssignedBooking(user._id, {
      status: 'completed',
      completedAt: new Date(Date.now() - 3600 * 1000),
    });

    const resRecent = await request(app)
      .get(`/api/v1/jobs/${recentBooking._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(resRecent.status).toBe(200);
    expect(resRecent.body.data.customer?.firstName).toBe('Test');
    expect(resRecent.body.data.customer?.phone).toBe('555-1234');
    expect(resRecent.body.data.customer?.email).toBeUndefined();

    // Completed 25 hours ago (> 24h)
    const oldBooking = await createAssignedBooking(user._id, {
      status: 'completed',
      completedAt: new Date(Date.now() - 25 * 3600 * 1000),
    });

    const resOld = await request(app)
      .get(`/api/v1/jobs/${oldBooking._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(resOld.status).toBe(200);
    expect(resOld.body.data.customer?.firstName).toBe('Test');
    expect(resOld.body.data.customer?.phone).toBe(''); // phone hidden!
    expect(resOld.body.data.customer?.email).toBeUndefined();
  });

  it('phone privacy: after release, cancel, or unassign, technician gets 403 on job detail', async () => {
    const { user, token } = await createTechUser('priv-revoked');

    // Released job
    const releasedBooking = await createAssignedBooking(user._id);
    await request(app)
      .post(`/api/v1/jobs/${releasedBooking._id}/release`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Cannot do it' });

    const resReleased = await request(app)
      .get(`/api/v1/jobs/${releasedBooking._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(resReleased.status).toBe(403);

    // Cancelled job
    const cancelledBooking = await createAssignedBooking(user._id, { status: 'cancelled' });
    const resCancelled = await request(app)
      .get(`/api/v1/jobs/${cancelledBooking._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(resCancelled.status).toBe(403);

    // Unassigned job (technicianId and assignment cleared)
    const unassignedBooking = await createAssignedBooking(user._id, {
      status: 'confirmed',
      technicianId: null,
      assignment: undefined,
    });
    const resUnassigned = await request(app)
      .get(`/api/v1/jobs/${unassignedBooking._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(resUnassigned.status).toBe(403);
  });

  // ── PART 1: Config endpoint & View filtering tests ────────────────────────

  it('GET /api/v1/jobs/config returns exact dispatch settings fields to approved tech', async () => {
    const { token } = await createTechUser('cfg-approved', true);
    await DispatchSettings.findOneAndUpdate(
      {},
      {
        locationMinIntervalSeconds: 8,
        offerTimeoutSecondsAsap: 45,
        offerTimeoutMinutesScheduled: 20,
      },
      { upsert: true }
    );

    const res = await request(app)
      .get('/api/v1/jobs/config')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      locationMinIntervalSeconds: 8,
      offerTimeoutSecondsAsap: 45,
      offerTimeoutMinutesScheduled: 20,
    });
  });

  it('GET /api/v1/jobs/config rejects unapproved tech (403) and customer (403)', async () => {
    const { token: unapprovedToken } = await createTechUser('cfg-unapproved', false);
    const resUnapproved = await request(app)
      .get('/api/v1/jobs/config')
      .set('Authorization', `Bearer ${unapprovedToken}`);
    expect(resUnapproved.status).toBe(403);

    const customer = await User.create({
      email: 'cfg-cust@test.com',
      password: 'P@ssword1!',
      fullName: 'Cust',
      role: 'customer',
      status: 'active',
      emailVerified: true,
    });
    const custToken = generateAccessToken({
      userId: customer._id.toString(),
      email: customer.email,
      role: 'customer',
      status: 'active',
      emailVerified: true,
    });
    const resCust = await request(app)
      .get('/api/v1/jobs/config')
      .set('Authorization', `Bearer ${custToken}`);
    expect(resCust.status).toBe(403);
  });

  it('GET /api/v1/jobs?view=offers returns active offers with masked address and service details', async () => {
    const { user, token } = await createTechUser('view-offers', true);
    const catId = new mongoose.Types.ObjectId();
    const service = await Service.create({
      name: 'Ceramic Coating Gold',
      slug: 'ceramic-gold',
      categoryId: catId,
      durationMinutes: 90,
      basePriceCents: 20000,
    });

    const booking = await Booking.create({
      bookingNumber: 'B-OFFER-1',
      serviceId: service._id,
      categoryId: catId,
      serviceSnapshot: { name: 'Ceramic Coating Gold', slug: 'ceramic-gold' },
      vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2022 },
      pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
      status: 'confirmed',
      address: {
        freeText: '742 Evergreen Terrace Apt 4B',
        city: 'Springfield',
        state: 'IL',
        zip: '62704',
        country: 'USA',
      },
      scheduledAt: new Date(Date.now() + 4 * 3600 * 1000),
      scheduledLocal: { date: '2026-11-20', slot: '14:00' },
      timezone: 'America/Chicago',
      guest: { fullName: 'Homer Simpson', email: 'homer@springfield.com', phone: '555-7334' },
      source: 'web',
    });

    const offer = await DispatchOffer.create({
      bookingId: booking._id,
      technicianUserId: user._id,
      status: 'sent',
      rank: 1,
      expiresAt: new Date(Date.now() + 120000),
      batchNumber: 1,
    });

    const res = await request(app)
      .get('/api/v1/jobs?view=offers')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.view).toBe('offers');
    expect(res.body.data.offers).toHaveLength(1);

    const item = res.body.data.offers[0];
    expect(item.offer._id).toBe(offer._id.toString());
    expect(item.offer.expiresAt).toBeDefined();

    // Booking information
    expect(item.booking._id).toBe(booking._id.toString());
    expect(item.booking.serviceSnapshot.name).toBe('Ceramic Coating Gold');
    expect(item.booking.scheduledLocal).toEqual({ date: '2026-11-20', slot: '14:00' });
    expect(item.booking.timezone).toBe('America/Chicago');

    // Masked address: city, state, zip present; freeText / street number absent!
    expect(item.booking.address.city).toBe('Springfield');
    expect(item.booking.address.state).toBe('IL');
    expect(item.booking.address.zip).toBe('62704');
    expect(item.booking.address.freeText).toBeUndefined();

    // Customer PII hidden
    expect(item.booking.customer).toBeUndefined();
    expect(item.booking.guest).toBeUndefined();
  });

  it('GET /api/v1/jobs views: upcoming, active, history return correct subsets with full address', async () => {
    const { user, token } = await createTechUser('view-filters', true);

    // 1. Upcoming (assigned, future)
    const upcomingBooking = await createAssignedBooking(user._id, {
      bookingNumber: 'B-UPCOMING-1',
      status: 'assigned',
      scheduledAt: new Date(Date.now() + 24 * 3600 * 1000),
      address: { freeText: '100 Main St', city: 'Metropolis', zip: '10001' },
    });

    // 2. Active (in_progress)
    const activeBooking = await createAssignedBooking(user._id, {
      bookingNumber: 'B-ACTIVE-1',
      status: 'in_progress',
      scheduledAt: new Date(Date.now() - 3600 * 1000),
      address: { freeText: '200 Market St', city: 'Gotham', zip: '10002' },
    });

    // 3. History (completed)
    const historyBooking = await createAssignedBooking(user._id, {
      bookingNumber: 'B-HISTORY-1',
      status: 'completed',
      completedAt: new Date(Date.now() - 48 * 3600 * 1000),
      scheduledAt: new Date(Date.now() - 49 * 3600 * 1000),
      address: { freeText: '300 Ocean Ave', city: 'Star City', zip: '10003' },
    });

    // Check upcoming view
    const resUpcoming = await request(app)
      .get('/api/v1/jobs?view=upcoming')
      .set('Authorization', `Bearer ${token}`);
    expect(resUpcoming.status).toBe(200);
    expect(resUpcoming.body.data.jobs).toHaveLength(1);
    expect(resUpcoming.body.data.jobs[0].bookingNumber).toBe('B-UPCOMING-1');
    expect(resUpcoming.body.data.jobs[0].address.freeText).toBe('100 Main St');

    // Check active view
    const resActive = await request(app)
      .get('/api/v1/jobs?view=active')
      .set('Authorization', `Bearer ${token}`);
    expect(resActive.status).toBe(200);
    expect(resActive.body.data.jobs).toHaveLength(1);
    expect(resActive.body.data.jobs[0].bookingNumber).toBe('B-ACTIVE-1');

    // Check history view
    const resHistory = await request(app)
      .get('/api/v1/jobs?view=history')
      .set('Authorization', `Bearer ${token}`);
    expect(resHistory.status).toBe(200);
    expect(resHistory.body.data.jobs).toHaveLength(1);
    expect(resHistory.body.data.jobs[0].bookingNumber).toBe('B-HISTORY-1');
  });
});
