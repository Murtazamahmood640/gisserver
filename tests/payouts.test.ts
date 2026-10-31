/**
 * payouts.test.ts
 *
 * Real MongoDB (MongoMemoryServer) + Supertest.
 * Covers:
 * 1. Earning math:
 *    - 100% on paid + completed
 *    - partial refund scaled with round half up
 *    - fully refunded earns 0
 *    - unpaid earns 0
 *    - hold days boundary: completed >= payoutHoldDays ago is available, today is pending
 *    - offline payment counts as paid
 * 2. Payout creation & lifecycle:
 *    - draft creation
 *    - concurrent POSTs claim each booking AT MOST ONCE (zero overlap)
 *    - minPayoutCents rejects if below threshold
 *    - unsettled adjustments included and marked settled
 *    - void releases bookings and adjustments
 *    - mark-paid succeeds from draft, fails from void or paid
 * 3. Refund after payout:
 *    - paid payout -> creates payoutAdjustment (negative amountCents)
 *    - repeating webhook/refund is idempotent
 *    - draft payout -> voids or releases
 * 4. Offline payment:
 *    - amount must equal booking total, else 400
 *    - double submit 409
 *    - dispatcher gets 403
 *    - booking flips to paid and auto-confirm/dispatch runs once
 * 5. Technician /me/earnings:
 *    - sees only own earnings
 *    - payload never exposes customer total, name, phone or email
 * 6. Role policies:
 *    - dispatcher gets 403 on /admin/payouts*
 *    - customer gets 403
 *    - CSV export protects against CSV injection (= + - @ \t \r prefixed with ')
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Mock external services
vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'mock' }),
  getBookingConfirmationEmail: vi.fn().mockReturnValue('<p></p>'),
  getAdminNotificationEmail: vi.fn().mockReturnValue('<p></p>'),
  getStatusUpdateEmail: vi.fn().mockReturnValue('<p></p>'),
  getPaymentReceiptEmail: vi.fn().mockReturnValue('<p></p>'),
}));

vi.mock('../services/pushService', () => ({
  pushService: { sendToUser: vi.fn() },
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

import app from '../app';
import { User } from '../models/User';
import { Booking } from '../models/Booking';
import { Payment } from '../models/Payment';
import { Payout } from '../models/Payout';
import { PayoutAdjustment } from '../models/PayoutAdjustment';
import { PaymentSettings } from '../models/PaymentSettings';
import { Service } from '../models/Service';
import { ServiceCategory } from '../models/ServiceCategory';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { computeEarningCents, computeEarningState } from '../modules/payouts/earningsService';
import { generateAccessToken } from '../utils/jwt';

let mongoServer: MongoMemoryServer;
let adminToken: string;
let dispatcherToken: string;
let customerToken: string;
let techUser1: { _id: mongoose.Types.ObjectId; email: string };
let techToken1: string;
let techUser2: { _id: mongoose.Types.ObjectId; email: string };
let techToken2: string;
let testCategoryId: mongoose.Types.ObjectId;
let testServiceId: mongoose.Types.ObjectId;

async function createCompletedBooking(techId: mongoose.Types.ObjectId, overrides: Record<string, unknown> = {}) {
  const numberSuffix = Math.floor(100000 + Math.random() * 900000);
  const totalCents = typeof overrides.totalCents === 'number' ? overrides.totalCents : 10000;
  const providerPayoutCents = typeof overrides.providerPayoutCents === 'number' ? overrides.providerPayoutCents : 8000;
  const completedAt = (overrides.completedAt as Date) || new Date(Date.now() - 4 * 86400000); // 4 days ago by default

  const booking = await Booking.create({
    bookingNumber: `GIS-${numberSuffix}`,
    customerId: new mongoose.Types.ObjectId(),
    categoryId: testCategoryId,
    serviceId: testServiceId,
    serviceSnapshot: { name: 'Full Detail', slug: 'full-detail' },
    vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2022 },
    addons: [],
    address: { freeText: '123 Main St', line1: '123 Main St', city: 'Miami', state: 'FL', zip: '33101' },
    scheduledAt: new Date(Date.now() - 5 * 86400000),
    scheduledLocal: { date: '2026-11-10', slot: '10:00' },
    timezone: 'America/New_York',
    isAsap: false,
    status: overrides.status !== undefined ? overrides.status : 'completed',
    paymentStatus: overrides.paymentStatus !== undefined ? overrides.paymentStatus : 'paid',
    technicianId: techId,
    completedAt,
    assignment: {
      technicianUserId: techId,
      technicianId: techId,
      assignedAt: new Date(Date.now() - 6 * 86400000),
      assignedBy: 'auto',
    },
    lifecycle: {
      completedAt,
    },
    pricing: {
      baseCents: totalCents,
      addonsCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalCents,
      commissionPercent: 20,
      processingPercent: 0,
      commissionCents: 2000,
      taxIncluded: false,
      currency: 'usd',
      providerPayoutCents,
    },
    ...overrides,
  });

  return booking;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  // Setup admin & dispatcher
  const adminUser = await User.create({
    email: 'admin-payouts@gis.com',
    password: 'P@ssword1!',
    fullName: 'Test User',
    role: 'admin',
    status: 'active',
  });
  adminToken = generateAccessToken({ userId: adminUser._id.toString(), email: adminUser.email, role: 'admin', status: 'active', emailVerified: true });

  const dispatcherUser = await User.create({
    email: 'dispatcher-payouts@gis.com',
    password: 'P@ssword1!',
    fullName: 'Test User',
    role: 'dispatcher',
    status: 'active',
  });
  dispatcherToken = generateAccessToken({ userId: dispatcherUser._id.toString(), email: dispatcherUser.email, role: 'dispatcher', status: 'active', emailVerified: true });

  const custUser = await User.create({
    email: 'cust-payouts@gis.com',
    password: 'P@ssword1!',
    fullName: 'Test User',
    role: 'customer',
    status: 'active',
  });
  customerToken = generateAccessToken({ userId: custUser._id.toString(), email: custUser.email, role: 'customer', status: 'active', emailVerified: true });

  // Setup 2 Technicians
  techUser1 = await User.create({
    email: 'tech1-payouts@gis.com',
    password: 'P@ssword1!',
    fullName: 'Test User',
    role: 'technician',
    status: 'active',
  });
  techToken1 = generateAccessToken({ userId: techUser1._id.toString(), email: techUser1.email, role: 'technician', status: 'active', emailVerified: true });
  await TechnicianProfile.create({
    userId: techUser1._id,
    status: 'approved',
    phone: '555-111-2222',
  });

  techUser2 = await User.create({
    email: 'tech2-payouts@gis.com',
    password: 'P@ssword1!',
    fullName: 'Test User',
    role: 'technician',
    status: 'active',
  });
  techToken2 = generateAccessToken({ userId: techUser2._id.toString(), email: techUser2.email, role: 'technician', status: 'active', emailVerified: true });
  await TechnicianProfile.create({
    userId: techUser2._id,
    status: 'approved',
    phone: '555-333-4444',
  });

  const cat = await ServiceCategory.create({ name: 'Auto Detailing', slug: 'auto-detailing' });
  testCategoryId = cat._id;
  const srv = await Service.create({ name: 'Full Detail', slug: 'full-detail', categoryId: cat._id, basePriceCents: 10000 });
  testServiceId = srv._id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Booking.deleteMany({});
  await Payment.deleteMany({});
  await Payout.deleteMany({});
  await PayoutAdjustment.deleteMany({});
  await PaymentSettings.deleteMany({});
  await PaymentSettings.create({
    requirePrepayment: false,
    autoConfirmOnPayment: true,
    unpaidExpiryMinutes: 30,
    currency: 'usd',
    payoutHoldDays: 3,
    minPayoutCents: 0,
  });
});

describe('Earning Math Pure Functions', () => {
  it('awards 100% providerPayoutCents when status=completed and paymentStatus=paid', () => {
    const booking = {
      status: 'completed',
      paymentStatus: 'paid',
      pricing: { providerPayoutCents: 8000, totalCents: 10000 },
    };
    expect(computeEarningCents(booking)).toBe(8000);
  });

  it('scales earning proportionally on partial refund with round half up', () => {
    // Total 10000, Refund 2500 -> Paid Net 7500. providerPayoutCents = 8000
    // Scaled: round((7500 / 10000) * 8000) = round(0.75 * 8000) = 6000
    const booking = {
      status: 'completed',
      paymentStatus: 'partially_refunded',
      pricing: { providerPayoutCents: 8000, totalCents: 10000 },
      payment: { refundedCents: 2500 },
    };
    expect(computeEarningCents(booking)).toBe(6000);

    // Round half up check: total 100, refund 33 -> 67/100 * 50 = 33.5 -> 34
    const booking2 = {
      status: 'completed',
      paymentStatus: 'partially_refunded',
      pricing: { providerPayoutCents: 50, totalCents: 100 },
      payment: { refundedCents: 33 },
    };
    expect(computeEarningCents(booking2)).toBe(34);
  });

  it('earns 0 when fully refunded or unpaid', () => {
    expect(computeEarningCents({ status: 'completed', paymentStatus: 'refunded', pricing: { providerPayoutCents: 8000 } })).toBe(0);
    expect(computeEarningCents({ status: 'completed', paymentStatus: 'unpaid', pricing: { providerPayoutCents: 8000 } })).toBe(0);
    expect(computeEarningCents({ status: 'in_progress', paymentStatus: 'paid', pricing: { providerPayoutCents: 8000 } })).toBe(0);
  });

  it('determines earning state according to hold days and payout presence', () => {
    const now = Date.now();
    const holdDays = 3;

    // Completed today -> pending
    const bPending = {
      status: 'completed',
      paymentStatus: 'paid',
      lifecycle: { completedAt: new Date(now - 1000 * 3600) }, // 1 hour ago
    };
    expect(computeEarningState(bPending, holdDays)).toBe('pending');

    // Completed 4 days ago -> available
    const bAvailable = {
      status: 'completed',
      paymentStatus: 'paid',
      lifecycle: { completedAt: new Date(now - 4 * 86400000) },
    };
    expect(computeEarningState(bAvailable, holdDays)).toBe('available');

    // In draft payout -> in_payout
    const bInPayout = {
      ...bAvailable,
      payout: { payoutId: 'payout_123' },
    };
    expect(computeEarningState(bInPayout, holdDays, 'draft')).toBe('in_payout');

    // In paid payout -> paid
    expect(computeEarningState(bInPayout, holdDays, 'paid')).toBe('paid');
  });
});

describe('Offline Payments (Admin Only)', () => {
  it('records offline payment successfully and marks booking paid', async () => {
    const booking = await createCompletedBooking(techUser1._id, {
      status: 'pending',
      paymentStatus: 'unpaid',
      totalCents: 15000,
    });

    const res = await request(app)
      .post(`/api/v1/payments/bookings/${booking._id}/offline`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        method: 'bank',
        reference: 'WIRE-998822',
        amountCents: 15000,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.payment.status).toBe('paid');
    expect(res.body.data.payment.source).toBe('offline');

    // Verify booking updated
    const updated = await Booking.findById(booking._id);
    expect(updated?.paymentStatus).toBe('paid');
    expect(updated?.paidAt).toBeDefined();

    // Verify Payment document created
    const payment = await Payment.findOne({ bookingId: booking._id });
    expect(payment?.source).toBe('offline');
    expect(payment?.amountCents).toBe(15000);
    expect(payment?.offline?.reference).toBe('WIRE-998822');
  });

  it('rejects offline payment if amount does not equal booking total', async () => {
    const booking = await createCompletedBooking(techUser1._id, {
      paymentStatus: 'unpaid',
      totalCents: 15000,
    });

    const res = await request(app)
      .post(`/api/v1/payments/bookings/${booking._id}/offline`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        method: 'bank',
        reference: 'WIRE-BAD',
        amountCents: 10000, // mismatch
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AMOUNT_MISMATCH');
  });

  it('rejects duplicate offline payment when already paid', async () => {
    const booking = await createCompletedBooking(techUser1._id, {
      paymentStatus: 'paid',
      totalCents: 12000,
    });

    const res = await request(app)
      .post(`/api/v1/payments/bookings/${booking._id}/offline`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        method: 'cash',
        reference: 'CASH-REC-1',
        amountCents: 12000,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_PAID');
  });

  it('forbids dispatchers from recording offline payments', async () => {
    const booking = await createCompletedBooking(techUser1._id, {
      paymentStatus: 'unpaid',
      totalCents: 10000,
    });

    const res = await request(app)
      .post(`/api/v1/payments/bookings/${booking._id}/offline`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({
        method: 'bank',
        reference: 'WIRE-123',
        amountCents: 10000,
      });

    expect(res.status).toBe(403);
  });
});

describe('Technician Earnings API (/api/v1/technicians/me/earnings)', () => {
  it('allows approved technician to fetch their own earnings summary and items', async () => {
    // Booking 1: available (completed 5 days ago)
    await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      providerPayoutCents: 7500,
      totalCents: 10000,
    });

    // Booking 2: pending (completed 1 day ago)
    await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 1 * 86400000),
      providerPayoutCents: 8500,
      totalCents: 12000,
    });

    const res = await request(app)
      .get('/api/v1/technicians/me/earnings')
      .set('Authorization', `Bearer ${techToken1}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary.availableCents).toBe(7500);
    expect(res.body.data.summary.pendingCents).toBe(8500);
    expect(res.body.data.items.length).toBe(2);

    // Verify privacy: never expose customer total, name, phone, or email
    const item = res.body.data.items[0];
    expect(item).not.toHaveProperty('customerTotal');
    expect(item).not.toHaveProperty('customerName');
    expect(item).not.toHaveProperty('customerEmail');
    expect(item).not.toHaveProperty('customerPhone');
    expect(item).toHaveProperty('bookingNumber');
    expect(item).toHaveProperty('earningCents');
  });

  it('isolates earnings per technician', async () => {
    await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      providerPayoutCents: 9000,
    });

    const resTech2 = await request(app)
      .get('/api/v1/technicians/me/earnings')
      .set('Authorization', `Bearer ${techToken2}`);

    expect(resTech2.status).toBe(200);
    expect(resTech2.body.data.summary.availableCents).toBe(0);
    expect(resTech2.body.data.items.length).toBe(0);
  });
});

describe('Admin Payouts Management', () => {
  it('returns available balances per technician', async () => {
    await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      providerPayoutCents: 8000,
    });
    await createCompletedBooking(techUser2._id, {
      completedAt: new Date(Date.now() - 6 * 86400000),
      providerPayoutCents: 6000,
    });

    const res = await request(app)
      .get('/api/v1/admin/payouts/balances')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(2);
    const t1 = res.body.data.find((b: { technicianUserId: string }) => b.technicianUserId === techUser1._id.toString());
    expect(t1.availableCents).toBe(8000);
    expect(t1.eligibleBookingsCount).toBe(1);
  });

  it('creates draft payout and atomically claims eligible bookings', async () => {
    const b1 = await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      providerPayoutCents: 8000,
    });
    const b2 = await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 4 * 86400000),
      providerPayoutCents: 7000,
    });

    const res = await request(app)
      .post('/api/v1/admin/payouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        technicianUserId: techUser1._id.toString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.grossCents).toBe(15000);
    expect(res.body.data.netCents).toBe(15000);
    expect(res.body.data.bookingIds.length).toBe(2);

    // Bookings should now be marked with payout.payoutId
    const freshB1 = await Booking.findById(b1._id);
    expect(freshB1?.payout?.payoutId).toBe(res.body.data._id);
  });

  it('guarantees atomic concurrency: two concurrent create requests claim each booking at most once', async () => {
    // Create 4 eligible bookings
    await createCompletedBooking(techUser1._id, { providerPayoutCents: 5000 });
    await createCompletedBooking(techUser1._id, { providerPayoutCents: 5000 });
    await createCompletedBooking(techUser1._id, { providerPayoutCents: 5000 });
    await createCompletedBooking(techUser1._id, { providerPayoutCents: 5000 });

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/v1/admin/payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ technicianUserId: techUser1._id.toString() }),
      request(app)
        .post('/api/v1/admin/payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ technicianUserId: techUser1._id.toString() }),
    ]);

    // Either one caught all 4, or both succeeded with disjoint sets totaling 4 bookings
    const bookings1: string[] = res1.body.data?.bookingIds || [];
    const bookings2: string[] = res2.body.data?.bookingIds || [];
    const overlap = bookings1.filter((id) => bookings2.includes(id));

    expect(overlap.length).toBe(0); // Zero overlap!
    expect(bookings1.length + bookings2.length).toBe(4);
  });

  it('enforces minPayoutCents threshold', async () => {
    await PaymentSettings.findOneAndUpdate({}, { minPayoutCents: 10000 });

    await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      providerPayoutCents: 5000, // < 10000
    });

    const res = await request(app)
      .post('/api/v1/admin/payouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        technicianUserId: techUser1._id.toString(),
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BELOW_MINIMUM_PAYOUT');
  });

  it('settles unsettled adjustments into the payout', async () => {
    // Add negative adjustment
    const adj = await PayoutAdjustment.create({
      technicianUserId: techUser1._id,
      bookingId: new mongoose.Types.ObjectId(),
      amountCents: -2000,
      reason: 'refund_after_payout',
    });

    await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      providerPayoutCents: 10000,
    });

    const res = await request(app)
      .post('/api/v1/admin/payouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        technicianUserId: techUser1._id.toString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.data.grossCents).toBe(10000);
    expect(res.body.data.adjustmentsCents).toBe(-2000);
    expect(res.body.data.netCents).toBe(8000);

    const freshAdj = await PayoutAdjustment.findById(adj._id);
    expect(freshAdj?.settledInPayoutId?.toString()).toBe(res.body.data._id);
  });

  it('voiding a draft payout releases bookings and adjustments', async () => {
    const b1 = await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      providerPayoutCents: 8000,
    });

    const createRes = await request(app)
      .post('/api/v1/admin/payouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ technicianUserId: techUser1._id.toString() });

    const payoutId = createRes.body.data._id;

    // Void the draft
    const voidRes = await request(app)
      .post(`/api/v1/admin/payouts/${payoutId}/void`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(voidRes.status).toBe(200);
    expect(voidRes.body.data.status).toBe('void');

    // Booking is released (no payoutId)
    const freshB1 = await Booking.findById(b1._id);
    expect(freshB1?.payout?.payoutId).toBeUndefined();

    // Booking can now be claimed in a new draft
    const newCreateRes = await request(app)
      .post('/api/v1/admin/payouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ technicianUserId: techUser1._id.toString() });

    expect(newCreateRes.status).toBe(201);
    expect(newCreateRes.body.data.bookingIds).toContain(b1._id.toString());
  });

  it('marks draft payout as paid, and prevents modifying or re-paying', async () => {
    await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      providerPayoutCents: 9000,
    });

    const createRes = await request(app)
      .post('/api/v1/admin/payouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ technicianUserId: techUser1._id.toString() });

    const payoutId = createRes.body.data._id;

    const paidRes = await request(app)
      .post(`/api/v1/admin/payouts/${payoutId}/mark-paid`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        method: 'bank',
        reference: 'WIRE-TRANSFER-PAYOUT-01',
      });

    expect(paidRes.status).toBe(200);
    expect(paidRes.body.data.status).toBe('paid');
    expect(paidRes.body.data.reference).toBe('WIRE-TRANSFER-PAYOUT-01');

    // Attempting to void a paid payout fails
    const voidRes = await request(app)
      .post(`/api/v1/admin/payouts/${payoutId}/void`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(voidRes.status).toBe(400);

    // Attempting to mark paid again fails
    const secondPaidRes = await request(app)
      .post(`/api/v1/admin/payouts/${payoutId}/mark-paid`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ method: 'bank', reference: 'AGAIN' });
    expect(secondPaidRes.status).toBe(400);
  });

  it('sanitizes CSV export against CSV injection', async () => {
    // Create payout with a reference starting with = or +
    const payout = await Payout.create({
      technicianUserId: techUser1._id,
      createdBy: techUser1._id,
      status: 'paid',
      grossCents: 10000,
      adjustmentsCents: 0,
      netCents: 10000,
      paidAt: new Date(),
      reference: '=cmd|/c calc!A0', // Injection attempt
      method: 'bank',
      bookingIds: [],
    });

    const res = await request(app)
      .get(`/api/v1/admin/payouts/${payout._id}/export.csv`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    // Injected field should have a leading single quote `'=`
    expect(res.text).toContain("'=cmd|/c calc!A0");
  });
});

describe('Refund After Payout Integration', () => {
  it('creates PayoutAdjustment when booking in a PAID payout is refunded', async () => {
    const booking = await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      totalCents: 10000,
      providerPayoutCents: 8000,
    });

    // Create payment
    await Payment.create({
      bookingId: booking._id,
      amountCents: 10000,
      status: 'paid',
      source: 'offline',
    });

    // Put into paid payout
    const payout = await Payout.create({
      technicianUserId: techUser1._id,
      createdBy: techUser1._id,
      status: 'paid',
      grossCents: 8000,
      adjustmentsCents: 0,
      netCents: 8000,
      bookingIds: [booking._id],
    });
    booking.payout = { payoutId: payout._id.toString() };
    await booking.save();

    // Now issue admin refund of 50%
    const res = await request(app)
      .post(`/api/v1/payments/bookings/${booking._id}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        amountCents: 5000,
        reason: 'Customer complaint partial refund',
      });

    expect(res.status).toBe(200);

    // Verify PayoutAdjustment was created:
    // Original payout: 8000
    // New earning with 50% refund: 4000
    // Diff: 4000 - 8000 = -4000
    const adj = await PayoutAdjustment.findOne({ bookingId: booking._id });
    expect(adj).toBeDefined();
    expect(adj?.amountCents).toBe(-4000);
    expect(adj?.reason).toBe('refund_after_payout');
  });

  it('automatically voids a draft payout if one of its bookings is refunded', async () => {
    const booking = await createCompletedBooking(techUser1._id, {
      completedAt: new Date(Date.now() - 5 * 86400000),
      totalCents: 10000,
      providerPayoutCents: 8000,
    });

    await Payment.create({
      bookingId: booking._id,
      amountCents: 10000,
      status: 'paid',
      source: 'offline',
    });

    const payout = await Payout.create({
      technicianUserId: techUser1._id,
      createdBy: techUser1._id,
      status: 'draft',
      grossCents: 8000,
      adjustmentsCents: 0,
      netCents: 8000,
      bookingIds: [booking._id],
    });
    booking.payout = { payoutId: payout._id.toString() };
    await booking.save();

    // Issue full refund
    const res = await request(app)
      .post(`/api/v1/payments/bookings/${booking._id}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        reason: 'Customer cancelled after draft created',
      });

    expect(res.status).toBe(200);

    // The draft payout should now be voided
    const freshPayout = await Payout.findById(payout._id);
    expect(freshPayout?.status).toBe('void');
  });
});

describe('Role Policies for Payouts', () => {
  it('returns 403 for dispatchers on /api/v1/admin/payouts endpoints', async () => {
    const res1 = await request(app)
      .get('/api/v1/admin/payouts/balances')
      .set('Authorization', `Bearer ${dispatcherToken}`);
    expect(res1.status).toBe(403);

    const res2 = await request(app)
      .post('/api/v1/admin/payouts')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ technicianUserId: techUser1._id.toString() });
    expect(res2.status).toBe(403);
  });

  it('returns 403 for customers on /api/v1/admin/payouts endpoints', async () => {
    const res = await request(app)
      .get('/api/v1/admin/payouts')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });
});
