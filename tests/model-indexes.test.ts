import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Import EVERY Mongoose model in the application
import { Addon } from '../models/Addon';
import { Appointment } from '../models/Appointment';
import { Blog } from '../models/Blog';
import { Booking } from '../models/Booking';
import { BookingSettings } from '../models/BookingSettings';
import { CommissionRule } from '../models/CommissionRule';
import { Contact } from '../models/Contact';
import { Counter } from '../models/Counter';
import { Coupon } from '../models/Coupon';
import { CustomerProfile } from '../models/CustomerProfile';
import { Feedback } from '../models/Feedback';
import { LoginAttempt } from '../models/LoginAttempt';
import { RefreshToken } from '../models/RefreshToken';
import { Service } from '../models/Service';
import { ServiceCategory } from '../models/ServiceCategory';
import { ServicePrice } from '../models/ServicePrice';
import { SlotReservation } from '../models/SlotReservation';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { User } from '../models/User';
import { Vehicle } from '../models/Vehicle';
import { DispatchOffer } from '../models/DispatchOffer';
import { TechnicianLocation } from '../models/TechnicianLocation';
import { LocationPing } from '../models/LocationPing';
import { DispatchSettings } from '../models/DispatchSettings';
import { Payment } from '../models/Payment';
import { StripeEvent } from '../models/StripeEvent';
import { PaymentSettings } from '../models/PaymentSettings';
import { Payout } from '../models/Payout';
import { PayoutAdjustment } from '../models/PayoutAdjustment';
import { SupplierProfile } from '../models/SupplierProfile';
import { PartCategory } from '../models/PartCategory';
import { PartProduct } from '../models/PartProduct';
import { InventoryLog } from '../models/InventoryLog';

const ALL_MODELS: Array<{ name: string; model: mongoose.Model<any> }> = [
  { name: 'Addon', model: Addon },
  { name: 'Appointment', model: Appointment },
  { name: 'Blog', model: Blog },
  { name: 'Booking', model: Booking },
  { name: 'BookingSettings', model: BookingSettings },
  { name: 'CommissionRule', model: CommissionRule },
  { name: 'Contact', model: Contact },
  { name: 'Counter', model: Counter },
  { name: 'Coupon', model: Coupon },
  { name: 'CustomerProfile', model: CustomerProfile },
  { name: 'Feedback', model: Feedback },
  { name: 'LoginAttempt', model: LoginAttempt },
  { name: 'RefreshToken', model: RefreshToken },
  { name: 'Service', model: Service },
  { name: 'ServiceCategory', model: ServiceCategory },
  { name: 'ServicePrice', model: ServicePrice },
  { name: 'SlotReservation', model: SlotReservation },
  { name: 'TechnicianProfile', model: TechnicianProfile },
  { name: 'User', model: User },
  { name: 'Vehicle', model: Vehicle },
  { name: 'DispatchOffer', model: DispatchOffer },
  { name: 'TechnicianLocation', model: TechnicianLocation },
  { name: 'LocationPing', model: LocationPing },
  { name: 'DispatchSettings', model: DispatchSettings },
  { name: 'Payment', model: Payment },
  { name: 'StripeEvent', model: StripeEvent },
  { name: 'PaymentSettings', model: PaymentSettings },
  { name: 'Payout', model: Payout },
  { name: 'PayoutAdjustment', model: PayoutAdjustment },
  { name: 'SupplierProfile', model: SupplierProfile },
  { name: 'PartCategory', model: PartCategory },
  { name: 'PartProduct', model: PartProduct },
  { name: 'InventoryLog', model: InventoryLog },
];

