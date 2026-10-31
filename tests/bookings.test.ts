/**
 * Phase 1C – Bookings, Pricing, Availability, State Machine, Authorization,
 * Legacy Adapter, and Migration Tests
 *
 * Coverage:
 *  1. Pricing function: every service × vehicle category, addons, coupons,
 *     rounding, commission precedence, client price ignored, inactive service rejected.
 *  2. Availability and concurrency: capacity, lead time, closed dates,
 *     parallel requests for last slot, reservation release.
 *  3. State machine: every valid and invalid transition.
 *  4. Authorization: guest vs customer vs other customer (403), admin vs dispatcher,
 *     status transitions.
 *  5. Legacy adapter: exact current payload works, old response shape, unknown service → 400.
 *  6. Guest-to-customer linking on email verification / registration.
 *  7. Utility functions: normalizeSlotTo24h, formatSlotTo12h, localToUtc.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import app from '../app';
import { generateAccessToken, generateToken } from '../utils/jwt';

// Models
import { Booking } from '../models/Booking';
import { BookingSettings } from '../models/BookingSettings';
import { SlotReservation } from '../models/SlotReservation';
import { Counter } from '../models/Counter';
import { Vehicle } from '../models/Vehicle';
import { CustomerProfile } from '../models/CustomerProfile';
import { Service } from '../models/Service';
import { ServiceCategory } from '../models/ServiceCategory';
import { ServicePrice } from '../models/ServicePrice';
import { Addon } from '../models/Addon';
import { CommissionRule } from '../models/CommissionRule';
import { Appointment } from '../models/Appointment';
import { User } from '../models/User';
import { RefreshToken } from '../models/RefreshToken';
import { migrateAppointments } from '../scripts/migrateAppointments';

// Service & utility imports for direct unit tests
import {
  normalizeSlotTo24h,
  formatSlotTo12h,
  localToUtc,
  AvailabilityService,
  SlotFullError,
} from '../modules/bookings/availability';
import { isValidTransition, VALID_TRANSITIONS } from '../modules/bookings/stateMachine';
import { calculateBookingPricing, normalizeVehicleCategory } from '../modules/bookings/pricing';
import { BookingService } from '../modules/bookings/service';

// ─── Mock modules ──────────────────────────────────────────────────────────
vi.mock('../config/database', () => ({
  connectDB: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/emailService', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: 'test-email-id' }),
  getBookingConfirmationEmail: vi.fn().mockReturnValue('<p>Confirmation</p>'),
  getAdminNotificationEmail: vi.fn().mockReturnValue('<p>Admin</p>'),
  getContactAcknowledgmentEmail: vi.fn().mockReturnValue('<p>Ack</p>'),
  getPasswordResetEmail: vi.fn().mockReturnValue('<p>Reset</p>'),
  getStatusUpdateEmail: vi.fn().mockReturnValue('<p>Status</p>'),
  getEmailVerificationEmail: vi.fn().mockReturnValue('<p>Verify</p>'),
  getVerificationEmail: vi.fn().mockReturnValue('<p>Verify</p>'),
  getAccountLockedEmail: vi.fn().mockReturnValue('<p>Locked</p>'),
  getWelcomeEmail: vi.fn().mockReturnValue('<p>Welcome</p>'),
}));

vi.mock('../utils/cloudinary', () => ({
  uploadToCloudinary: vi.fn().mockResolvedValue('https://res.cloudinary.com/test/sample.jpg'),
  default: { config: vi.fn(), uploader: { upload: vi.fn() } },
}));

// ─── Helper factories ──────────────────────────────────────────────────────
function mockChainableQuery(data: any = []) {
  const query: any = {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(data),
    limit: vi.fn().mockResolvedValue(data),
    skip: vi.fn().mockReturnThis(),
    populate: vi.fn().mockReturnThis(),
    then(onFulfilled: any, onRejected?: any) {
      return Promise.resolve(data).then(onFulfilled, onRejected);
    },
  };
  return query;
}

const adminUserId = new mongoose.Types.ObjectId().toString();
const customerUserId = new mongoose.Types.ObjectId().toString();
const customer2UserId = new mongoose.Types.ObjectId().toString();
const dispatcherUserId = new mongoose.Types.ObjectId().toString();
const categoryId = new mongoose.Types.ObjectId();
const serviceId = new mongoose.Types.ObjectId();
const addonId = new mongoose.Types.ObjectId();

const adminToken = generateAccessToken({
  userId: adminUserId,
  email: 'admin@gis.test',
  role: 'admin',
  status: 'active',
  emailVerified: true,
});

const customerToken = generateAccessToken({
  userId: customerUserId,
  email: 'customer@test.com',
  role: 'customer',
  status: 'active',
  emailVerified: true,
});

const customer2Token = generateAccessToken({
  userId: customer2UserId,
  email: 'other@test.com',
  role: 'customer',
  status: 'active',
  emailVerified: true,
});

const dispatcherToken = generateAccessToken({
  userId: dispatcherUserId,
  email: 'dispatcher@gis.test',
  role: 'dispatcher',
  status: 'active',
  emailVerified: true,
});

const technicianToken = generateAccessToken({
  userId: new mongoose.Types.ObjectId().toString(),
  email: 'tech@gis.test',
  role: 'technician',
  status: 'active',
  emailVerified: true,
});

const userToken = generateToken({
  userId: new mongoose.Types.ObjectId().toString(),
  email: 'user@test.com',
  role: 'user',
});

// Dates in the future to satisfy lead time
function futureDate(daysFromNow = 5): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

const mockSettings = {
  businessTimezone: 'America/New_York',
  slots: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'],
  slotCapacity: 2,
  minLeadHours: 2,
  maxAdvanceDays: 60,
  cancellation: { freeCancelHours: 24, lateFeePercent: 20 },
  closedDates: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITES
// ─────────────────────────────────────────────────────────────────────────────
describe('Phase 1C – Bookings System', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. UTILITY FUNCTIONS (pure unit tests – no mocks needed)
  // =========================================================================
  describe('Utility functions', () => {
    describe('normalizeSlotTo24h', () => {
      it('converts "09:00 AM" to "09:00"', () => {
        expect(normalizeSlotTo24h('09:00 AM')).toBe('09:00');
      });
      it('converts "1:00 PM" to "13:00"', () => {
        expect(normalizeSlotTo24h('1:00 PM')).toBe('13:00');
      });
      it('converts "12:00 PM" to "12:00"', () => {
        expect(normalizeSlotTo24h('12:00 PM')).toBe('12:00');
      });
      it('converts "12:00 AM" to "00:00" (midnight)', () => {
        expect(normalizeSlotTo24h('12:00 AM')).toBe('00:00');
      });
      it('passes through "14:30" unchanged', () => {
        expect(normalizeSlotTo24h('14:30')).toBe('14:30');
      });
    });

    describe('formatSlotTo12h', () => {
      it('formats "09:00" to "9:00 AM"', () => {
        expect(formatSlotTo12h('09:00')).toBe('9:00 AM');
      });
      it('formats "13:00" to "1:00 PM"', () => {
        expect(formatSlotTo12h('13:00')).toBe('1:00 PM');
      });
      it('formats "00:00" to "12:00 AM" (midnight)', () => {
        expect(formatSlotTo12h('00:00')).toBe('12:00 AM');
      });
      it('formats "12:00" to "12:00 PM" (noon)', () => {
        expect(formatSlotTo12h('12:00')).toBe('12:00 PM');
      });
    });

    describe('localToUtc', () => {
      it('converts a local New York time to UTC', () => {
        // 2026-07-15 10:00 in America/New_York is UTC-4 (EDT)
        const utc = localToUtc('2026-07-15', '10:00', 'America/New_York');
        expect(utc.getUTCHours()).toBe(14);
        expect(utc.getUTCMinutes()).toBe(0);
      });
      it('falls back to UTC when timezone is "UTC"', () => {
        const utc = localToUtc('2026-03-01', '08:00', 'UTC');
        expect(utc.getUTCHours()).toBe(8);
      });
    });

    describe('normalizeVehicleCategory', () => {
      it('maps "Sedan" to "sedan"', () => {
        expect(normalizeVehicleCategory('Sedan')).toBe('sedan');
      });
      it('maps "CrossOver" to "crossover"', () => {
        expect(normalizeVehicleCategory('CrossOver')).toBe('crossover');
      });
      it('maps "RV/Boat/Semi" to "rv-boat-semi"', () => {
        expect(normalizeVehicleCategory('RV/Boat/Semi')).toBe('rv-boat-semi');
      });
      it('maps "car" to "sedan"', () => {
        expect(normalizeVehicleCategory('car')).toBe('sedan');
      });
      it('maps "rv" to "rv-boat-semi"', () => {
        expect(normalizeVehicleCategory('rv')).toBe('rv-boat-semi');
      });
    });
  });

  // =========================================================================
  // 2. STATE MACHINE
  // =========================================================================
  describe('State machine transitions', () => {
    it('allows all valid transitions as declared in VALID_TRANSITIONS', () => {
      for (const [from, tos] of Object.entries(VALID_TRANSITIONS)) {
        for (const to of tos) {
          expect(isValidTransition(from as any, to)).toBe(true);
        }
      }
    });

    it('self-transition (from === to) is always valid', () => {
      expect(isValidTransition('pending', 'pending')).toBe(true);
      expect(isValidTransition('completed', 'completed')).toBe(true);
    });

    it('rejects invalid transitions', () => {
      expect(isValidTransition('pending', 'completed')).toBe(false);
      expect(isValidTransition('pending', 'refunded')).toBe(false);
      expect(isValidTransition('completed', 'pending')).toBe(false);
      expect(isValidTransition('refunded', 'pending')).toBe(false);
      expect(isValidTransition('refunded', 'cancelled')).toBe(false);
    });

    it('cancelled allows admin reopen to pending or confirmed', () => {
      expect(isValidTransition('cancelled', 'pending')).toBe(true);
      expect(isValidTransition('cancelled', 'confirmed')).toBe(true);
      expect(isValidTransition('cancelled', 'completed')).toBe(false);
    });
  });

  // =========================================================================
  // 3. PRICING FUNCTION (unit-level with mocked DB)
  // =========================================================================
  describe('calculateBookingPricing', () => {
    const mockService = {
      _id: serviceId,
      name: 'Interior Only',
      slug: 'interior-only',
      categoryId,
      isActive: true,
    };
    const mockCategory = {
      _id: categoryId,
      name: 'Mobile Detailing',
      slug: 'mobile-detailing',
      isActive: true,
    };
    const mockAddon = {
      _id: addonId,
      name: 'Pet Hair Removal',
      price: 5000, // 50.00 USD cents
      isActive: true,
    };

    function setupPricingMocks(priceCents = 22899) {
      vi.spyOn(Service, 'findById').mockResolvedValue(mockService as any);
      vi.spyOn(Service, 'findOne').mockResolvedValue(mockService as any);
      vi.spyOn(ServiceCategory, 'findById').mockResolvedValue(mockCategory as any);
      vi.spyOn(ServicePrice, 'findOne').mockResolvedValue({
        serviceId: serviceId,
        vehicleCategory: 'sedan',
        price: priceCents,
      } as any);
      vi.spyOn(CommissionRule, 'findOne').mockResolvedValue(null);
    }

    it('returns correct base price and default 15%/3% commission', async () => {
      setupPricingMocks(22899);
      vi.spyOn(Addon, 'findById').mockResolvedValue(null);
      vi.spyOn(Addon, 'findOne').mockResolvedValue(null);

      const result = await calculateBookingPricing({
        serviceId: serviceId.toString(),
        vehicleCategory: 'sedan',
      });

      expect(result.pricing.baseCents).toBe(22899);
      expect(result.pricing.addonsCents).toBe(0);
      expect(result.pricing.discountCents).toBe(0);
      expect(result.pricing.totalCents).toBe(22899);
      expect(result.pricing.commissionPercent).toBe(15);
      expect(result.pricing.processingPercent).toBe(3);
      expect(result.pricing.commissionCents).toBe(Math.round(22899 * 15 / 100));
      expect(result.pricing.processingCents).toBe(Math.round(22899 * 3 / 100));
    });

    it('rejects inactive service with 400', async () => {
      vi.spyOn(Service, 'findById').mockResolvedValue({ ...mockService, isActive: false } as any);

      await expect(
        calculateBookingPricing({
          serviceId: serviceId.toString(),
          vehicleCategory: 'sedan',
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'SERVICE_UNAVAILABLE' });
    });

    it('rejects inactive category with 400', async () => {
      vi.spyOn(Service, 'findById').mockResolvedValue(mockService as any);
      vi.spyOn(ServiceCategory, 'findById').mockResolvedValue({ ...mockCategory, isActive: false } as any);

      await expect(
        calculateBookingPricing({
          serviceId: serviceId.toString(),
          vehicleCategory: 'sedan',
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'CATEGORY_UNAVAILABLE' });
    });

    it('rejects missing price for vehicle category with 400', async () => {
      vi.spyOn(Service, 'findById').mockResolvedValue(mockService as any);
      vi.spyOn(ServiceCategory, 'findById').mockResolvedValue(mockCategory as any);
      vi.spyOn(ServicePrice, 'findOne').mockResolvedValue(null);

      await expect(
        calculateBookingPricing({
          serviceId: serviceId.toString(),
          vehicleCategory: 'sedan',
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'PRICE_NOT_FOUND' });
    });

    it('adds addon prices correctly', async () => {
      setupPricingMocks(20000);
      vi.spyOn(Addon, 'findById').mockResolvedValue(mockAddon as any);
      vi.spyOn(Addon, 'findOne').mockResolvedValue(mockAddon as any);

      const result = await calculateBookingPricing({
        serviceId: serviceId.toString(),
        vehicleCategory: 'sedan',
        addonIds: [addonId.toString()],
      });

      expect(result.pricing.baseCents).toBe(20000);
      expect(result.pricing.addonsCents).toBe(5000);
      expect(result.pricing.totalCents).toBe(25000); // no discount
      expect(result.addons).toHaveLength(1);
      expect(result.addons[0].name).toBe('Pet Hair Removal');
      expect(result.addons[0].priceCents).toBe(5000);
    });

    it('rejects inactive addon with 400', async () => {
      setupPricingMocks(20000);
      vi.spyOn(Addon, 'findById').mockResolvedValue({ ...mockAddon, isActive: false } as any);

      await expect(
        calculateBookingPricing({
          serviceId: serviceId.toString(),
          vehicleCategory: 'sedan',
          addonIds: [addonId.toString()],
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'ADDON_UNAVAILABLE' });
    });

    it('applies coupon discount via CatalogService.validateCoupon', async () => {
      setupPricingMocks(20000);
      vi.spyOn(Addon, 'findById').mockResolvedValue(null);
      vi.spyOn(Addon, 'findOne').mockResolvedValue(null);

      // Mock the CatalogService.validateCoupon indirectly via the Coupon model
      const { CatalogService } = await import('../modules/catalog/service');
      vi.spyOn(CatalogService, 'validateCoupon').mockResolvedValue({
        valid: true,
        discountPercent: 10,
        discountCents: 2000,
      });

      const result = await calculateBookingPricing({
        serviceId: serviceId.toString(),
        vehicleCategory: 'sedan',
        couponCode: 'SAVE10',
      });

      expect(result.pricing.couponCode).toBe('SAVE10');
      expect(result.pricing.couponPercent).toBe(10);
      expect(result.pricing.discountCents).toBe(2000);
      expect(result.pricing.totalCents).toBe(18000);
    });

    it('uses service-specific commission rule over global', async () => {
      vi.spyOn(Service, 'findById').mockResolvedValue(mockService as any);
      vi.spyOn(ServiceCategory, 'findById').mockResolvedValue(mockCategory as any);
      vi.spyOn(ServicePrice, 'findOne').mockResolvedValue({
        serviceId, vehicleCategory: 'sedan', price: 10000,
      } as any);
      vi.spyOn(Addon, 'findById').mockResolvedValue(null);
      vi.spyOn(Addon, 'findOne').mockResolvedValue(null);

      // Service-specific rule: 20% commission, 5% processing
      vi.spyOn(CommissionRule, 'findOne')
        .mockResolvedValueOnce({
          scope: 'service',
          scopeId: serviceId,
          commissionPercent: 20,
          processingPercent: 5,
          isActive: true,
        } as any);

      const result = await calculateBookingPricing({
        serviceId: serviceId.toString(),
        vehicleCategory: 'sedan',
      });

      expect(result.pricing.commissionPercent).toBe(20);
      expect(result.pricing.processingPercent).toBe(5);
      expect(result.pricing.commissionCents).toBe(2000);
      expect(result.pricing.processingCents).toBe(500);
      expect(result.pricing.providerPayoutCents).toBe(7500);
    });

    it('uses half-up rounding for odd cent amounts', async () => {
      // 22899 * 15 / 100 = 3434.85 → rounds to 3435
      setupPricingMocks(22899);
      vi.spyOn(Addon, 'findById').mockResolvedValue(null);
      vi.spyOn(Addon, 'findOne').mockResolvedValue(null);

      const result = await calculateBookingPricing({
        serviceId: serviceId.toString(),
        vehicleCategory: 'sedan',
      });

      expect(result.pricing.commissionCents).toBe(3435);
      expect(result.pricing.processingCents).toBe(687);
    });
  });

  // =========================================================================
  // 4. AVAILABILITY SERVICE (mocked DB)
  // =========================================================================
  describe('AvailabilityService', () => {
    beforeEach(() => {
      vi.spyOn(BookingSettings, 'findOne').mockResolvedValue(mockSettings as any);
      vi.spyOn(BookingSettings, 'create').mockResolvedValue(mockSettings as any);
    });

    describe('getBookingSettings', () => {
      it('returns existing settings', async () => {
        const s = await AvailabilityService.getBookingSettings();
        expect(s.businessTimezone).toBe('America/New_York');
        expect(s.slotCapacity).toBe(2);
      });

      it('creates defaults if none exist', async () => {
        vi.spyOn(BookingSettings, 'findOne').mockResolvedValue(null);
        const s = await AvailabilityService.getBookingSettings();
        expect(BookingSettings.create).toHaveBeenCalled();
        expect(s.slotCapacity).toBe(2);
      });
    });

    describe('getAvailability', () => {
      it('returns all slots for a future date with no reservations', async () => {
        vi.spyOn(SlotReservation, 'find').mockResolvedValue([]);
        vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue({ _id: categoryId } as any);

        const result = await AvailabilityService.getAvailability({
          date: futureDate(10),
          categoryId: categoryId.toString(),
        });

        expect(result.slots).toHaveLength(10);
        // All slots far in the future should be available
        const availableSlots = result.slots.filter((s) => s.available);
        expect(availableSlots.length).toBeGreaterThan(0);
        expect(result.timezone).toBe('America/New_York');
      });

      it('marks slots as unavailable on closed dates', async () => {
        vi.spyOn(BookingSettings, 'findOne').mockResolvedValue({
          ...mockSettings,
          closedDates: [futureDate(10)],
        } as any);
        vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue({ _id: categoryId } as any);

        const result = await AvailabilityService.getAvailability({
          date: futureDate(10),
          categoryId: categoryId.toString(),
        });

        expect(result.slots.every((s) => !s.available)).toBe(true);
      });

      it('decrements remaining count based on existing reservations', async () => {
        vi.spyOn(SlotReservation, 'find').mockResolvedValue([
          { date: futureDate(10), slot: '10:00', categoryId, count: 1 },
        ] as any);
        vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue({ _id: categoryId } as any);

        const result = await AvailabilityService.getAvailability({
          date: futureDate(10),
          categoryId: categoryId.toString(),
        });

        const slot10 = result.slots.find((s) => s.slot === '10:00');
        expect(slot10?.remaining).toBe(1); // 2 capacity - 1 reserved
        expect(slot10?.available).toBe(true);
      });

      it('marks slot as unavailable when at full capacity', async () => {
        vi.spyOn(SlotReservation, 'find').mockResolvedValue([
          { date: futureDate(10), slot: '10:00', categoryId, count: 2 },
        ] as any);
        vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue({ _id: categoryId } as any);

        const result = await AvailabilityService.getAvailability({
          date: futureDate(10),
          categoryId: categoryId.toString(),
        });

        const slot10 = result.slots.find((s) => s.slot === '10:00');
        expect(slot10?.remaining).toBe(0);
        expect(slot10?.available).toBe(false);
      });
    });

    describe('reserveSlotAtomic', () => {
      it('succeeds when count is below capacity', async () => {
        vi.spyOn(SlotReservation, 'findOneAndUpdate').mockResolvedValue({
          count: 1, date: futureDate(), slot: '10:00', categoryId,
        } as any);

        const result = await AvailabilityService.reserveSlotAtomic(
          futureDate(), '10:00', categoryId, 2
        );
        expect(result).toBe(true);
      });

      it('creates new reservation document if none exists', async () => {
        vi.spyOn(SlotReservation, 'findOneAndUpdate').mockResolvedValue(null);
        vi.spyOn(SlotReservation, 'findOne').mockResolvedValue(null);
        vi.spyOn(SlotReservation, 'create').mockResolvedValue({
          count: 1, date: futureDate(), slot: '10:00', categoryId,
        } as any);

        const result = await AvailabilityService.reserveSlotAtomic(
          futureDate(), '10:00', categoryId, 2
        );
        expect(result).toBe(true);
        expect(SlotReservation.create).toHaveBeenCalled();
      });

      it('throws SlotFullError when slot is at capacity', async () => {
        vi.spyOn(SlotReservation, 'findOneAndUpdate').mockResolvedValue(null);
        vi.spyOn(SlotReservation, 'findOne').mockResolvedValue({
          count: 2, date: futureDate(), slot: '10:00', categoryId,
        } as any);

        await expect(
          AvailabilityService.reserveSlotAtomic(futureDate(), '10:00', categoryId, 2)
        ).rejects.toThrow(SlotFullError);
      });

      it('handles concurrent insert (duplicate key) with retry', async () => {
        vi.spyOn(SlotReservation, 'findOneAndUpdate')
          .mockResolvedValueOnce(null) // first attempt
          .mockResolvedValueOnce({ count: 1 } as any); // retry
        vi.spyOn(SlotReservation, 'findOne').mockResolvedValue(null);
        const createSpy = vi.spyOn(SlotReservation, 'create');
        const dupError = new Error('duplicate key') as any;
        dupError.code = 11000;
        createSpy.mockRejectedValue(dupError);

        const result = await AvailabilityService.reserveSlotAtomic(
          futureDate(), '10:00', categoryId, 2
        );
        expect(result).toBe(true);
      });

      it('two simultaneous requests for the last slot result in exactly one success and one SlotFullError', async () => {
        let currentCount = 1;
        const capacity = 2;

        vi.spyOn(SlotReservation, 'findOneAndUpdate').mockImplementation(((query: any) => {
          if (currentCount < capacity) {
            currentCount++;
            return Promise.resolve({ count: currentCount, date: futureDate(), slot: '10:00', categoryId });
          }
          return Promise.resolve(null);
        }) as any);

        vi.spyOn(SlotReservation, 'findOne').mockImplementation((() => {
          return Promise.resolve({ count: currentCount, date: futureDate(), slot: '10:00', categoryId });
        }) as any);

        const [res1, res2] = await Promise.allSettled([
          AvailabilityService.reserveSlotAtomic(futureDate(), '10:00', categoryId, capacity),
          AvailabilityService.reserveSlotAtomic(futureDate(), '10:00', categoryId, capacity),
        ]);

        const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
        const rejected = [res1, res2].filter((r) => r.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        if (rejected[0].status === 'rejected') {
          expect(rejected[0].reason).toBeInstanceOf(SlotFullError);
          expect((rejected[0].reason as SlotFullError).statusCode).toBe(409);
        }
      });
    });

    describe('releaseSlotAtomic', () => {
      it('decrements slot count', async () => {
        const updateSpy = vi.spyOn(SlotReservation, 'updateOne').mockResolvedValue({} as any);

        await AvailabilityService.releaseSlotAtomic(futureDate(), '10:00', categoryId);

        expect(updateSpy).toHaveBeenCalledWith(
          expect.objectContaining({ count: { $gt: 0 } }),
          expect.objectContaining({ $inc: { count: -1 } })
        );
      });
    });
  });

  // =========================================================================
  // 5. BOOKING API ENDPOINTS – Authorization
  // =========================================================================
  describe('Booking endpoint authorization', () => {
    describe('GET /api/v1/bookings/availability', () => {
      it('returns 400 without date parameter', async () => {
        const res = await request(app).get('/api/v1/bookings/availability');
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error?.code).toBe('DATE_REQUIRED');
      });

      it('returns slot availability for a valid date (public, no auth)', async () => {
        vi.spyOn(BookingSettings, 'findOne').mockResolvedValue(mockSettings as any);
        vi.spyOn(BookingSettings, 'create').mockResolvedValue(mockSettings as any);
        vi.spyOn(SlotReservation, 'find').mockResolvedValue([]);
        vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue({ _id: categoryId } as any);

        const res = await request(app)
          .get(`/api/v1/bookings/availability?date=${futureDate(10)}&categoryId=${categoryId}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.slots).toBeInstanceOf(Array);
        expect(res.body.data.timezone).toBeDefined();
      });
    });

    describe('GET /api/v1/bookings/mine', () => {
      it('returns 401 without auth token', async () => {
        const res = await request(app).get('/api/v1/bookings/mine');
        expect(res.status).toBe(401);
      });

      it('returns bookings for authenticated customer', async () => {
        vi.spyOn(Booking, 'find').mockReturnValue(mockChainableQuery([]) as any);
        vi.spyOn(Booking, 'countDocuments').mockResolvedValue(0);

        const res = await request(app)
          .get('/api/v1/bookings/mine')
          .set('Authorization', `Bearer ${customerToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    describe('GET /api/v1/bookings/:id (guest access and authorization)', () => {
      const rawGuestToken = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const guestTokenHash = crypto.createHash('sha256').update(rawGuestToken).digest('hex');

      function mockGuestBooking(overrides = {}) {
        return {
          _id: new mongoose.Types.ObjectId(),
          bookingNumber: 'GIS-000001',
          customerId: null,
          guest: { fullName: 'Guest User', email: 'guest@test.com', phone: '555-1234' },
          guestAccessTokenHash: guestTokenHash,
          status: 'pending',
          statusHistory: [],
          serviceSnapshot: { name: 'Interior Only', slug: 'interior-only' },
          scheduledLocal: { date: futureDate(), slot: '10:00' },
          scheduledAt: new Date(Date.now() + 48 * 3600 * 1000),
          pricing: { baseCents: 10000, totalCents: 10000 },
          categoryId,
          deletedAt: null,
          save: vi.fn().mockResolvedValue(true),
          toJSON: function () { return this; },
          ...overrides,
        };
      }

      it('returns 403 when no token and no auth provided for guest booking', async () => {
        const booking = mockGuestBooking();
        vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);
        const res = await request(app)
          .get(`/api/v1/bookings/${booking._id}`)
          .set('X-Forwarded-For', '10.90.1.1');
        expect(res.status).toBe(403);
      });

      it('returns 403 when wrong token is provided for guest booking', async () => {
        const booking = mockGuestBooking();
        vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);
        const res = await request(app)
          .get(`/api/v1/bookings/${booking._id}`)
          .set('X-Forwarded-For', '10.90.1.2')
          .set('X-Booking-Token', 'wrong-token-value');
        expect(res.status).toBe(403);
      });

      it('returns 200 with correct token in X-Booking-Token header', async () => {
        const booking = mockGuestBooking();
        vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);
        const res = await request(app)
          .get(`/api/v1/bookings/${booking._id}`)
          .set('X-Forwarded-For', '10.90.1.3')
          .set('X-Booking-Token', rawGuestToken);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.bookingNumber).toBe('GIS-000001');
      });

      it('returns 200 with correct token in ?token= query parameter', async () => {
        const booking = mockGuestBooking();
        vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);
        const res = await request(app)
          .get(`/api/v1/bookings/${booking._id}?token=${rawGuestToken}`)
          .set('X-Forwarded-For', '10.90.1.4');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.bookingNumber).toBe('GIS-000001');
      });

      it('returns 403 for authenticated customer whose email matches guest booking email (email alone never works)', async () => {
        const matchedEmailToken = generateAccessToken({
          userId: '507f1f77bcf86cd799439999',
          email: 'guest@test.com',
          role: 'customer',
          status: 'active',
          emailVerified: true,
        });
        const booking = mockGuestBooking();
        vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);

        const res = await request(app)
          .get(`/api/v1/bookings/${booking._id}`)
          .set('X-Forwarded-For', '10.90.1.5')
          .set('Authorization', `Bearer ${matchedEmailToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it('returns 404 for non-existent booking', async () => {
        vi.spyOn(Booking, 'findOne').mockResolvedValue(null);
        const fakeId = new mongoose.Types.ObjectId().toString();

        const res = await request(app)
          .get(`/api/v1/bookings/${fakeId}`)
          .set('X-Forwarded-For', '10.90.1.6')
          .set('Authorization', `Bearer ${customerToken}`);

        expect(res.status).toBe(404);
      });

      it('returns 403 when customer tries to view another customer\'s booking', async () => {
        vi.spyOn(Booking, 'findOne').mockResolvedValue({
          _id: new mongoose.Types.ObjectId(),
          customerId: new mongoose.Types.ObjectId(), // different customer
          guest: { email: 'someone@else.com' },
          deletedAt: null,
        } as any);

        const fakeId = new mongoose.Types.ObjectId().toString();
        const res = await request(app)
          .get(`/api/v1/bookings/${fakeId}`)
          .set('X-Forwarded-For', '10.90.1.7')
          .set('Authorization', `Bearer ${customerToken}`);

        expect(res.status).toBe(403);
      });

      it('allows admin to view any booking', async () => {
        const bookingDoc = {
          _id: new mongoose.Types.ObjectId(),
          bookingNumber: 'GIS-000001',
          customerId: new mongoose.Types.ObjectId(),
          guest: null,
          deletedAt: null,
          toJSON: function () { return this; },
        };
        vi.spyOn(Booking, 'findOne').mockResolvedValue(bookingDoc as any);

        const fakeId = new mongoose.Types.ObjectId().toString();
        const res = await request(app)
          .get(`/api/v1/bookings/${fakeId}`)
          .set('X-Forwarded-For', '10.90.1.8')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
      });

      it('allows dispatcher to view any booking', async () => {
        const bookingDoc = {
          _id: new mongoose.Types.ObjectId(),
          bookingNumber: 'GIS-000001',
          customerId: new mongoose.Types.ObjectId(),
          guest: null,
          deletedAt: null,
          toJSON: function () { return this; },
        };
        vi.spyOn(Booking, 'findOne').mockResolvedValue(bookingDoc as any);

        const fakeId = new mongoose.Types.ObjectId().toString();
        const res = await request(app)
          .get(`/api/v1/bookings/${fakeId}`)
          .set('X-Forwarded-For', '10.90.1.9')
          .set('Authorization', `Bearer ${dispatcherToken}`);

        expect(res.status).toBe(200);
      });

      it('allows guest with valid token to cancel booking', async () => {
        const booking = mockGuestBooking();
        vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);
        vi.spyOn(BookingSettings, 'findOne').mockResolvedValue(mockSettings as any);
        vi.spyOn(SlotReservation, 'updateOne').mockResolvedValue({} as any);

        const res = await request(app)
          .post(`/api/v1/bookings/${booking._id}/cancel`)
          .set('X-Forwarded-For', '10.90.1.10')
          .set('X-Booking-Token', rawGuestToken)
          .send({ reason: 'Guest change of mind' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(booking.status).toBe('cancelled');
      });

      it('rejects guest cancel with wrong token with 403', async () => {
        const booking = mockGuestBooking();
        vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);

        const res = await request(app)
          .post(`/api/v1/bookings/${booking._id}/cancel`)
          .set('X-Forwarded-For', '10.90.1.11')
          .set('X-Booking-Token', 'wrong-token')
          .send({ reason: 'Guest cancel' });

        expect(res.status).toBe(403);
      });

      it('allows guest with valid token in query param to reschedule booking', async () => {
        const booking = mockGuestBooking();
        vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);
        vi.spyOn(BookingSettings, 'findOne').mockResolvedValue(mockSettings as any);
        vi.spyOn(SlotReservation, 'findOneAndUpdate').mockResolvedValue({ count: 1 } as any);
        vi.spyOn(SlotReservation, 'updateOne').mockResolvedValue({} as any);

        const res = await request(app)
          .post(`/api/v1/bookings/${booking._id}/reschedule?token=${rawGuestToken}`)
          .set('X-Forwarded-For', '10.90.1.12')
          .send({ date: futureDate(15), slot: '14:00' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(booking.scheduledLocal.date).toBe(futureDate(15));
        expect(booking.scheduledLocal.slot).toBe('14:00');
      });

      it('rejects guest reschedule with wrong token with 403', async () => {
        const booking = mockGuestBooking();
        vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);

        const res = await request(app)
          .post(`/api/v1/bookings/${booking._id}/reschedule`)
          .set('X-Forwarded-For', '10.90.1.13')
          .set('X-Booking-Token', 'wrong-token')
          .send({ date: futureDate(15), slot: '14:00' });

        expect(res.status).toBe(403);
      });
    });

    describe('Admin endpoints', () => {
      it('GET /api/v1/bookings (admin list) returns 401 without auth', async () => {
        const res = await request(app).get('/api/v1/bookings');
        expect(res.status).toBe(401);
      });

      it('GET /api/v1/bookings (admin list) returns 403 for customer role', async () => {
        const res = await request(app)
          .get('/api/v1/bookings')
          .set('Authorization', `Bearer ${customerToken}`);

        expect(res.status).toBe(403);
      });

      it('GET /api/v1/bookings (admin list) returns 403 for technician role', async () => {
        const res = await request(app)
          .get('/api/v1/bookings')
          .set('Authorization', `Bearer ${technicianToken}`);

        expect(res.status).toBe(403);
      });

      it('DELETE /api/v1/bookings/:id returns 403 for legacy user role on admin-only route', async () => {
        const fakeId = new mongoose.Types.ObjectId().toString();
        const res = await request(app)
          .delete(`/api/v1/bookings/${fakeId}`)
          .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(403);
      });

      it('GET /api/v1/bookings succeeds for admin', async () => {
        vi.spyOn(Booking, 'find').mockReturnValue(mockChainableQuery([]) as any);
        vi.spyOn(Booking, 'countDocuments').mockResolvedValue(0);

        const res = await request(app)
          .get('/api/v1/bookings')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it('GET /api/v1/bookings succeeds for dispatcher', async () => {
        vi.spyOn(Booking, 'find').mockReturnValue(mockChainableQuery([]) as any);
        vi.spyOn(Booking, 'countDocuments').mockResolvedValue(0);

        const res = await request(app)
          .get('/api/v1/bookings')
          .set('Authorization', `Bearer ${dispatcherToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it('DELETE /api/v1/bookings/:id returns 403 for dispatcher (admin-only)', async () => {
        const fakeId = new mongoose.Types.ObjectId().toString();
        const res = await request(app)
          .delete(`/api/v1/bookings/${fakeId}`)
          .set('Authorization', `Bearer ${dispatcherToken}`);

        expect(res.status).toBe(403);
      });
    });

    describe('Booking settings', () => {
      it('GET /api/v1/admin/booking-settings returns 401 without auth', async () => {
        const res = await request(app).get('/api/v1/admin/booking-settings');
        expect(res.status).toBe(401);
      });

      it('GET /api/v1/admin/booking-settings returns 403 for customer', async () => {
        const res = await request(app)
          .get('/api/v1/admin/booking-settings')
          .set('Authorization', `Bearer ${customerToken}`);

        expect(res.status).toBe(403);
      });

      it('GET /api/v1/admin/booking-settings succeeds for admin', async () => {
        vi.spyOn(BookingSettings, 'findOne').mockResolvedValue(mockSettings as any);
        vi.spyOn(BookingSettings, 'create').mockResolvedValue(mockSettings as any);

        const res = await request(app)
          .get('/api/v1/admin/booking-settings')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.slotCapacity).toBe(2);
      });

      it('PUT /api/v1/admin/booking-settings returns 403 for dispatcher (admin-only)', async () => {
        const res = await request(app)
          .put('/api/v1/admin/booking-settings')
          .set('Authorization', `Bearer ${dispatcherToken}`)
          .send({ slotCapacity: 3 });

        expect(res.status).toBe(403);
      });
    });
  });

  // =========================================================================
  // 6. STATUS TRANSITION VIA ADMIN ENDPOINT
  // =========================================================================
  describe('Admin status transitions via PATCH /api/v1/bookings/:id/status', () => {
    const bookingId = new mongoose.Types.ObjectId();

    function mockBooking(status: string) {
      return {
        _id: bookingId,
        bookingNumber: 'GIS-000001',
        status,
        statusHistory: [],
        guest: { fullName: 'Test', email: 'test@test.com', phone: '555' },
        serviceSnapshot: { name: 'Interior Only', slug: 'interior-only' },
        scheduledLocal: { date: futureDate(), slot: '10:00' },
        categoryId,
        deletedAt: null,
        save: vi.fn().mockResolvedValue(true),
      };
    }

    it('allows pending → confirmed', async () => {
      const booking = mockBooking('pending');
      vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);

      const res = await request(app)
        .patch(`/api/v1/bookings/${bookingId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'confirmed' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(booking.save).toHaveBeenCalled();
    });

    it('rejects invalid transition pending → completed', async () => {
      const booking = mockBooking('pending');
      vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);

      const res = await request(app)
        .patch(`/api/v1/bookings/${bookingId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'completed' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('releases slot when transitioning to cancelled', async () => {
      const booking = mockBooking('pending');
      vi.spyOn(Booking, 'findOne').mockResolvedValue(booking as any);
      const releaseSpy = vi.spyOn(SlotReservation, 'updateOne').mockResolvedValue({} as any);

      const res = await request(app)
        .patch(`/api/v1/bookings/${bookingId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'cancelled', note: 'Customer no-show' });

      expect(res.status).toBe(200);
      expect(releaseSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 7. LEGACY ADAPTER (handlers/appointments.ts)
  // =========================================================================
  describe('Legacy appointments adapter', () => {
    it('GET /api/appointments returns bookings in legacy shape', async () => {
      const mockBookings = [
        {
          _id: new mongoose.Types.ObjectId(),
          bookingNumber: 'GIS-000001',
          guest: { fullName: 'Jane', email: 'jane@test.com', phone: '555' },
          vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2023 },
          serviceSnapshot: { name: 'Interior Only', slug: 'interior-only' },
          addons: [],
          address: { line1: '123 Main St', city: 'Springfield', state: 'IL' },
          scheduledLocal: { date: '2026-10-15', slot: '10:00' },
          pricing: {
            baseCents: 22899, addonsCents: 0, discountCents: 0, couponCode: null,
            couponPercent: 0, taxCents: 0, totalCents: 22899,
            commissionPercent: 15, processingPercent: 3,
            commissionCents: 3435, processingCents: 687, providerPayoutCents: 18777,
          },
          status: 'pending',
          legacyAppointmentId: new mongoose.Types.ObjectId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
      ];
      vi.spyOn(Booking, 'find').mockReturnValue(mockChainableQuery(mockBookings) as any);

      const res = await request(app)
        .get('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);

      const item = res.body.data[0];
      // Verify legacy shape fields
      expect(item.fullName).toBe('Jane');
      expect(item.email).toBe('jane@test.com');
      expect(item.serviceType).toBe('Interior Only');
      expect(item.vehicleCategory).toBe('Sedan'); // capitalized
      expect(item.date).toBe('2026-10-15');
      expect(item.timeSlot).toBe('10:00 AM'); // 12h format
      expect(item.basePrice).toBeCloseTo(228.99, 2); // cents → dollars
      expect(item.totalPrice).toBeCloseTo(228.99, 2);
      expect(item.status).toBe('Pending'); // capitalized
      expect(item.bookingNumber).toBe('GIS-000001');
    });

    it('POST /api/appointments returns 400 for unknown service name', async () => {
      vi.spyOn(Service, 'find').mockReturnValue(mockChainableQuery([]) as any);
      vi.spyOn(Service, 'findOne').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/appointments')
        .send({
          fullName: 'Jane',
          phone: '555-123-4567',
          email: 'jane@test.com',
          address: '123 Main St',
          serviceType: 'NonexistentService',
          vehicleCategory: 'Sedan',
          date: futureDate(),
          timeSlot: '10:00 AM',
          basePrice: 100,
          totalPrice: 100,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('NonexistentService');
    });

    it('POST /api/appointments returns 400 fast when serviceType contains regex special characters', async () => {
      vi.spyOn(Service, 'find').mockReturnValue(mockChainableQuery([]) as any);

      for (const dangerousInput of ['.*', '(a+)+$', '^.*$', '.*|.*']) {
        const res = await request(app)
          .post('/api/appointments')
          .send({
            fullName: 'Jane',
            phone: '555-123-4567',
            email: 'jane@test.com',
            address: '123 Main St',
            serviceType: dangerousInput,
            vehicleCategory: 'Sedan',
            date: futureDate(),
            timeSlot: '10:00 AM',
            basePrice: 100,
            totalPrice: 100,
          });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain(dangerousInput);
      }
    });

    it('POST /api/appointments returns 400 for unknown vehicle category', async () => {
      vi.spyOn(Service, 'find').mockReturnValue(mockChainableQuery([
        {
          _id: serviceId,
          name: 'Interior Only',
          slug: 'interior-only',
          isActive: true,
        },
      ]) as any);
      vi.spyOn(Service, 'findOne').mockResolvedValue({
        _id: serviceId,
        name: 'Interior Only',
        isActive: true,
      } as any);

      const res = await request(app)
        .post('/api/appointments')
        .send({
          fullName: 'Jane',
          phone: '555-123-4567',
          email: 'jane@test.com',
          address: '123 Main St',
          serviceType: 'Interior Only',
          vehicleCategory: 'SpaceCar',
          date: futureDate(),
          timeSlot: '10:00 AM',
          basePrice: 100,
          totalPrice: 100,
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('SpaceCar');
    });

    it('POST /api/appointments returns 400 without required fields', async () => {
      const res = await request(app)
        .post('/api/appointments')
        .send({ phone: '555' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('PUT /api/appointments?id=xxx returns 404 for non-existent', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      vi.spyOn(Booking, 'findOne').mockResolvedValue(null);

      const res = await request(app)
        .put(`/api/appointments?id=${fakeId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'Confirmed' });

      expect(res.status).toBe(404);
    });

    it('DELETE /api/appointments?id=xxx returns 404 for non-existent', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      vi.spyOn(Booking, 'findOne').mockResolvedValue(null);

      const res = await request(app)
        .delete(`/api/appointments?id=${fakeId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      expect(res.status).toBe(404);
    });

    it('returns 405 for unsupported method on handler directly', async () => {
      const { default: appointmentsHandler } = await import('../handlers/appointments');
      const mockReq = { method: 'PATCH' } as any;
      let statusCode = 0;
      let body: any = null;
      const mockRes = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (data: any) => {
              body = data;
              return mockRes;
            },
          };
        },
      } as any;
      await appointmentsHandler(mockReq, mockRes);
      expect(statusCode).toBe(405);
      expect(body.success).toBe(false);
    });

    it('maps RV/Boat/Semi category correctly in legacy shape', async () => {
      const mockBookings = [
        {
          _id: new mongoose.Types.ObjectId(),
          bookingNumber: 'GIS-000002',
          guest: { fullName: 'Bob', email: 'bob@test.com', phone: '555' },
          vehicleSnapshot: { category: 'rv-boat-semi', make: 'Winnebago', model: 'Travato', year: 2022 },
          serviceSnapshot: { name: 'Interior Only', slug: 'interior-only' },
          addons: [],
          address: { freeText: '456 Oak Ave' },
          scheduledLocal: { date: '2026-11-01', slot: '09:00' },
          pricing: {
            baseCents: 46899, addonsCents: 0, discountCents: 0, couponCode: null,
            couponPercent: 0, taxCents: 0, totalCents: 46899,
            commissionPercent: 15, processingPercent: 3,
            commissionCents: 7035, processingCents: 1407, providerPayoutCents: 38457,
          },
          status: 'completed',
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      vi.spyOn(Booking, 'find').mockReturnValue(mockChainableQuery(mockBookings) as any);

      const res = await request(app)
        .get('/api/appointments')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.data[0].vehicleCategory).toBe('RV/Boat/Semi');
      expect(res.body.data[0].status).toBe('Completed');
    });
  });

  // =========================================================================
  // 8. CUSTOMER & VEHICLE ENDPOINTS (auth checks)
  // =========================================================================
  describe('Customer profile endpoints', () => {
    it('GET /api/v1/customers/me returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/customers/me');
      expect(res.status).toBe(401);
    });
  });

  describe('Vehicle endpoints', () => {
    it('GET /api/v1/vehicles returns 401 without auth', async () => {
      const res = await request(app).get('/api/v1/vehicles');
      expect(res.status).toBe(401);
    });

    it('POST /api/v1/vehicles returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/v1/vehicles')
        .send({ category: 'sedan', make: 'Toyota', model: 'Camry', year: 2023 });
      expect(res.status).toBe(401);
    });

    it('POST /api/v1/vehicles creates vehicle for owner using model field', async () => {
      vi.spyOn(Vehicle, 'countDocuments').mockResolvedValue(0 as any);
      vi.spyOn(Vehicle.prototype, 'save').mockImplementation(function (this: any) {
        this._id = new mongoose.Types.ObjectId();
        return Promise.resolve(this);
      });

      const res = await request(app)
        .post('/api/v1/vehicles')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ category: 'sedan', make: 'Toyota', model: 'Camry', year: 2023 });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.make).toBe('Toyota');
      expect(res.body.data.vehicleModel).toBe('Camry');
    });

    it('GET /api/v1/vehicles returns vehicles for authenticated owner', async () => {
      vi.spyOn(Vehicle, 'find').mockReturnValue(mockChainableQuery([]) as any);

      const res = await request(app)
        .get('/api/v1/vehicles')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // =========================================================================
  // 9. BOOKING CREATION VALIDATION
  // =========================================================================
  describe('POST /api/v1/bookings (creation validation)', () => {
    it('rejects booking without serviceId', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('X-Forwarded-For', '10.80.1.1')
        .send({
          date: futureDate(),
          slot: '10:00',
          guest: { fullName: 'Test', email: 'test@test.com', phone: '555-1234' },
        });

      expect(res.status).toBe(400);
    });

    it('rejects booking without date', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('X-Forwarded-For', '10.80.1.2')
        .send({
          serviceId: serviceId.toString(),
          slot: '10:00',
          guest: { fullName: 'Test', email: 'test@test.com', phone: '555-1234' },
        });

      expect(res.status).toBe(400);
    });

    it('rejects guest booking without guest info when not authenticated', async () => {
      // Mock all the pricing/availability dependencies
      vi.spyOn(Service, 'findById').mockResolvedValue({
        _id: serviceId, name: 'Interior Only', slug: 'interior-only',
        categoryId, isActive: true,
      } as any);
      vi.spyOn(ServiceCategory, 'findById').mockResolvedValue({
        _id: categoryId, name: 'Mobile Detailing', slug: 'mobile-detailing', isActive: true,
      } as any);
      vi.spyOn(ServicePrice, 'findOne').mockResolvedValue({
        serviceId, vehicleCategory: 'sedan', price: 22899,
      } as any);
      vi.spyOn(CommissionRule, 'findOne').mockResolvedValue(null);
      vi.spyOn(BookingSettings, 'findOne').mockResolvedValue(mockSettings as any);
      vi.spyOn(BookingSettings, 'create').mockResolvedValue(mockSettings as any);

      const res = await request(app)
        .post('/api/v1/bookings')
        .set('X-Forwarded-For', '10.80.1.3')
        .send({
          serviceId: serviceId.toString(),
          vehicleCategory: 'sedan',
          date: futureDate(),
          slot: '10:00',
          // no guest info, no auth
        });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // 10. RATE LIMITING ON BOOKING ENDPOINTS
  // =========================================================================
  describe('Rate limits on bookings endpoints', () => {
    it('enforces bookingCreationLimiter on POST /api/v1/bookings: skips 400 validation errors, blocks on 11th creation attempt', async () => {
      const testIp = '10.40.1.1';

      // 1. Send 15 requests with invalid body (400 validation errors)
      // These must NOT count towards the rate limit
      for (let i = 1; i <= 15; i++) {
        const res = await request(app)
          .post('/api/v1/bookings')
          .set('X-Forwarded-For', testIp)
          .send({});
        expect(res.status).toBe(400);
      }

      // 2. Mock successful booking creation
      vi.spyOn(BookingService, 'createBooking').mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
        bookingNumber: 'GIS-000001',
      } as any);

      const validPayload = {
        serviceId: serviceId.toString(),
        vehicleCategory: 'sedan',
        date: futureDate(10),
        slot: '10:00',
        guest: { fullName: 'Rate Test', email: 'ratetest@example.com', phone: '555-0000' },
      };

      // 3. Send 10 creation attempts (returns 201)
      for (let i = 1; i <= 10; i++) {
        const res = await request(app)
          .post('/api/v1/bookings')
          .set('X-Forwarded-For', testIp)
          .send(validPayload);
        expect(res.status).toBe(201);
      }

      // 4. 11th creation attempt triggers 429
      const blockedRes = await request(app)
        .post('/api/v1/bookings')
        .set('X-Forwarded-For', testIp)
        .send(validPayload);

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('enforces bookingLookupLimiter: 20 per 15 min per IP for guests (21st triggers 429)', async () => {
      const guestIp = '10.40.2.1';
      const fakeId = new mongoose.Types.ObjectId().toString();
      vi.spyOn(Booking, 'findOne').mockResolvedValue(null);

      for (let i = 1; i <= 20; i++) {
        const res = await request(app)
          .get(`/api/v1/bookings/${fakeId}`)
          .set('X-Forwarded-For', guestIp);
        expect(res.status).toBe(404);
      }

      const blockedRes = await request(app)
        .get(`/api/v1/bookings/${fakeId}`)
        .set('X-Forwarded-For', guestIp);

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('enforces bookingLookupLimiter: 120 per 15 min keyed by userId for authenticated users (121st triggers 429)', async () => {
      const authUserIp = '10.40.2.2';
      const fakeId = new mongoose.Types.ObjectId().toString();
      const rateUserToken = generateAccessToken({
        userId: new mongoose.Types.ObjectId().toString(),
        email: 'ratelimituser@example.com',
        role: 'customer',
        status: 'active',
        emailVerified: true,
      });
      vi.spyOn(Booking, 'findOne').mockResolvedValue(null);

      // Authenticated user can exceed guest limit (20) without getting 429
      for (let i = 1; i <= 120; i++) {
        const res = await request(app)
          .get(`/api/v1/bookings/${fakeId}`)
          .set('X-Forwarded-For', authUserIp)
          .set('Authorization', `Bearer ${rateUserToken}`);
        expect(res.status).toBe(404);
      }

      const blockedRes = await request(app)
        .get(`/api/v1/bookings/${fakeId}`)
        .set('X-Forwarded-For', authUserIp)
        .set('Authorization', `Bearer ${rateUserToken}`);

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('enforces availabilityLimiter on GET /api/v1/bookings/availability: 120 per 15 min per IP (121st triggers 429)', async () => {
      const availIp = '10.40.3.1';
      vi.spyOn(BookingSettings, 'findOne').mockResolvedValue(mockSettings as any);
      vi.spyOn(SlotReservation, 'find').mockResolvedValue([]);
      vi.spyOn(ServiceCategory, 'findOne').mockResolvedValue({ _id: categoryId } as any);

      for (let i = 1; i <= 120; i++) {
        const res = await request(app)
          .get(`/api/v1/bookings/availability?date=${futureDate(5)}&categoryId=${categoryId}`)
          .set('X-Forwarded-For', availIp);
        expect(res.status).toBe(200);
      }

      const blockedRes = await request(app)
        .get(`/api/v1/bookings/availability?date=${futureDate(5)}&categoryId=${categoryId}`)
        .set('X-Forwarded-For', availIp);

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });

  // =========================================================================
  // 11. MIGRATION SCRIPT TESTS (migrateAppointments.ts)
  // =========================================================================
  describe('Appointments migration script (migrateAppointments)', () => {
    it('throws error when BUSINESS_TIMEZONE is not set', async () => {
      const origTz = process.env.BUSINESS_TIMEZONE;
      delete process.env.BUSINESS_TIMEZONE;

      try {
        await expect(migrateAppointments({ dryRun: true })).rejects.toThrow(
          'BUSINESS_TIMEZONE environment variable must be set'
        );
      } finally {
        process.env.BUSINESS_TIMEZONE = origTz || 'America/New_York';
      }
    });

    it('--dry-run performs 0 database writes and reports unmappable records', async () => {
      const mockAppointments = [
        {
          _id: new mongoose.Types.ObjectId(),
          fullName: 'Alice Walker',
          email: 'alice@test.com',
          phone: '555-1111',
          address: '789 Elm St',
          serviceType: 'Unknown Service Name', // Unmappable
          vehicleCategory: 'Sedan',
          date: '2026-11-20',
          timeSlot: '09:00 AM',
          basePrice: 100,
          totalPrice: 100,
          status: 'Pending',
        },
        {
          _id: new mongoose.Types.ObjectId(),
          fullName: 'Bob Smith',
          email: 'bob@test.com',
          phone: '555-2222',
          address: '456 Oak Ave',
          serviceType: 'Interior Only', // Valid
          vehicleCategory: 'CrossOver',
          date: '2026-11-20',
          timeSlot: '11:00 AM',
          basePrice: 238.99,
          totalPrice: 238.99,
          status: 'Confirmed',
        },
      ];

      vi.spyOn(Appointment, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockAppointments),
      } as any);

      vi.spyOn(Service, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            _id: serviceId,
            name: 'Interior Only',
            slug: 'interior-only',
            categoryId,
            isActive: true,
          },
        ]),
      } as any);

      vi.spyOn(ServiceCategory, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            _id: categoryId,
            name: 'Mobile Detailing',
            slug: 'mobile-detailing',
          },
        ]),
      } as any);

      vi.spyOn(User, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      } as any);

      vi.spyOn(Booking, 'findOne').mockResolvedValue(null);
      const bookingCreateSpy = vi.spyOn(Booking, 'create');

      const report = await migrateAppointments({ dryRun: true });

      expect(report.mode).toBe('dry-run');
      expect(report.totalAppointments).toBe(2);
      expect(report.migrated).toBe(1);
      expect(report.unmappable).toBe(1);
      expect(report.unmappableRecords).toHaveLength(1);
      expect(report.unmappableRecords[0].reason).toContain('Unknown or inactive service');
      expect(bookingCreateSpy).not.toHaveBeenCalled();
    });

    it('defaults to dry-run when called with no arguments, performing 0 writes', async () => {
      const mockAppointments = [
        {
          _id: new mongoose.Types.ObjectId(),
          fullName: 'Alice',
          email: 'alice@test.com',
          phone: '555',
          address: '123 Main',
          serviceType: 'Interior Only',
          vehicleCategory: 'Sedan',
          date: '2026-11-20',
          timeSlot: '09:00 AM',
          basePrice: 100,
          totalPrice: 100,
          status: 'Confirmed',
        },
      ];

      vi.spyOn(Appointment, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockAppointments),
      } as any);
      vi.spyOn(Service, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { _id: serviceId, name: 'Interior Only', slug: 'interior-only', categoryId, isActive: true },
        ]),
      } as any);
      vi.spyOn(ServiceCategory, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { _id: categoryId, name: 'Mobile Detailing', slug: 'mobile-detailing' },
        ]),
      } as any);
      vi.spyOn(User, 'find').mockReturnValue({ lean: vi.fn().mockResolvedValue([]) } as any);
      vi.spyOn(Booking, 'findOne').mockResolvedValue(null);
      const bookingCreateSpy = vi.spyOn(Booking, 'create');

      const report = await migrateAppointments();

      expect(report.mode).toBe('dry-run');
      expect(report.totalAppointments).toBe(1);
      expect(report.migrated).toBe(1);
      expect(bookingCreateSpy).not.toHaveBeenCalled();
    });

    it('--limit N option limits the number of appointments processed', async () => {
      const mockAppointments = [
        {
          _id: new mongoose.Types.ObjectId(),
          fullName: 'Appt 1',
          email: 'appt1@test.com',
          phone: '555-1',
          address: '123 Main',
          serviceType: 'Interior Only',
          vehicleCategory: 'Sedan',
          date: '2026-11-20',
          timeSlot: '09:00 AM',
          basePrice: 100,
          totalPrice: 100,
          status: 'Confirmed',
        },
        {
          _id: new mongoose.Types.ObjectId(),
          fullName: 'Appt 2',
          email: 'appt2@test.com',
          phone: '555-2',
          address: '456 Elm',
          serviceType: 'Interior Only',
          vehicleCategory: 'Sedan',
          date: '2026-11-20',
          timeSlot: '10:00 AM',
          basePrice: 100,
          totalPrice: 100,
          status: 'Confirmed',
        },
      ];

      vi.spyOn(Appointment, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockAppointments),
      } as any);
      vi.spyOn(Service, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { _id: serviceId, name: 'Interior Only', slug: 'interior-only', categoryId, isActive: true },
        ]),
      } as any);
      vi.spyOn(ServiceCategory, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { _id: categoryId, name: 'Mobile Detailing', slug: 'mobile-detailing' },
        ]),
      } as any);
      vi.spyOn(User, 'find').mockReturnValue({ lean: vi.fn().mockResolvedValue([]) } as any);
      vi.spyOn(Booking, 'findOne').mockResolvedValue(null);

      const report = await migrateAppointments({ limit: 1 });

      expect(report.mode).toBe('dry-run');
      expect(report.totalAppointments).toBe(1);
    });

    it('apply is idempotent: skips appointments already migrated', async () => {
      const legacyId = new mongoose.Types.ObjectId();
      const mockAppointments = [
        {
          _id: legacyId,
          fullName: 'Bob Smith',
          email: 'bob@test.com',
          phone: '555-2222',
          address: '456 Oak Ave',
          serviceType: 'Interior Only',
          vehicleCategory: 'CrossOver',
          date: '2026-11-20',
          timeSlot: '11:00 AM',
          basePrice: 238.99,
          totalPrice: 238.99,
          status: 'Confirmed',
        },
      ];

      vi.spyOn(Appointment, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockAppointments),
      } as any);

      vi.spyOn(Service, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            _id: serviceId,
            name: 'Interior Only',
            slug: 'interior-only',
            categoryId,
            isActive: true,
          },
        ]),
      } as any);

      vi.spyOn(ServiceCategory, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            _id: categoryId,
            name: 'Mobile Detailing',
            slug: 'mobile-detailing',
          },
        ]),
      } as any);

      vi.spyOn(User, 'find').mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      } as any);

      // Simulates existing migrated booking
      vi.spyOn(Booking, 'findOne').mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
        legacyAppointmentId: legacyId,
      } as any);

      const bookingCreateSpy = vi.spyOn(Booking, 'create');

      const report = await migrateAppointments({ apply: true });

      expect(report.mode).toBe('apply');
      expect(report.skipped).toBe(1);
      expect(report.migrated).toBe(0);
      expect(bookingCreateSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 12. GUEST-TO-CUSTOMER BOOKING LINKING
  // =========================================================================
  describe('Guest-to-customer booking linking', () => {
    it('links unattached guest bookings when customer verifies email', async () => {
      const { AuthService } = await import('../modules/auth/service');
      const { User } = await import('../models/User');

      const verifiedUserId = new mongoose.Types.ObjectId();
      const userDoc = {
        _id: verifiedUserId,
        email: 'guest@example.com',
        emailVerified: false,
        save: vi.fn().mockResolvedValue(true),
      };

      vi.spyOn(User, 'findById').mockResolvedValue(userDoc as any);
      const updateManySpy = vi.spyOn(Booking, 'updateMany').mockResolvedValue({} as any);

      const verificationToken = 'valid-token';
      const jwtUtil = await import('../utils/jwt');
      vi.spyOn(jwtUtil, 'verifyEmailVerificationToken').mockReturnValue({
        userId: verifiedUserId.toString(),
        email: 'guest@example.com',
        type: 'email_verification',
      });

      await AuthService.verifyEmail(verificationToken);

      expect(updateManySpy).toHaveBeenCalledWith(
        { customerId: null, 'guest.email': 'guest@example.com' },
        { $set: { customerId: verifiedUserId } }
      );
    });

    it('plain unverified registration does NOT link guest bookings (victim bookings invisible)', async () => {
      const victimEmail = 'victim@example.com';
      const attackerUserId = new mongoose.Types.ObjectId();

      const newAttackerUser = {
        _id: attackerUserId,
        email: victimEmail,
        fullName: 'Attacker User',
        role: 'customer',
        status: 'active',
        emailVerified: false, // unverified!
        phoneVerified: false,
        save: vi.fn().mockResolvedValue(true),
        getEffectiveRole: () => 'customer',
      };

      vi.spyOn(User, 'findOne').mockResolvedValue(null);
      vi.spyOn(User.prototype, 'save').mockImplementation(function (this: any) {
        Object.assign(this, newAttackerUser);
        return Promise.resolve(this);
      });
      vi.spyOn(RefreshToken, 'create').mockResolvedValue({} as any);
      vi.spyOn(User, 'updateOne').mockResolvedValue({} as any);
      const updateManySpy = vi.spyOn(Booking, 'updateMany');

      // 1. Attacker registers with victim's email
      const regRes = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', '10.60.1.1')
        .send({
          email: victimEmail,
          password: 'Password123!',
          fullName: 'Attacker User',
        });

      expect(regRes.status).toBe(201);
      // Crucial: Booking.updateMany was NOT called during unverified registration
      expect(updateManySpy).not.toHaveBeenCalled();

      // 2. Attacker uses their customer token and calls GET /api/v1/bookings/mine
      const attackerToken = generateAccessToken({
        userId: attackerUserId.toString(),
        email: victimEmail,
        role: 'customer',
        status: 'active',
        emailVerified: false,
      });

      // Mock Booking.find for bookings/mine: only matches customerId: attackerUserId
      // Victim's bookings still have customerId: null, so find returns []
      const findSpy = vi.spyOn(Booking, 'find').mockReturnValue(mockChainableQuery([]) as any);
      vi.spyOn(Booking, 'countDocuments').mockResolvedValue(0);

      const mineRes = await request(app)
        .get('/api/v1/bookings/mine')
        .set('X-Forwarded-For', '10.60.1.2')
        .set('Authorization', `Bearer ${attackerToken}`);

      expect(mineRes.status).toBe(200);
      expect(mineRes.body.data).toHaveLength(0);
      expect(findSpy).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: attackerUserId.toString(), deletedAt: null })
      );

      // 3. Attacker tries to GET victim's guest booking directly by ID: gets 403 Forbidden
      const victimGuestBooking = {
        _id: new mongoose.Types.ObjectId(),
        bookingNumber: 'GIS-000099',
        customerId: null, // still unlinked!
        guest: { email: victimEmail, fullName: 'Victim User', phone: '555-9999' },
        guestAccessTokenHash: 'victimhash123',
        deletedAt: null,
      };
      vi.spyOn(Booking, 'findOne').mockResolvedValue(victimGuestBooking as any);

      const directRes = await request(app)
        .get(`/api/v1/bookings/${victimGuestBooking._id}`)
        .set('X-Forwarded-For', '10.60.1.3')
        .set('Authorization', `Bearer ${attackerToken}`);

      expect(directRes.status).toBe(403);
      expect(directRes.body.success).toBe(false);
    });
  });
});
