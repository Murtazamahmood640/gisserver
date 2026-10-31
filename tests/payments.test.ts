import crypto from 'crypto';
/**
 * payments.test.ts
 *
 * Real MongoDB (MongoMemoryServer) + Supertest + Mocked Stripe SDK.
 * Covers:
 * - Checkout session creation, amount security, role access, reuse, 503 fallback
 * - Webhook processing: signature verification, idempotency, checkout.session.completed,
 *   expired, failed, refund sync, dispute created
 * - Refund flows: full, partial, over-refund rejection, 403 for dispatcher, cancellation policy math
 * - Prepay expiration sweep: cancel expired, release slot, safe concurrency
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// 1. Mock external services
vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'mock' }),
  getBookingConfirmationEmail: vi.fn().mockReturnValue('<p></p>'),
  getAdminNotificationEmail: vi.fn().mockReturnValue('<p></p>'),
  getStatusUpdateEmail: vi.fn().mockReturnValue('<p></p>'),
  getPaymentReceiptEmail: vi.fn().mockReturnValue('<p></p>') }));

vi.mock('../services/pushService', () => ({
  pushService: { sendToUser: vi.fn() } }));

vi.mock('../realtime/emitter', () => ({
  realtimeEmitter: {
    emitBookingStatus: vi.fn(),
    emitBookingAssigned: vi.fn(),
    emitOfferNew: vi.fn(),
    emitOfferExpired: vi.fn(),
    emitDispatchBoardUpdate: vi.fn(),
    emitTechnicianLocation: vi.fn(),
    emitTrackingEta: vi.fn() } }));

// Mock Stripe SDK
const mockStripe = {
  checkout: {
    sessions: {
      create: vi.fn().mockResolvedValue({
        id: 'cs_test_mock_session_123',
        url: 'https://checkout.stripe.com/pay/cs_test_mock_session_123',
        status: 'open' }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'cs_test_mock_session_123',
        url: 'https://checkout.stripe.com/pay/cs_test_mock_session_123',
        status: 'open' }) } },
  webhooks: {
    constructEvent: vi.fn() },
  paymentIntents: {
    retrieve: vi.fn().mockResolvedValue({
      id: 'pi_test_mock_intent_123',
      latest_charge: {
        id: 'ch_test_123',
        balance_transaction: {
          fee: 320,
          net: 9680 } } }) },
  refunds: {
    create: vi.fn().mockResolvedValue({
      id: 're_test_mock_refund_123',
      status: 'succeeded',
      amount: 5000 }) } };

vi.mock('stripe', () => {
  return {
    default: class MockStripeClass {
      checkout = mockStripe.checkout;
      webhooks = mockStripe.webhooks;
      paymentIntents = mockStripe.paymentIntents;
      refunds = mockStripe.refunds;
      constructor() {
        return mockStripe;
      }
    } };
});

import app from '../app';
import { User } from '../models/User';
import { Booking } from '../models/Booking';
import { Payment } from '../models/Payment';
import { StripeEvent } from '../models/StripeEvent';
import { PaymentSettings } from '../models/PaymentSettings';
import { Service } from '../models/Service';
import { ServiceCategory } from '../models/ServiceCategory';
import { SlotReservation } from '../models/SlotReservation';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { PaymentService } from '../modules/payments/service';
import { BookingService } from '../modules/bookings/service';
import { DispatchService } from '../modules/dispatch/service';
import logger from '../config/logger';
import { generateAccessToken } from '../utils/jwt';

let mongoServer: MongoMemoryServer;
let adminToken: string;
let dispatcherToken: string;
let customerUser: { _id: mongoose.Types.ObjectId; email: string };
let customerToken: string;
let otherCustomerToken: string;
let testCategoryId: mongoose.Types.ObjectId;
let testServiceId: mongoose.Types.ObjectId;

async function createTestBooking(overrides: Record<string, unknown> = {}) {
  const numberSuffix = Math.floor(100000 + Math.random() * 900000);
  const booking = await Booking.create({
    bookingNumber: `GIS-${numberSuffix}`,
    customerId: overrides.customerId || customerUser._id,
    categoryId: testCategoryId,
    serviceId: testServiceId,
    serviceSnapshot: { name: 'Full Detail', slug: 'full-detail' },
    vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2022 },
    addons: [],
    address: { freeText: '123 Main St', line1: '123 Main St', city: 'Miami', state: 'FL', zip: '33101' },
    scheduledAt: new Date(Date.now() + 86400000 * 2),
    scheduledLocal: { date: '2026-11-15', slot: '10:00' },
    timezone: 'America/New_York',
    isAsap: false,
    status: overrides.status || 'pending',
    statusHistory: [{ status: overrides.status || 'pending', by: 'system', at: new Date() }],
    pricing: {
      baseCents: 10000,
      addonsCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalCents: overrides.totalCents !== undefined ? overrides.totalCents : 10000,
      commissionPercent: 15,
      processingPercent: 3,
      commissionCents: 1500,
      processingCents: 300,
      providerPayoutCents: 8200 },
    paymentStatus: overrides.paymentStatus || 'unpaid',
    source: 'web',
    ...overrides });
  return booking;
}

describe('Stripe Payments & Hosted Checkout (/api/v1/payments, /api/v1/stripe)', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.disconnect();
    await mongoose.connect(mongoServer.getUri());

    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_secret_key';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_mock_webhook_secret';

    const category = await ServiceCategory.create({ name: 'Auto Detailing', slug: 'auto-detailing' });
    testCategoryId = category._id;

    const service = await Service.create({
      name: 'Full Detail',
      slug: 'full-detail',
      categoryId: testCategoryId,
      basePriceCents: 10000,
      durationMinutes: 60 });
    testServiceId = service._id;

    const adminUser = await User.create({
      email: 'admin-payments@test.com',
      password: 'P@ssword1!',
      fullName: 'Admin User',
      role: 'admin',
      status: 'active' });
    adminToken = generateAccessToken({ userId: adminUser._id.toString(), email: adminUser.email, role: 'admin', status: 'active', emailVerified: true });

    const dispatcherUser = await User.create({
      email: 'dispatcher-payments@test.com',
      password: 'P@ssword1!',
      fullName: 'Dispatcher User',
      role: 'dispatcher',
      status: 'active' });
    dispatcherToken = generateAccessToken({ userId: dispatcherUser._id.toString(), email: dispatcherUser.email, role: 'dispatcher', status: 'active', emailVerified: true });

    customerUser = await User.create({
      email: 'customer-payments@test.com',
      password: 'P@ssword1!',
      fullName: 'Customer User',
      role: 'customer',
      status: 'active' });
    customerToken = generateAccessToken({ userId: customerUser._id.toString(), email: customerUser.email, role: 'customer', status: 'active', emailVerified: true });

    const otherUser = await User.create({
      email: 'other-payments@test.com',
      password: 'P@ssword1!',
      fullName: 'Other Customer',
      role: 'customer',
      status: 'active' });
    otherCustomerToken = generateAccessToken({ userId: otherUser._id.toString(), email: otherUser.email, role: 'customer', status: 'active', emailVerified: true });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_secret_key';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_mock_webhook_secret';
    await StripeEvent.deleteMany({});
    await Payment.deleteMany({});
    const { _resetStripeClient } = await import('../modules/payments/stripeClient');
    _resetStripeClient();

    mockStripe.checkout.sessions.create.mockImplementation(async (_opts?: unknown) => {
      const id = `cs_test_${Date.now()}_${Math.random().toString(36).substring(2)}`;
      return {
        id,
        url: `https://checkout.stripe.com/pay/${id}`,
        status: 'open' };
    });
    mockStripe.checkout.sessions.retrieve.mockImplementation(async (sessionId: string) => {
      return {
        id: sessionId,
        url: `https://checkout.stripe.com/pay/${sessionId}`,
        status: 'open' };
    });
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_test_mock_intent_123',
      latest_charge: {
        id: 'ch_test_123',
        balance_transaction: { fee: 320, net: 9680 } } });
    mockStripe.refunds.create.mockResolvedValue({
      id: 're_test_mock_refund_123',
      status: 'succeeded',
      amount: 5000 });
    mockStripe.webhooks.constructEvent.mockImplementation((body: string | Buffer | Record<string, unknown>, sig: string) => {
      if (sig === 'invalid_sig') {
        throw new Error('Signature verification failed');
      }
      let parsed: Record<string, unknown> = {};
      try {
        if (Buffer.isBuffer(body)) {
          parsed = JSON.parse(body.toString('utf8'));
        } else if (typeof body === 'string') {
          parsed = JSON.parse(body);
        } else if (body && typeof body === 'object') {
          parsed = body;
        }
      } catch {
        parsed = {};
      }
      return {
        id: parsed.id || `evt_mock_${Date.now()}_${Math.random()}`,
        type: parsed.type || 'checkout.session.completed',
        data: parsed.data || { object: parsed } };
    });
  });

  // ---------------------------------------------------------------------------
  // 1. Checkout Session Creation & Security
  // ---------------------------------------------------------------------------
  describe('Checkout Endpoint (POST /api/v1/payments/bookings/:id/checkout)', () => {
    it('creates a checkout session using server totalCents (ignores client amounts)', async () => {
      const booking = await createTestBooking({ totalCents: 10000 });

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/checkout`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ amountCents: 50 }); // Client tampering attempt

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toMatch(/^https:\/\/checkout\.stripe\.com\/pay\/cs_test_/);

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalled();
      const createArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
      expect(createArgs.line_items[0].price_data.unit_amount).toBe(10000); // 10000, not 50
    });

    it('allows guest checkout with valid X-Booking-Token header', async () => {
      const rawToken = 'guest-secret-token-123';
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      const guestBooking = await createTestBooking({
        customerId: null,
        guest: { fullName: 'Guest Tester', email: 'guest@test.com', phone: '555-123-4567' },
        guestAccessTokenHash: tokenHash });

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${guestBooking._id}/checkout`)
        .set('X-Booking-Token', rawToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBeTruthy();
    });

    it('allows admin to checkout on behalf of any customer', async () => {
      const booking = await createTestBooking();

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/checkout`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects checkout by another unprivileged customer (404/403 not authorized)', async () => {
      const booking = await createTestBooking();

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/checkout`)
        .set('Authorization', `Bearer ${otherCustomerToken}`);

      expect(res.status).toBe(403);
    });

    it('rejects checkout for a cancelled booking', async () => {
      const booking = await createTestBooking({ status: 'cancelled' });

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/checkout`)
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BOOKING_CANCELLED');
    });

    it('rejects checkout for an already paid booking (409)', async () => {
      const booking = await createTestBooking({ paymentStatus: 'paid' });

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/checkout`)
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_PAID');
    });

    it('rejects checkout when booking total is zero (400)', async () => {
      const booking = await createTestBooking({ totalCents: 0 });

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/checkout`)
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_AMOUNT');
    });

    it('reuses existing pending checkout session if still open in Stripe', async () => {
      const booking = await createTestBooking({ totalCents: 12000 });

      // First call creates payment
      const res1 = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/checkout`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res1.status).toBe(200);

      // Second call reuses session
      const res2 = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/checkout`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res2.status).toBe(200);
      expect(res2.body.data.url).toBe(res1.body.data.url);

      const paymentsCount = await Payment.countDocuments({ bookingId: booking._id });
      expect(paymentsCount).toBe(1);
    });

    it('returns 503 PAYMENTS_NOT_CONFIGURED when Stripe secret key is unset', async () => {
      const booking = await createTestBooking();
      const prevKey = process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_SECRET_KEY;

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/checkout`)
        .set('Authorization', `Bearer ${customerToken}`);

      process.env.STRIPE_SECRET_KEY = prevKey;

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENTS_NOT_CONFIGURED');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Webhook Processing (POST /api/v1/stripe/webhook)
  // ---------------------------------------------------------------------------
  describe('Stripe Webhook (POST /api/v1/stripe/webhook)', () => {
    it('returns 400 when signature verification fails', async () => {
      mockStripe.webhooks.constructEvent.mockImplementationOnce(() => {
        throw new Error('Signature verification failed');
      });

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', 'invalid_sig')
        .send({ type: 'checkout.session.completed' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('handles checkout.session.completed: marks payment paid, updates booking, records fees', async () => {
      const booking = await createTestBooking({ totalCents: 10000, status: 'pending', paymentStatus: 'pending' });

      const payment = await Payment.create({
        bookingId: booking._id,
        customerId: customerUser._id,
        amountCents: 10000,
        currency: 'usd',
        status: 'pending',
        stripeCheckoutSessionId: 'cs_test_completed_1' });

      mockStripe.webhooks.constructEvent.mockReturnValueOnce({
        id: 'evt_test_completed_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_completed_1',
            payment_intent: 'pi_test_mock_intent_123',
            customer_details: { email: 'customer-payments@test.com' } } } });

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', 'valid_sig')
        .send({ id: 'evt_test_completed_1' });

      expect(res.status).toBe(200);

      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment?.status).toBe('paid');
      expect(updatedPayment?.stripeFeeCents).toBe(320);
      expect(updatedPayment?.stripeNetCents).toBe(9680);
      expect(updatedPayment?.paidAt).toBeDefined();

      const updatedBooking = await Booking.findById(booking._id);
      expect(updatedBooking?.paymentStatus).toBe('paid');
      expect(updatedBooking?.paidAt).toBeDefined();
    });

    it('enforces webhook idempotency (same event id twice yields exactly one processing)', async () => {
      const booking = await createTestBooking({ totalCents: 8000 });
      await Payment.create({
        bookingId: booking._id,
        amountCents: 8000,
        currency: 'usd',
        status: 'pending',
        stripeCheckoutSessionId: 'cs_test_idempotent_1' });

      const mockEvent = {
        id: 'evt_test_duplicate_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_idempotent_1',
            payment_intent: 'pi_test_mock_intent_123' } } };

      mockStripe.webhooks.constructEvent.mockReturnValue(mockEvent);

      // Call 1
      const res1 = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', 'valid_sig')
        .send(mockEvent);
      expect(res1.status).toBe(200);

      // Call 2
      const res2 = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', 'valid_sig')
        .send(mockEvent);
      expect(res2.status).toBe(200);
      expect(res2.body.duplicate).toBe(true);

      const eventsCount = await StripeEvent.countDocuments({ eventId: 'evt_test_duplicate_1' });
      expect(eventsCount).toBe(1);
    });

    it('handles checkout.session.expired: sets payment to expired and booking back to unpaid', async () => {
      const booking = await createTestBooking({ paymentStatus: 'pending' });
      const payment = await Payment.create({
        bookingId: booking._id,
        amountCents: 10000,
        currency: 'usd',
        status: 'pending',
        stripeCheckoutSessionId: 'cs_test_expired_1' });

      mockStripe.webhooks.constructEvent.mockReturnValueOnce({
        id: 'evt_test_expired_1',
        type: 'checkout.session.expired',
        data: { object: { id: 'cs_test_expired_1' } } });

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', 'valid_sig')
        .send({});

      expect(res.status).toBe(200);
      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment?.status).toBe('expired');
      const updatedBooking = await Booking.findById(booking._id);
      expect(updatedBooking?.paymentStatus).toBe('unpaid');
    });

    it('handles payment_intent.payment_failed: sets payment and booking to failed', async () => {
      const booking = await createTestBooking({ paymentStatus: 'pending' });
      const payment = await Payment.create({
        bookingId: booking._id,
        amountCents: 10000,
        currency: 'usd',
        status: 'pending',
        stripePaymentIntentId: 'pi_test_failed_1' });

      mockStripe.webhooks.constructEvent.mockReturnValueOnce({
        id: 'evt_test_failed_1',
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_test_failed_1' } } });

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', 'valid_sig')
        .send({});

      expect(res.status).toBe(200);
      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment?.status).toBe('failed');
      const updatedBooking = await Booking.findById(booking._id);
      expect(updatedBooking?.paymentStatus).toBe('failed');
    });

    it('handles charge.refunded: syncs refundedCents and status', async () => {
      const booking = await createTestBooking({ paymentStatus: 'paid' });
      const payment = await Payment.create({
        bookingId: booking._id,
        amountCents: 10000,
        currency: 'usd',
        status: 'paid',
        stripePaymentIntentId: 'pi_test_refund_sync_1' });

      mockStripe.webhooks.constructEvent.mockReturnValueOnce({
        id: 'evt_test_refund_sync_1',
        type: 'charge.refunded',
        data: {
          object: {
            payment_intent: 'pi_test_refund_sync_1',
            amount_refunded: 5000 } } });

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', 'valid_sig')
        .send({});

      expect(res.status).toBe(200);
      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment?.refundedCents).toBe(5000);
      expect(updatedPayment?.status).toBe('partially_refunded');
    });

    it('handles charge.dispute.created: adds dispute to payment history and logs', async () => {
      const booking = await createTestBooking({ paymentStatus: 'paid' });
      const payment = await Payment.create({
        bookingId: booking._id,
        amountCents: 10000,
        currency: 'usd',
        status: 'paid',
        stripePaymentIntentId: 'pi_test_dispute_1' });

      mockStripe.webhooks.constructEvent.mockReturnValueOnce({
        id: 'evt_test_dispute_1',
        type: 'charge.dispute.created',
        data: {
          object: {
            payment_intent: 'pi_test_dispute_1',
            reason: 'fraudulent',
            amount: 10000 } } });

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', 'valid_sig')
        .send({});

      expect(res.status).toBe(200);
      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment?.history.some((h) => h.action === 'dispute_created')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Admin & Cancellation Refunds
  // ---------------------------------------------------------------------------
  describe('Refunds (POST /api/v1/payments/bookings/:id/refund)', () => {
    it('allows admin to issue a partial refund', async () => {
      const booking = await createTestBooking({ paymentStatus: 'paid' });
      const payment = await Payment.create({
        bookingId: booking._id,
        amountCents: 10000,
        currency: 'usd',
        status: 'paid',
        stripePaymentIntentId: 'pi_test_admin_refund_1' });

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amountCents: 3000, reason: 'Customer requested partial refund' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment?.refundedCents).toBe(3000);
      expect(updatedPayment?.status).toBe('partially_refunded');
    });

    it('allows admin to issue a full refund when amountCents is omitted', async () => {
      const booking = await createTestBooking({ paymentStatus: 'paid' });
      const payment = await Payment.create({
        bookingId: booking._id,
        amountCents: 7500,
        currency: 'usd',
        status: 'paid',
        stripePaymentIntentId: 'pi_test_admin_full_refund' });

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Full refund by admin' });

      expect(res.status).toBe(200);
      const updatedPayment = await Payment.findById(payment._id);
      expect(updatedPayment?.refundedCents).toBe(7500);
      expect(updatedPayment?.status).toBe('refunded');
    });

    it('rejects over-refunds (amount > remaining balance)', async () => {
      const booking = await createTestBooking({ paymentStatus: 'paid' });
      await Payment.create({
        bookingId: booking._id,
        amountCents: 5000,
        refundedCents: 3000,
        currency: 'usd',
        status: 'partially_refunded',
        stripePaymentIntentId: 'pi_test_over_refund' });

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amountCents: 2500, reason: 'Over refund attempt' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('REFUND_EXCEEDS_BALANCE');
    });

    it('forbids dispatchers from issuing refunds (403)', async () => {
      const booking = await createTestBooking({ paymentStatus: 'paid' });

      const res = await request(app)
        .post(`/api/v1/payments/bookings/${booking._id}/refund`)
        .set('Authorization', `Bearer ${dispatcherToken}`)
        .send({ reason: 'Dispatcher attempt' });

      expect(res.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Prepay Sweeper & Expiry
  // ---------------------------------------------------------------------------
  describe('Prepay Sweeper (POST /api/v1/admin/cron/sweep-payments)', () => {
    it('cancels expired unpaid prepay bookings and releases their slot reservations', async () => {
      // 1. Create a reservation for this slot
      await SlotReservation.create({
        date: '2026-11-20',
        slot: '14:00',
        categoryId: testCategoryId,
        count: 1 });

      // 2. Create expired prepay booking
      const expiredBooking = await createTestBooking({
        status: 'pending',
        paymentStatus: 'pending',
        scheduledLocal: { date: '2026-11-20', slot: '14:00' },
        paymentExpiresAt: new Date(Date.now() - 60000), // 1 minute in the past
      });

      // 3. Create active paid booking (should NOT be cancelled)
      const paidBooking = await createTestBooking({
        status: 'pending',
        paymentStatus: 'paid',
        paymentExpiresAt: new Date(Date.now() - 60000) });

      const res = await request(app)
        .post('/api/v1/admin/cron/sweep-payments')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const refreshedExpired = await Booking.findById(expiredBooking._id);
      expect(refreshedExpired?.status).toBe('cancelled');
      expect(refreshedExpired?.statusHistory.some((h: { note?: string }) => h.note?.includes('prepayment expiration'))).toBe(true);

      const refreshedPaid = await Booking.findById(paidBooking._id);
      expect(refreshedPaid?.status).toBe('pending'); // Untouched

      const resv = await SlotReservation.findOne({ date: '2026-11-20', slot: '14:00', categoryId: testCategoryId });
      expect(resv?.count).toBe(0);
    });
  });

  describe('Cancellation Policy Refunds', () => {
    it('refunds 100% inside free window', async () => {
      const booking = await createTestBooking({
        status: 'confirmed',
        paymentStatus: 'paid',
        scheduledAt: new Date(Date.now() + 86400000 * 5), // 5 days in future (free window)
      });
      await Payment.create({
        bookingId: booking._id,
        stripeCheckoutSessionId: 'cs_cancel_free_123',
        stripePaymentIntentId: 'pi_cancel_free_123',
        amountCents: 10000,
        currency: 'usd',
        status: 'paid',
        paidAt: new Date(),
        history: [] });

      const res = await BookingService.cancelBooking(
        booking._id.toString(),
        { userId: customerUser._id.toString(), role: 'customer', email: customerUser.email },
        'Customer changed plans'
      );

      expect(res.status).toBe('cancelled');
      const updatedPayment = await Payment.findOne({ bookingId: booking._id });
      expect(updatedPayment?.status).toBe('refunded');
      expect(updatedPayment?.refundedCents).toBe(10000);
      const updatedBooking = await Booking.findById(booking._id);
      expect(updatedBooking?.paymentStatus).toBe('refunded');
    });

    it('refunds (100 - lateFeePercent)% with round half up outside free window', async () => {
      const booking = await createTestBooking({
        status: 'confirmed',
        paymentStatus: 'paid',
        scheduledAt: new Date(Date.now() + 3600000 * 2), // 2 hours in future (late cancellation)
      });
      await Payment.create({
        bookingId: booking._id,
        stripeCheckoutSessionId: 'cs_cancel_late_123',
        stripePaymentIntentId: 'pi_cancel_late_123',
        amountCents: 10000,
        currency: 'usd',
        status: 'paid',
        paidAt: new Date(),
        history: [] });

      // Default lateFeePercent is 25% -> refunds 75% -> 7500 cents
      const res = await BookingService.cancelBooking(
        booking._id.toString(),
        { userId: customerUser._id.toString(), role: 'customer', email: customerUser.email },
        'Emergency'
      );

      expect(res.status).toBe('cancelled');
      const updatedPayment = await Payment.findOne({ bookingId: booking._id });
      expect(updatedPayment?.status).toBe('partially_refunded');
      expect(updatedPayment?.refundedCents).toBe(8000);
    });

    it('admin cancellation refunds 100% regardless of late window', async () => {
      const booking = await createTestBooking({
        status: 'confirmed',
        paymentStatus: 'paid',
        scheduledAt: new Date(Date.now() + 3600000 * 1), // 1 hour in future
      });
      await Payment.create({
        bookingId: booking._id,
        stripeCheckoutSessionId: 'cs_cancel_admin_123',
        stripePaymentIntentId: 'pi_cancel_admin_123',
        amountCents: 8000,
        currency: 'usd',
        status: 'paid',
        paidAt: new Date(),
        history: [] });

      const res = await BookingService.cancelBooking(
        booking._id.toString(),
        { userId: 'admin_123', role: 'admin', email: 'admin@test.com' },
        'Admin cancellation override'
      );

      expect(res.status).toBe('cancelled');
      const updatedPayment = await Payment.findOne({ bookingId: booking._id });
      expect(updatedPayment?.status).toBe('refunded');
      expect(updatedPayment?.refundedCents).toBe(8000);
    });

    it('refund failure does not block cancellation and is flagged for admin review', async () => {
      const booking = await createTestBooking({
        status: 'confirmed',
        paymentStatus: 'paid',
        scheduledAt: new Date(Date.now() + 86400000 * 3) });
      await Payment.create({
        bookingId: booking._id,
        stripeCheckoutSessionId: 'cs_fail_refund_123',
        stripePaymentIntentId: 'pi_fail_refund_123',
        amountCents: 5000,
        currency: 'usd',
        status: 'paid',
        paidAt: new Date(),
        history: [] });

      // Force Stripe refund to reject
      mockStripe.refunds.create.mockRejectedValueOnce(new Error('Stripe gateway timeout'));

      const res = await BookingService.cancelBooking(
        booking._id.toString(),
        { userId: customerUser._id.toString(), role: 'customer', email: customerUser.email },
        'Cancel with failing gateway'
      );

      expect(res.status).toBe('cancelled');
      const refreshedBooking = await Booking.findById(booking._id);
      expect(refreshedBooking?.status).toBe('cancelled');
      const hasReviewFlag = refreshedBooking?.statusHistory.some((h: { note?: string }) =>
        h.note?.includes('REFUND_FAILED_ADMIN_REVIEW_REQUIRED')
      );
      expect(hasReviewFlag).toBe(true);

      const refreshedPayment = await Payment.findOne({ bookingId: booking._id });
      expect(refreshedPayment?.history.some((h) => h.action === 'refund_failed')).toBe(true);
    });
  });

  describe('Prepay Sweeper Concurrency and Schedule Release', () => {
    it('two concurrent sweeps safely process bookings without double-counting', async () => {
      const expired1 = await createTestBooking({
        status: 'pending',
        paymentStatus: 'pending',
        paymentExpiresAt: new Date(Date.now() - 120000) });
      const expired2 = await createTestBooking({
        status: 'pending',
        paymentStatus: 'pending',
        paymentExpiresAt: new Date(Date.now() - 120000) });

      const { sweepExpiredPrepayBookings } = await import('../modules/payments/sweeper');
      const [r1, r2] = await Promise.all([
        sweepExpiredPrepayBookings(),
        sweepExpiredPrepayBookings(),
      ]);

      expect(r1.sweptCount + r2.sweptCount).toBe(2);
      const b1 = await Booking.findById(expired1._id);
      const b2 = await Booking.findById(expired2._id);
      expect(b1?.status).toBe('cancelled');
      expect(b2?.status).toBe('cancelled');
    });

    it('releases assigned technician activeSchedule entry on expiration', async () => {
      const techUser = await User.create({
        email: 'tech-sweep@test.com',
        password: 'P@ssword1!',
        fullName: 'Sweep Tech',
        role: 'technician',
        status: 'active' });

      const expiredWithTech = await createTestBooking({
        status: 'pending',
        paymentStatus: 'pending',
        paymentExpiresAt: new Date(Date.now() - 60000),
        assignment: {
          technicianUserId: techUser._id,
          assignedAt: new Date(),
          assignedBy: 'auto' } });

      await TechnicianProfile.create({
        userId: techUser._id,
        bio: 'Tech bio',
        serviceRadiusMiles: 25,
        rating: 5,
        reviewCount: 1,
        jobsCompleted: 1,
        activeSchedule: [
          {
            bookingId: expiredWithTech._id,
            start: new Date(Date.now() + 3600000),
            end: new Date(Date.now() + 7200000) },
        ] });

      const { sweepExpiredPrepayBookings } = await import('../modules/payments/sweeper');
      await sweepExpiredPrepayBookings();

      const refreshedTech = await TechnicianProfile.findOne({ userId: techUser._id });
      expect(refreshedTech?.activeSchedule?.length).toBe(0);
    });
  });

  describe('Payment Confirmation Race and Security', () => {
    it('confirms booking and triggers dispatch exactly once when webhook races', async () => {
      const booking = await createTestBooking({
        status: 'pending',
        paymentStatus: 'pending' });

      const payment = await Payment.create({
        bookingId: booking._id,
        stripeCheckoutSessionId: 'cs_race_123',
        stripePaymentIntentId: 'pi_race_123',
        amountCents: 5000,
        currency: 'usd',
        status: 'pending',
        history: [] });

      const dispatchSpy = vi.spyOn(DispatchService, 'startDispatch').mockResolvedValue({} as never);

      const eventPayload = {
        id: 'evt_race_123',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_race_123',
            payment_intent: 'pi_race_123' } } };

      // Simulate 2 concurrent webhooks
      await Promise.all([
        PaymentService.handleWebhookEvent(JSON.stringify(eventPayload), 'valid_sig'),
        PaymentService.handleWebhookEvent(JSON.stringify(eventPayload), 'valid_sig'),
      ]);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      dispatchSpy.mockRestore();
    });

    it('refuses sk_live key outside NODE_ENV=production', async () => {
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.STRIPE_SECRET_KEY;
      try {
        process.env.NODE_ENV = 'development';
        process.env.STRIPE_SECRET_KEY = 'sk_live_1234567890abcdef';
        const { validateEnv } = await import('../config/env');
        expect(() => validateEnv()).toThrow(/Live Stripe keys/);
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.STRIPE_SECRET_KEY = origKey;
      }
    });

    it('does not log Stripe keys, card numbers or raw webhook payloads', async () => {
      const logWarnSpy = vi.spyOn(logger, 'warn');
      const logInfoSpy = vi.spyOn(logger, 'info');

      const rawPayload = JSON.stringify({
        id: 'evt_log_check',
        type: 'checkout.session.completed',
        secret_card_data: '4242424242424242' });

      await PaymentService.handleWebhookEvent(rawPayload, 'valid_sig');

      const allLoggedMessages = [
        ...logWarnSpy.mock.calls,
        ...logInfoSpy.mock.calls,
      ].map((call) => JSON.stringify(call));

      for (const logLine of allLoggedMessages) {
        expect(logLine).not.toContain('4242424242424242');
        expect(logLine).not.toContain('sk_test_mock_secret_key');
      }

      logWarnSpy.mockRestore();
      logInfoSpy.mockRestore();
    });
  });

});