describe('Mongoose Models Real Index Test (MongoMemoryServer)', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.disconnect();
    await mongoose.connect(uri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('calls Model.init() on EVERY model and lists every unique index successfully', async () => {
    const uniqueIndexesByModel: Record<string, string[]> = {};

    for (const { name, model } of ALL_MODELS) {
      // Build all indexes in MongoDB
      await model.init();

      const indexes = await model.collection.indexes();
      const uniqueIndexes = indexes
        .filter((idx: any) => idx.unique)
        .map((idx: any) => Object.keys(idx.key).join('+'));

      uniqueIndexesByModel[name] = uniqueIndexes;
    }

    // Verify critical unique indexes exist
    expect(uniqueIndexesByModel['Booking']).toContain('bookingNumber');
    expect(uniqueIndexesByModel['Booking']).toContain('legacyAppointmentId');
    expect(uniqueIndexesByModel['Feedback']).toContain('externalId');
    expect(uniqueIndexesByModel['User']).toContain('email');
    expect(uniqueIndexesByModel['Blog']).toContain('slug');
    expect(uniqueIndexesByModel['Coupon']).toContain('code');
    expect(uniqueIndexesByModel['CustomerProfile']).toContain('userId');
    expect(uniqueIndexesByModel['TechnicianProfile']).toContain('userId');
    expect(uniqueIndexesByModel['SupplierProfile']).toContain('userId');
    expect(uniqueIndexesByModel['ServicePrice']).toContain('serviceId+vehicleCategory');
    expect(uniqueIndexesByModel['SlotReservation']).toContain('date+slot+categoryId');
    expect(uniqueIndexesByModel['Payment']).toContain('stripeCheckoutSessionId');
    expect(uniqueIndexesByModel['Payment']).toContain('stripePaymentIntentId');
    expect(uniqueIndexesByModel['StripeEvent']).toContain('eventId');
  });

  describe('Unique Indexes on Optional Fields: Sparse insertion verification', () => {
    it('Booking: inserts two documents omitting optional unique legacyAppointmentId without collision', async () => {
      await Booking.deleteMany({});
      const testServiceId = new mongoose.Types.ObjectId();
      const testCategoryId = new mongoose.Types.ObjectId();

      const booking1 = new Booking({
        bookingNumber: 'GIS-TEST-001',
        serviceId: testServiceId,
        categoryId: testCategoryId,
        guest: { fullName: 'User One', email: 'one@example.com', phone: '555-0001' },
        serviceSnapshot: { name: 'Detail One', slug: 'detail-one' },
        vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2022 },
        scheduledAt: new Date('2026-11-01T10:00:00.000Z'),
        scheduledLocal: { date: '2026-11-01', slot: '10:00' },
        pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
        address: { freeText: '123 Main St', country: 'USA' },
        status: 'pending',
        source: 'web',
        // legacyAppointmentId omitted!
      });

      const booking2 = new Booking({
        bookingNumber: 'GIS-TEST-002',
        serviceId: testServiceId,
        categoryId: testCategoryId,
        guest: { fullName: 'User Two', email: 'two@example.com', phone: '555-0002' },
        serviceSnapshot: { name: 'Detail Two', slug: 'detail-two' },
        vehicleSnapshot: { category: 'suv', make: 'Honda', model: 'CR-V', year: 2023 },
        scheduledAt: new Date('2026-11-01T11:00:00.000Z'),
        scheduledLocal: { date: '2026-11-01', slot: '11:00' },
        pricing: { baseCents: 12000, totalCents: 12000, providerPayoutCents: 10000 },
        address: { freeText: '456 Oak Ave', country: 'USA' },
        status: 'pending',
        source: 'web',
        // legacyAppointmentId omitted!
      });

      await expect(booking1.save()).resolves.toBeDefined();
      await expect(booking2.save()).resolves.toBeDefined();

      // Verify neither document stored null
      const rawDocs = await Booking.collection.find({}).toArray();
      for (const d of rawDocs) {
        expect(d.legacyAppointmentId).toBeUndefined();
      }
    });

    it('Feedback: inserts two documents omitting optional unique externalId without collision', async () => {
      await Feedback.deleteMany({});

      const feedback1 = new Feedback({
        name: 'Jane Reviewer',
        email: 'jane@example.com',
        title: 'Outstanding job!',
        feedback: 'Car looked fantastic after ceramic coating.',
        rating: 5,
        status: 'pending',
        source: 'manual',
        // externalId omitted!
      });

      const feedback2 = new Feedback({
        name: 'Bob Reviewer',
        email: 'bob@example.com',
        title: 'Very good service',
        feedback: 'Prompt and courteous detailer.',
        rating: 4,
        status: 'pending',
        source: 'manual',
        // externalId omitted!
      });

      await expect(feedback1.save()).resolves.toBeDefined();
      await expect(feedback2.save()).resolves.toBeDefined();

      const rawDocs = await Feedback.collection.find({}).toArray();
      for (const d of rawDocs) {
        expect(d.externalId).toBeUndefined();
      }
    });

    it('Payment: inserts two documents omitting optional unique stripeCheckoutSessionId and stripePaymentIntentId without collision', async () => {
      await Payment.deleteMany({});
      const bookingId1 = new mongoose.Types.ObjectId();
      const bookingId2 = new mongoose.Types.ObjectId();

      const payment1 = new Payment({
        bookingId: bookingId1,
        amountCents: 5000,
        currency: 'usd',
        status: 'pending',
        refundedCents: 0,
        // stripeCheckoutSessionId and stripePaymentIntentId omitted
      });

      const payment2 = new Payment({
        bookingId: bookingId2,
        amountCents: 8000,
        currency: 'usd',
        status: 'pending',
        refundedCents: 0,
        // stripeCheckoutSessionId and stripePaymentIntentId omitted
      });

      await expect(payment1.save()).resolves.toBeDefined();
      await expect(payment2.save()).resolves.toBeDefined();

      const rawDocs = await Payment.collection.find({}).toArray();
      for (const d of rawDocs) {
        expect(d.stripeCheckoutSessionId).toBeUndefined();
        expect(d.stripePaymentIntentId).toBeUndefined();
      }
    });
  });
});
