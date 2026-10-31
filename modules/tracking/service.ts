import mongoose from 'mongoose';
import crypto from 'crypto';
import { TechnicianLocation, ITechnicianLocation } from '../../models/TechnicianLocation';
import { LocationPing } from '../../models/LocationPing';
import { Booking } from '../../models/Booking';
import { DispatchSettings } from '../../models/DispatchSettings';
import { EtaService, EtaResult } from './etaService';
import { realtimeEmitter } from '../../realtime/emitter';
import logger from '../../config/logger';
import { createHttpError } from '../../utils/httpErrors';

const lastUpdateMap = new Map<string, number>();

export class TrackingService {
  /**
   * Updates technician's current location with rate limiting and active job recording.
   * NEVER logs coordinates.
   */
  static async updateLocation(
    technicianUserId: string,
    data: {
      lat: number;
      lng: number;
      heading?: number;
      speed?: number;
      accuracy?: number;
    }
  ): Promise<{ success: boolean; activeBookingId?: string }> {
    const settings = await DispatchSettings.getSettings();
    const minIntervalMs = settings.locationMinIntervalSeconds * 1000;
    const now = Date.now();
    const last = lastUpdateMap.get(technicianUserId) || 0;

    if (now - last < minIntervalMs) {
      const retryAfter = Math.max(1, Math.ceil((minIntervalMs - (now - last)) / 1000));
      throw createHttpError(`Location updates throttled. Retry after ${retryAfter} seconds`, 429, 'RATE_LIMIT_EXCEEDED', retryAfter);
    }

    lastUpdateMap.set(technicianUserId, now);

    const techObjId = new mongoose.Types.ObjectId(technicianUserId);
    const locationPoint = {
      type: 'Point' as const,
      coordinates: [data.lng, data.lat] as [number, number],
    };

    // Check if technician currently has an active job
    const activeBooking = await Booking.findOne({
      $or: [
        { 'assignment.technicianUserId': techObjId },
        { technicianId: techObjId },
      ],
      status: { $in: settings.allowTrackingStatuses },
      deletedAt: null,
    }).lean();

    const activeBookingId = activeBooking?._id || null;

    // Upsert current location
    await TechnicianLocation.findOneAndUpdate(
      { technicianUserId: techObjId },
      {
        $set: {
          location: locationPoint,
          heading: data.heading,
          speed: data.speed,
          accuracy: data.accuracy,
          bookingId: activeBookingId,
          updatedAt: new Date(now),
        },
      },
      { upsert: true, new: true }
    );

    // If an active job is in progress, record location ping and emit realtime events
    if (activeBooking) {
      await LocationPing.create({
        bookingId: activeBooking._id,
        technicianUserId: techObjId,
        location: locationPoint,
        at: new Date(now),
      });

      realtimeEmitter.emitTechnicianLocation(activeBooking._id.toString(), {
        bookingId: activeBooking._id.toString(),
        technicianUserId,
        location: { lat: data.lat, lng: data.lng },
        heading: data.heading,
        speed: data.speed,
        accuracy: data.accuracy,
        updatedAt: new Date(now).toISOString(),
      });

      // Calculate ETA if booking has destination coordinates
      if (activeBooking.location?.coordinates) {
        EtaService.calculateEta(
          locationPoint.coordinates,
          activeBooking.location.coordinates
        ).then((eta) => {
          realtimeEmitter.emitTrackingEta(activeBooking._id.toString(), {
            bookingId: activeBooking._id.toString(),
            etaMinutes: eta.etaMinutes,
            distanceKm: eta.distanceKm,
            etaSource: eta.etaSource,
            updatedAt: new Date(now).toISOString(),
          });
        }).catch(() => {});
      }
    }

    logger.debug({ technicianUserId, hasActiveBooking: Boolean(activeBooking) }, '[Tracking] Location updated');
    return { success: true, activeBookingId: activeBookingId?.toString() };
  }

