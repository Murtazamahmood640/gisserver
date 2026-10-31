/**
 * Concurrency Test Suite using real in-memory MongoDB (MongoMemoryServer).
 * Proves that atomic slot reservation works with real concurrent database operations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { SlotReservation } from '../models/SlotReservation';
import { BookingSettings } from '../models/BookingSettings';
import { Booking } from '../models/Booking';
import { Service } from '../models/Service';
import { ServiceCategory } from '../models/ServiceCategory';
import { ServicePrice } from '../models/ServicePrice';
import {
  AvailabilityService,
  SlotFullError,
} from '../modules/bookings/availability';
import { BookingService } from '../modules/bookings/service';

// Mock email and cloudinary to avoid external dependencies
vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'test-email' }),
  getBookingConfirmationEmail: vi.fn().mockReturnValue('<p>Confirmed</p>'),
  getAdminNotificationEmail: vi.fn().mockReturnValue('<p>Admin</p>'),
  getStatusUpdateEmail: vi.fn().mockReturnValue('<p>Status</p>'),
}));

vi.mock('../utils/cloudinary', () => ({
  uploadToCloudinary: vi.fn().mockResolvedValue('https://res.cloudinary.com/test.jpg'),
  default: { config: vi.fn(), uploader: { upload: vi.fn() } },
}));

describe('Phase 1C Concurrency & Atomic Slot Protection (Real MongoDB)', () => {
  let mongoServer: MongoMemoryServer;
  const testCategoryId = new mongoose.Types.ObjectId();
  const testServiceId = new mongoose.Types.ObjectId();
  const testDate = '2026-12-01';
  const testSlot = '10:00';

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.disconnect();
    await mongoose.connect(uri);

    // Ensure unique compound index on slotReservations
    await SlotReservation.syncIndexes();
    await Booking.syncIndexes();

    // Seed default booking settings
    await BookingSettings.create({
      businessTimezone: 'America/New_York',
      slots: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'],
      slotCapacity: 2,
      minLeadHours: 2,
      maxAdvanceDays: 60,
      cancellation: { freeCancelHours: 24, lateFeePercent: 20 },
      closedDates: [],
    });

    // Seed category and service for end-to-end tests
    await ServiceCategory.create({
      _id: testCategoryId,
      name: 'Mobile Detailing',
      slug: 'mobile-detailing',
      isActive: true,
      sortOrder: 1,
    });

    await Service.create({
      _id: testServiceId,
      categoryId: testCategoryId,
      name: 'Interior Only',
      slug: 'interior-only',
      durationMinutes: 120,
      isActive: true,
      pricingModel: 'by-vehicle-category',
    });

    await ServicePrice.create({
      serviceId: testServiceId,
      vehicleCategory: 'sedan',
      price: 22899,
    });
  }, 240000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  beforeEach(async () => {
    await SlotReservation.deleteMany({});
    await Booking.deleteMany({});
  });

  it('two simultaneous requests for the last slot result in exactly one success and one 409 SLOT_FULL', async () => {
    const capacity = 2;

    // Pre-fill the slot to capacity - 1 (count = 1), so only 1 slot remains
    await SlotReservation.create({
      date: testDate,
      slot: testSlot,
      categoryId: testCategoryId,
      count: 1,
    });

    // Launch two parallel requests simultaneously for the single remaining spot
    const [res1, res2] = await Promise.allSettled([
      AvailabilityService.reserveSlotAtomic(testDate, testSlot, testCategoryId, capacity),
      AvailabilityService.reserveSlotAtomic(testDate, testSlot, testCategoryId, capacity),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
    const rejected = [res1, res2].filter((r) => r.status === 'rejected');

    // Exactly one must succeed and one must fail
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    if (fulfilled[0].status === 'fulfilled') {
      expect(fulfilled[0].value).toBe(true);
    }

    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(SlotFullError);
      expect((rejected[0].reason as SlotFullError).statusCode).toBe(409);
      expect((rejected[0].reason as SlotFullError).code).toBe('SLOT_FULL');
    }

    // Verify database count in real MongoDB never exceeded capacity
    const reservation = await SlotReservation.findOne({
      date: testDate,
      slot: testSlot,
      categoryId: testCategoryId,
    });
    expect(reservation?.count).toBe(2);
  });

  it('reservation release on failed booking creation during save', async () => {
    const capacity = 2;

    // Spy on Booking.prototype.save to force a simulated failure
    const saveSpy = vi.spyOn(Booking.prototype, 'save').mockRejectedValueOnce(
      new Error('Database write error during booking persistence')
    );

    await expect(
      BookingService.createBooking({
        serviceId: testServiceId.toString(),
        vehicleCategory: 'sedan',
        date: testDate,
        slot: testSlot,
        guest: {
          fullName: 'Failing Booking Customer',
          email: 'failing@example.com',
          phone: '555-9999',
        },
      })
    ).rejects.toThrow('Database write error during booking persistence');

    saveSpy.mockRestore();

    // Verify slot reservation count was rolled back to 0
    const reservation = await SlotReservation.findOne({
      date: testDate,
      slot: testSlot,
      categoryId: testCategoryId,
    });

    expect(reservation?.count ?? 0).toBe(0);
  });

  it('reservation release on booking cancellation', async () => {
    // 1. Create a successful booking
    const booking = await BookingService.createBooking({
      serviceId: testServiceId.toString(),
      vehicleCategory: 'sedan',
      date: testDate,
      slot: testSlot,
      guest: {
        fullName: 'Cancel Test Customer',
        email: 'cancel@example.com',
        phone: '555-1234',
      },
    });

    const guestToken = (booking as any).guestAccessToken;
    expect(guestToken).toBeDefined();

    // Check slot reservation is currently 1
    const beforeCancel = await SlotReservation.findOne({
      date: testDate,
      slot: testSlot,
      categoryId: testCategoryId,
    });
    expect(beforeCancel?.count).toBe(1);

    // 2. Cancel the booking
    await BookingService.cancelBooking(
      booking._id.toString(),
      undefined,
      'Change of plans',
      guestToken
    );

    // 3. Verify reservation was released in database
    const afterCancel = await SlotReservation.findOne({
      date: testDate,
      slot: testSlot,
      categoryId: testCategoryId,
    });
    expect(afterCancel?.count).toBe(0);
  });

  it('atomically re-reserves slot and releases old slot on booking reschedule', async () => {
    const newDate = '2026-12-02';
    const newSlot = '14:00';

    // 1. Create initial booking at testDate/testSlot
    const booking = await BookingService.createBooking({
      serviceId: testServiceId.toString(),
      vehicleCategory: 'sedan',
      date: testDate,
      slot: testSlot,
      guest: {
        fullName: 'Reschedule Test Customer',
        email: 'reschedule@example.com',
        phone: '555-5678',
      },
    });

    const guestToken = (booking as any).guestAccessToken;

    // Old slot has 1 reservation
    const oldSlotBefore = await SlotReservation.findOne({
      date: testDate,
      slot: testSlot,
      categoryId: testCategoryId,
    });
    expect(oldSlotBefore?.count).toBe(1);

    // 2. Reschedule to newDate/newSlot
    await BookingService.rescheduleBooking(
      booking._id.toString(),
      undefined,
      { date: newDate, slot: newSlot, reason: 'Prefer afternoon' },
      guestToken
    );

    // 3. Verify old slot is released (0) and new slot is reserved (1)
    const oldSlotAfter = await SlotReservation.findOne({
      date: testDate,
      slot: testSlot,
      categoryId: testCategoryId,
    });
    expect(oldSlotAfter?.count).toBe(0);

    const newSlotAfter = await SlotReservation.findOne({
      date: newDate,
      slot: newSlot,
      categoryId: testCategoryId,
    });
    expect(newSlotAfter?.count).toBe(1);
  });

  it('creates three bookings through BookingService without legacyAppointmentId without sparse index collision', async () => {
    // 3 distinct bookings without legacyAppointmentId
    const b1 = await BookingService.createBooking({
      serviceId: testServiceId.toString(),
      vehicleCategory: 'sedan',
      date: '2026-12-05',
      slot: '09:00',
      guest: { fullName: 'Sparse User 1', email: 'sparse1@example.com', phone: '555-0001' },
    });
    const b2 = await BookingService.createBooking({
      serviceId: testServiceId.toString(),
      vehicleCategory: 'sedan',
      date: '2026-12-05',
      slot: '10:00',
      guest: { fullName: 'Sparse User 2', email: 'sparse2@example.com', phone: '555-0002' },
    });
    const b3 = await BookingService.createBooking({
      serviceId: testServiceId.toString(),
      vehicleCategory: 'sedan',
      date: '2026-12-05',
      slot: '11:00',
      guest: { fullName: 'Sparse User 3', email: 'sparse3@example.com', phone: '555-0003' },
    });

    expect(b1._id).toBeDefined();
    expect(b2._id).toBeDefined();
    expect(b3._id).toBeDefined();

    // Verify in MongoDB that legacyAppointmentId is omitted/undefined (never null)
    const rawB1 = await Booking.findById(b1._id).lean();
    const rawB2 = await Booking.findById(b2._id).lean();
    const rawB3 = await Booking.findById(b3._id).lean();

    expect(rawB1?.legacyAppointmentId).toBeUndefined();
    expect(rawB2?.legacyAppointmentId).toBeUndefined();
    expect(rawB3?.legacyAppointmentId).toBeUndefined();
  });
});
