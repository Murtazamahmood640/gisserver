import { z } from 'zod';
import { vehicleCategoryEnum } from '../vehicles/schema';

export const bookingStatusEnum = z.enum([
  'pending',
  'confirmed',
  'assigned',
  'technician_en_route',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'refunded',
]);

export const bookingSourceEnum = z.enum([
  'web',
  'ios',
  'android',
  'admin',
  'legacy-migration',
]);

export const addressSnapshotSchema = z.object({
  line1: z.string().optional().default(''),
  line2: z.string().optional().default(''),
  city: z.string().optional().default(''),
  state: z.string().optional().default(''),
  zip: z.string().optional().default(''),
  country: z.string().optional().default('USA'),
  freeText: z.string().optional().default(''),
});

export const guestInfoSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  email: z.string().email('Valid email is required'),
  phone: z.string().min(5, 'Phone number is required'),
});

export const createBookingSchema = z.object({
  serviceId: z.string().min(1, 'Service ID or slug is required'),
  vehicleCategory: vehicleCategoryEnum.optional(),
  vehicleMake: z.string().optional().default(''),
  vehicleModel: z.string().optional().default(''),
  vehicleYear: z.coerce.number().optional().default(new Date().getFullYear()),
  vehicleId: z.string().optional(),
  addonIds: z.array(z.string()).optional().default([]),
  couponCode: z.string().optional().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD'),
  slot: z.string().min(1, 'Time slot is required'),
  address: addressSnapshotSchema.optional(),
  addressId: z.string().optional(),
  guest: guestInfoSchema.optional(),
  notes: z.string().optional().default(''),
  source: bookingSourceEnum.optional().default('web'),
});

export const cancelBookingSchema = z.object({
  reason: z.string().optional().default(''),
});

export const rescheduleBookingSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD'),
  slot: z.string().min(1, 'Time slot is required'),
  reason: z.string().optional().default(''),
  unassignTechnician: z.boolean().optional(),
});

export const updateBookingStatusSchema = z.object({
  status: bookingStatusEnum,
  note: z.string().optional().default(''),
});

export const adminUpdateBookingSchema = z.object({
  notes: z.string().optional(),
  address: addressSnapshotSchema.optional(),
  technicianId: z.string().nullable().optional(),
});

export const updateBookingSettingsSchema = z.object({
  businessTimezone: z.string().optional(),
  slots: z.array(z.string()).optional(),
  slotCapacity: z.number().int().min(1).optional(),
  minLeadHours: z.number().min(0).optional(),
  maxAdvanceDays: z.number().int().min(1).optional(),
  cancellation: z
    .object({
      freeCancelHours: z.number().min(0).optional(),
      lateFeePercent: z.number().min(0).max(100).optional(),
    })
    .optional(),
  closedDates: z.array(z.string()).optional(),
});

export const quoteBookingSchema = z.object({
  serviceId: z.string().min(1, 'Service ID or slug is required'),
  vehicleCategory: vehicleCategoryEnum,
  addonIds: z.array(z.string()).optional().default([]),
  couponCode: z.string().trim().optional().nullable(),
});