  /**
   * Retrieves tracking details and live ETA for an authorized client.
   */
  static async getBookingTracking(
    bookingId: string,
    authUser?: { userId: string; role: string; email: string },
    guestToken?: string
  ): Promise<{
    location: { lat: number; lng: number } | null;
    heading?: number;
    speed?: number;
    accuracy?: number;
    updatedAt?: Date;
    etaMinutes: number | null;
    distanceKm: number | null;
    etaSource: 'google' | 'estimate' | null;
  }> {
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null }).lean();
    if (!booking) {
      throw createHttpError('Booking not found', 404, 'NOT_FOUND');
    }

    const settings = await DispatchSettings.getSettings();

    // Verify client authorization
    const isPrivileged = authUser && (authUser.role === 'admin' || authUser.role === 'dispatcher');
    const isOwner = Boolean(
      authUser && booking.customerId && booking.customerId.toString() === authUser.userId
    );
    const isAssignedTech = Boolean(
      authUser &&
        authUser.role === 'technician' &&
        (booking.assignment?.technicianUserId?.toString() === authUser.userId ||
          booking.technicianId?.toString() === authUser.userId)
    );

    let isGuestValid = false;
    if (guestToken && booking.guestAccessTokenHash) {
      const hashed = crypto.createHash('sha256').update(guestToken.trim()).digest('hex');
      isGuestValid = hashed === booking.guestAccessTokenHash;
    }

    if (!isPrivileged && !isOwner && !isAssignedTech && !isGuestValid) {
      throw createHttpError('Forbidden: You do not have permission to view tracking for this booking', 403, 'FORBIDDEN');
    }

    // Tracking is strictly available ONLY while booking status is in allowTrackingStatuses
    if (!settings.allowTrackingStatuses.includes(booking.status)) {
      throw createHttpError(
        `Tracking is not available while booking is in '${booking.status}' status`,
        403,
        'TRACKING_NOT_AVAILABLE'
      );
    }

    const assignedTechUserId =
      booking.assignment?.technicianUserId || booking.technicianId;

    if (!assignedTechUserId) {
      return {
        location: null,
        etaMinutes: null,
        distanceKm: null,
        etaSource: null,
      };
    }

    const techLoc = await TechnicianLocation.findOne({
      technicianUserId: assignedTechUserId,
    }).lean();

    if (!techLoc || !techLoc.location?.coordinates) {
      return {
        location: null,
        etaMinutes: null,
        distanceKm: null,
        etaSource: null,
      };
    }

    const [techLng, techLat] = techLoc.location.coordinates;
    let eta: EtaResult | null = null;

    if (booking.location?.coordinates) {
      eta = await EtaService.calculateEta(
        techLoc.location.coordinates,
        booking.location.coordinates
      );
    }

    return {
      location: { lat: techLat, lng: techLng },
      heading: techLoc.heading,
      speed: techLoc.speed,
      accuracy: techLoc.accuracy,
      updatedAt: techLoc.updatedAt,
      etaMinutes: eta?.etaMinutes ?? null,
      distanceKm: eta?.distanceKm ?? null,
      etaSource: eta?.etaSource ?? null,
    };
  }

  /**
   * Periodic or cron cleanup task:
   * Deletes location pings and clears technicianLocations.bookingId
   * 24 hours after job completion or cancellation.
   */
  static async runTrackingCleanup(): Promise<{ deletedPingsCount: number; clearedLocationsCount: number }> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find bookings completed or cancelled older than 24 hours
    const finishedBookings = await Booking.find({
      status: { $in: ['completed', 'cancelled'] },
      $or: [
        { completedAt: { $lt: cutoff } },
        { updatedAt: { $lt: cutoff } },
      ],
    }).select('_id').lean();

    const finishedBookingIds = finishedBookings.map((b) => b._id);
    if (finishedBookingIds.length === 0) {
      return { deletedPingsCount: 0, clearedLocationsCount: 0 };
    }

    // Delete audit pings older than 24 hours for completed/cancelled jobs
    const pingRes = await LocationPing.deleteMany({
      bookingId: { $in: finishedBookingIds },
    });

    // Clear bookingId on active technician location documents
    const locRes = await TechnicianLocation.updateMany(
      { bookingId: { $in: finishedBookingIds } },
      { $set: { bookingId: null } }
    );

    logger.info(
      { deletedPings: pingRes.deletedCount, clearedLocations: locRes.modifiedCount },
      '[Tracking] Cleanup task completed'
    );

    return {
      deletedPingsCount: pingRes.deletedCount || 0,
      clearedLocationsCount: locRes.modifiedCount || 0,
    };
  }
}
