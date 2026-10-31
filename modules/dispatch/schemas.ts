import { z } from 'zod';

export const assignBookingSchema = z.object({
  technicianUserId: z.string().min(1, 'technicianUserId is required'),
  force: z.boolean().optional(),
});

export const declineOfferSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const updateDispatchSettingsSchema = z.object({
  autoDispatch: z.boolean().optional(),
  offerTimeoutSecondsAsap: z.number().int().min(10).max(3600).optional(),
  offerTimeoutMinutesScheduled: z.number().int().min(1).max(1440).optional(),
  batchSize: z.number().int().min(1).max(50).optional(),
  batchSizeScheduled: z.number().int().min(1).max(50).optional(),
  maxOffersPerBooking: z.number().int().min(1).max(100).optional(),
  maxDistanceKm: z.number().min(1).max(500).optional(),
  escalateToAdminOnExhaust: z.boolean().optional(),
  locationMinIntervalSeconds: z.number().int().min(1).max(60).optional(),
  onlineRequiredWithinHours: z.number().min(0).max(168).optional(),
  scheduleBufferMinutes: z.number().int().min(0).max(240).optional(),
  allowTrackingStatuses: z.array(z.string()).min(1).optional(),
});
