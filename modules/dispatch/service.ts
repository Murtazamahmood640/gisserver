import mongoose from 'mongoose';
import { Booking, IBooking } from '../../models/Booking';
import { DispatchOffer, IDispatchOffer } from '../../models/DispatchOffer';
import { DispatchSettings } from '../../models/DispatchSettings';
import { TechnicianProfile } from '../../models/TechnicianProfile';
import { TechnicianLocation } from '../../models/TechnicianLocation';
import { LocationPing } from '../../models/LocationPing';
import { User } from '../../models/User';
import { Service } from '../../models/Service';
import { eligibleTechnicians, CandidateEvaluation } from './matching';
import { realtimeEmitter } from '../../realtime/emitter';
import { pushService } from '../../services/pushService';
import {
  sendEmail,
  getTechnicianNewOfferEmail,
  getCustomerTechnicianAssignedEmail,
  getAdminDispatchExhaustedEmail,
} from '../../services/emailService';
import logger from '../../config/logger';
import { createHttpError } from '../../utils/httpErrors';
import { localToUtc, utcToLocal } from '../bookings/availability';

function getBaseFrontendUrl(): string {
  const raw = process.env.FRONTEND_URL;
  if (raw && raw.trim()) {
    return raw.split(',')[0].trim().replace(/\/$/, '');
  }
  return 'https://globalintegratedsupport.com';
}

export class DispatchService {
  /**
   * Starts or advances the automated dispatch flow for a confirmed booking.
   */
  static async startDispatch(
    bookingId: string | mongoose.Types.ObjectId,
    actor: string = 'system'
  ): Promise<{ status: string; offersCreated?: number }> {
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.deletedAt) {
      return { status: 'not_found' };
    }

    // Only dispatch bookings that are confirmed/pending and unassigned
    if (booking.assignment?.technicianUserId || booking.status === 'assigned' || booking.status === 'completed' || booking.status === 'cancelled') {
      return { status: 'already_assigned_or_terminal' };
    }

    const settings = await DispatchSettings.getSettings();

    // Set status searching
    booking.dispatch = booking.dispatch || { status: 'none', attempts: 0 };
    booking.dispatch.status = 'searching';
    await booking.save();

    // Find candidates
    const candidates = await eligibleTechnicians(booking);

    if (candidates.length === 0 || booking.dispatch.attempts >= settings.maxOffersPerBooking) {
      booking.dispatch.status = 'exhausted';
      booking.dispatch.exhaustedAt = new Date();
      booking.statusHistory.push({
        status: booking.status,
        by: actor,
        at: new Date(),
        note: `Dispatch exhausted after ${booking.dispatch.attempts} attempts (${candidates.length} eligible candidates remaining)`,
      });
      await booking.save();

      // Escalate to admin if enabled
      if (settings.escalateToAdminOnExhaust) {
        const adminEmail = process.env.ADMIN_EMAIL || process.env.STACKMAIL_USER;
        if (adminEmail) {
          sendEmail({
            to: adminEmail,
            subject: `[Dispatch Alert] Offers Exhausted for Booking #${booking.bookingNumber}`,
            html: getAdminDispatchExhaustedEmail({
              bookingNumber: booking.bookingNumber,
              bookingId: booking._id.toString(),
              attempts: booking.dispatch.attempts,
              adminBoardUrl: `${getBaseFrontendUrl()}/admin/dispatch`,
            }),
          }).catch((err) => logger.error({ err }, 'Failed to send admin dispatch exhausted email'));
        }
      }

      realtimeEmitter.emitDispatchBoardUpdate({
        type: 'exhausted',
        bookingId: booking._id.toString(),
        bookingNumber: booking.bookingNumber,
        timestamp: new Date().toISOString(),
      });

      return { status: 'exhausted', offersCreated: 0 };
    }

    // Select candidates for next batch (batchSize for ASAP, batchSizeScheduled for scheduled)
    const batchLimit = booking.isAsap
      ? settings.batchSize
      : (settings.batchSizeScheduled || 3);
    const batch = candidates.slice(0, batchLimit);
    const now = new Date();
    const timeoutSeconds = booking.isAsap
      ? settings.offerTimeoutSecondsAsap
      : settings.offerTimeoutMinutesScheduled * 60;
    const expiresAt = new Date(now.getTime() + timeoutSeconds * 1000);

    const createdOffers: IDispatchOffer[] = [];

    for (const c of batch) {
      try {
        const offer = await DispatchOffer.create({
          bookingId: booking._id,
          technicianUserId: new mongoose.Types.ObjectId(c.technicianUserId),
          rank: c.rank || 1,
          distanceKm: c.distanceKm,
          status: 'sent',
          sentAt: now,
          expiresAt,
          source: 'auto',
        });
        createdOffers.push(offer);

        // Notify technician via Realtime, Push, Email
        realtimeEmitter.emitOfferNew(c.technicianUserId, {
          offerId: offer._id.toString(),
          bookingId: booking._id.toString(),
          bookingNumber: booking.bookingNumber,
          serviceName: booking.serviceSnapshot?.name || 'Car Detailing Service',
          scheduledTime: `${booking.scheduledLocal?.date} ${booking.scheduledLocal?.slot}`,
          expiresAt: expiresAt.toISOString(),
          rank: offer.rank,
        });

        pushService.sendToUser(c.technicianUserId, {
          title: 'New Service Job Offer',
          body: `Job #${booking.bookingNumber} in ${booking.address?.city || 'your area'} is available. Tap to accept!`,
          data: { offerId: offer._id.toString(), bookingId: booking._id.toString() },
        }).catch(() => {});

        const techUser = await User.findById(c.technicianUserId).lean();
        if (techUser && techUser.email) {
          sendEmail({
            to: techUser.email,
            subject: `New Job Offer: #${booking.bookingNumber} (${booking.serviceSnapshot?.name})`,
            html: getTechnicianNewOfferEmail({
              fullName: c.displayName,
              bookingNumber: booking.bookingNumber,
              serviceName: booking.serviceSnapshot?.name || 'Detailing Service',
              scheduledTime: `${booking.scheduledLocal?.date} ${booking.scheduledLocal?.slot}`,
              portalUrl: `${getBaseFrontendUrl()}/tech/dashboard`,
            }),
          }).catch((err) => logger.error({ err }, 'Failed to send technician offer email'));
        }
      } catch (err: unknown) {
        // Ignore duplicate key if already created
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, techUserId: c.technicianUserId }, 'DispatchOffer creation conflict/error');
      }
    }

    booking.dispatch.status = 'offered';
    booking.dispatch.attempts += 1;
    booking.dispatch.lastOfferAt = now;
    await booking.save();

    realtimeEmitter.emitDispatchBoardUpdate({
      type: 'offered',
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      timestamp: now.toISOString(),
    });

    return { status: 'offered', offersCreated: createdOffers.length };
  }

  /**
   * ATOMIC OFFER ACCEPTANCE.
   * Conditional update guarantees exactly one technician wins when two accept concurrently.
   */
  static async acceptOffer(
    offerId: string,
    technicianUserId: string
  ): Promise<{ success: boolean; booking: IBooking }> {
    const offer = await DispatchOffer.findById(offerId);
    if (!offer) {
      throw createHttpError('Offer not found', 404, 'NOT_FOUND');
    }

    if (offer.technicianUserId.toString() !== technicianUserId) {
      throw createHttpError('Forbidden: You can only respond to your own offers', 403, 'FORBIDDEN');
    }

    if (offer.status !== 'sent') {
      throw createHttpError(`Offer is already ${offer.status}`, 409, 'OFFER_NO_LONGER_AVAILABLE');
    }

    const now = new Date();
    if (offer.expiresAt.getTime() <= now.getTime()) {
      offer.status = 'expired';
      offer.respondedAt = now;
      await offer.save();
      throw createHttpError('Offer has expired', 409, 'OFFER_EXPIRED');
    }

    // Technician account and profile verification checks
    const techUserObjId = new mongoose.Types.ObjectId(technicianUserId);
    const techUser = await User.findById(techUserObjId);
    if (!techUser || techUser.status !== 'active' || (techUser as { isActive?: boolean }).isActive === false) {
      throw createHttpError('Technician account is not active or suspended', 403, 'ACCOUNT_SUSPENDED');
    }

    const techProfile = await TechnicianProfile.findOne({ userId: techUserObjId });
    if (!techProfile || techProfile.verificationStatus !== 'approved') {
      throw createHttpError('Technician profile is not approved', 403, 'TECHNICIAN_NOT_APPROVED');
    }

    // Inspect booking status: strictly confirmed (never pending or other states)
    const targetBooking = await Booking.findOne({ _id: offer.bookingId, deletedAt: null });
    if (!targetBooking) {
      throw createHttpError('Booking not found', 404, 'NOT_FOUND');
    }

    if (targetBooking.status === 'pending') {
      throw createHttpError('Booking is pending confirmation and cannot be claimed', 409, 'BOOKING_NOT_CONFIRMED');
    }

    if (targetBooking.status !== 'confirmed' || targetBooking.assignment?.technicianUserId) {
      throw createHttpError('This booking is no longer available', 409, 'OFFER_NO_LONGER_AVAILABLE');
    }

    // Calculate booking time window
    let serviceDurationMinutes = 60;
    if (targetBooking.serviceId) {
      const serviceDoc = (await Service.findById(targetBooking.serviceId).lean()) as { durationMinutes?: number } | null;
      if (serviceDoc && serviceDoc.durationMinutes) {
        serviceDurationMinutes = serviceDoc.durationMinutes;
      }
    }
    const settings = await DispatchSettings.getSettings();
    const bufferMinutes = settings.scheduleBufferMinutes ?? 30;
    const bookingStart = new Date(targetBooking.scheduledAt);
    const bookingEnd = new Date(bookingStart.getTime() + (serviceDurationMinutes + bufferMinutes) * 60 * 1000);

    // Overlapping assigned bookings check
    const overlappingAssigned = await Booking.findOne({
      _id: { $ne: targetBooking._id },
      $or: [
        { 'assignment.technicianUserId': techUserObjId },
        { technicianId: techUserObjId },
      ],
      status: { $in: ['assigned', 'technician_en_route', 'arrived', 'in_progress'] },
      scheduledAt: {
        $lt: bookingEnd,
        $gt: new Date(bookingStart.getTime() - (serviceDurationMinutes + bufferMinutes) * 60 * 1000),
      },
      deletedAt: null,
    }).lean();

    if (overlappingAssigned) {
      // Conflict: return booking to dispatch
      await DispatchService.startDispatch(offer.bookingId, 'schedule_conflict');
      throw createHttpError('Technician has an overlapping assigned booking', 409, 'SCHEDULE_CONFLICT');
    }

    // Atomic compare-and-set claim on TechnicianProfile.activeSchedule
    const slotClaim = await TechnicianProfile.findOneAndUpdate(
      {
        userId: techUserObjId,
        verificationStatus: 'approved',
        activeSchedule: {
          $not: {
            $elemMatch: {
              start: { $lt: bookingEnd },
              end: { $gt: bookingStart },
            },
          },
        },
      },
      {
        $push: {
          activeSchedule: {
            bookingId: targetBooking._id,
            start: bookingStart,
            end: bookingEnd,
            createdAt: now,
          },
        },
      },
      { new: true }
    );

    if (!slotClaim) {
      // Schedule conflict on profile slots
      await DispatchService.startDispatch(offer.bookingId, 'schedule_conflict');
      throw createHttpError('Technician has an overlapping booking schedule conflict', 409, 'SCHEDULE_CONFLICT');
    }

    // ATOMIC conditional update on Booking:
    // Requires booking to be in unassigned confirmed state
    const updatedBooking = await Booking.findOneAndUpdate(
      {
        _id: offer.bookingId,
        status: 'confirmed',
        $or: [
          { 'assignment.technicianUserId': { $exists: false } },
          { 'assignment.technicianUserId': null },
        ],
        deletedAt: null,
      },
      {
        $set: {
          status: 'assigned',
          technicianId: techUserObjId, // keep existing technicianId strictly in sync
          'assignment.technicianUserId': techUserObjId,
          'assignment.assignedAt': now,
          'assignment.assignedBy': 'technician',
          'assignment.acceptedAt': now,
          'dispatch.status': 'assigned',
        },
        $push: {
          statusHistory: {
            status: 'assigned',
            by: `technician:${technicianUserId}`,
            at: now,
            note: 'Offer accepted by technician',
          },
        },
      },
      { new: true }
    );

    if (!updatedBooking) {
      // Race lost: booking was claimed by another technician or state changed.
      // Rollback technician schedule slot
      await TechnicianProfile.updateOne(
        { userId: techUserObjId },
        { $pull: { activeSchedule: { bookingId: targetBooking._id } } }
      );

      offer.status = 'cancelled';
      offer.respondedAt = now;
      await offer.save();

      throw createHttpError('This booking is no longer available', 409, 'OFFER_NO_LONGER_AVAILABLE');
    }

    // Mark winning offer as accepted
    offer.status = 'accepted';
    offer.respondedAt = now;
    await offer.save();

    // Cancel all other open offers for this booking
    await DispatchOffer.updateMany(
      {
        bookingId: offer.bookingId,
        _id: { $ne: offer._id },
        status: 'sent',
      },
      {
        $set: {
          status: 'cancelled',
          respondedAt: now,
        },
      }
    );

    // Update technician profile acceptance stats
    await TechnicianProfile.updateOne(
      { userId: techUserObjId },
      {
        $inc: { 'stats.jobsCompleted': 0 }, // preserves field
      }
    );

    // Send customer assignment confirmation email
    const customerEmail = updatedBooking.guest?.email;
    const customerName = updatedBooking.guest?.fullName || 'Valued Customer';

    if (customerEmail) {
      sendEmail({
        to: customerEmail,
        subject: `Technician Assigned: Booking #${updatedBooking.bookingNumber}`,
        html: getCustomerTechnicianAssignedEmail({
          fullName: customerName,
          bookingNumber: updatedBooking.bookingNumber,
          serviceName: updatedBooking.serviceSnapshot?.name || 'Detailing Service',
          technicianName: techProfile?.displayName || 'Certified Technician',
          scheduledTime: `${updatedBooking.scheduledLocal?.date} ${updatedBooking.scheduledLocal?.slot}`,
        }),
      }).catch((err) => logger.error({ err }, 'Failed to send customer assignment email'));
    }

    // Emit Realtime events
    realtimeEmitter.emitBookingAssigned(updatedBooking._id.toString(), {
      bookingId: updatedBooking._id.toString(),
      bookingNumber: updatedBooking.bookingNumber,
      technician: {
        displayName: techProfile?.displayName || 'Technician',
        photoUrl: techProfile?.photoUrl,
        rating: techProfile?.rating?.avg,
        vehicleType: techProfile?.vehicleInfo?.type,
      },
    });

    realtimeEmitter.emitBookingStatus(updatedBooking._id.toString(), {
      bookingId: updatedBooking._id.toString(),
      bookingNumber: updatedBooking.bookingNumber,
      status: 'assigned',
      updatedAt: now.toISOString(),
      note: 'Offer accepted by technician',
    });

    realtimeEmitter.emitDispatchBoardUpdate({
      type: 'assigned',
      bookingId: updatedBooking._id.toString(),
      bookingNumber: updatedBooking.bookingNumber,
      timestamp: now.toISOString(),
    });

    return { success: true, booking: updatedBooking };
  }

  /**
   * Declines an offer and automatically advances to the next candidate.
   */
  static async declineOffer(
    offerId: string,
    technicianUserId: string,
    reason?: string
  ): Promise<{ success: boolean }> {
    const offer = await DispatchOffer.findById(offerId);
    if (!offer) {
      throw createHttpError('Offer not found', 404, 'NOT_FOUND');
    }

    if (offer.technicianUserId.toString() !== technicianUserId) {
      throw createHttpError('Forbidden: You can only respond to your own offers', 403, 'FORBIDDEN');
    }

    if (offer.status !== 'sent') {
      throw createHttpError(`Offer is already ${offer.status}`, 400, 'INVALID_STATE');
    }

    const now = new Date();
    offer.status = 'declined';
    offer.declineReason = reason;
    offer.respondedAt = now;
    await offer.save();

    // Check if any open offers remain for this booking
    const remainingOpen = await DispatchOffer.countDocuments({
      bookingId: offer.bookingId,
      status: 'sent',
    });

    if (remainingOpen === 0) {
      // Advance dispatch to next candidate
      await this.startDispatch(offer.bookingId, `decline:${technicianUserId}`);
    }

    return { success: true };
  }

  /**
   * Manual technician assignment by Admin or Dispatcher.
   */
  static async manualAssign(
    bookingId: string,
    technicianUserId: string,
    actor: { userId: string; role: string },
    force: boolean = false
  ): Promise<IBooking> {
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.deletedAt) {
      throw createHttpError('Booking not found', 404, 'NOT_FOUND');
    }

    const techUser = await User.findById(technicianUserId);
    if (!techUser) {
      throw createHttpError('Technician user not found', 404, 'NOT_FOUND');
    }

    // Force assignment is strictly admin-only
    if (force && actor.role !== 'admin') {
      throw createHttpError('Forbidden: Force assignment is restricted to admin role', 403, 'FORBIDDEN');
    }

    if (!force) {
      const candidates = await eligibleTechnicians(booking, { explain: true });
      const evalItem = candidates.find((c) => c.technicianUserId === technicianUserId);
      if (!evalItem || !evalItem.eligible) {
        const isConflict = evalItem?.exclusionReason?.toLowerCase().includes('overlapping');
        throw createHttpError(
          evalItem?.exclusionReason || 'Selected technician is not eligible for this booking',
          isConflict ? 409 : 400,
          isConflict ? 'SCHEDULE_CONFLICT' : 'TECHNICIAN_NOT_ELIGIBLE'
        );
      }
    }

    const now = new Date();
    const techUserObjId = new mongoose.Types.ObjectId(technicianUserId);

    booking.status = 'assigned';
    booking.technicianId = techUserObjId; // strictly in sync
    booking.assignment = {
      technicianUserId: techUserObjId,
      assignedAt: now,
      assignedBy: actor.role as 'admin' | 'dispatcher',
      acceptedAt: now,
    };
    booking.dispatch = booking.dispatch || { status: 'none', attempts: 0 };
    booking.dispatch.status = 'assigned';

    booking.statusHistory.push({
      status: 'assigned',
      by: `${actor.role}:${actor.userId}`,
      at: now,
      note: force
        ? `Forced manual assignment by ${actor.role}:${actor.userId}`
        : `Manual assignment by ${actor.role}:${actor.userId}`,
    });

    // Calculate booking window
    let serviceDurationMinutes = 60;
    if (booking.serviceId) {
      const serviceDoc = (await Service.findById(booking.serviceId).lean()) as { durationMinutes?: number } | null;
      if (serviceDoc && serviceDoc.durationMinutes) {
        serviceDurationMinutes = serviceDoc.durationMinutes;
      }
    }
    const settings = await DispatchSettings.getSettings();
    const bufferMinutes = settings.scheduleBufferMinutes ?? 30;
    const bStart = new Date(booking.scheduledAt);
    const bEnd = new Date(bStart.getTime() + (serviceDurationMinutes + bufferMinutes) * 60 * 1000);

    // Reserve schedule and detect conflicts
    if (!force) {
      const slotClaim = await TechnicianProfile.findOneAndUpdate(
        {
          userId: techUserObjId,
          activeSchedule: {
            $not: {
              $elemMatch: {
                start: { $lt: bEnd },
                end: { $gt: bStart },
              },
            },
          },
        },
        {
          $push: {
            activeSchedule: {
              bookingId: booking._id,
              start: bStart,
              end: bEnd,
              createdAt: new Date(),
            },
          },
        },
        { new: true }
      );

      if (!slotClaim) {
        throw createHttpError('Technician has a schedule conflict with an existing assigned booking', 409, 'SCHEDULE_CONFLICT');
      }
    } else {
      logger.warn(
        { bookingId: booking._id, technicianUserId, actor },
        'Admin forced manual assignment overriding schedule conflict'
      );
      await TechnicianProfile.updateOne(
        { userId: techUserObjId },
        {
          $push: {
            activeSchedule: {
              bookingId: booking._id,
              start: bStart,
              end: bEnd,
              createdAt: new Date(),
            },
          },
        }
      );
    }

    try {
      await booking.save();
    } catch (saveErr) {
      await TechnicianProfile.updateOne(
        { userId: techUserObjId },
        { $pull: { activeSchedule: { bookingId: booking._id } } }
      );
      throw saveErr;
    }

    // Cancel all open offers for this booking
    await DispatchOffer.updateMany(
      { bookingId: booking._id, status: 'sent' },
      { $set: { status: 'cancelled', respondedAt: now } }
    );

    const techProfile = await TechnicianProfile.findOne({ userId: techUserObjId }).lean();
    const customerEmail = booking.guest?.email;
    const customerName = booking.guest?.fullName || 'Valued Customer';

    if (customerEmail) {
      sendEmail({
        to: customerEmail,
        subject: `Technician Assigned: Booking #${booking.bookingNumber}`,
        html: getCustomerTechnicianAssignedEmail({
          fullName: customerName,
          bookingNumber: booking.bookingNumber,
          serviceName: booking.serviceSnapshot?.name || 'Detailing Service',
          technicianName: techProfile?.displayName || 'Certified Technician',
          scheduledTime: `${booking.scheduledLocal?.date} ${booking.scheduledLocal?.slot}`,
        }),
      }).catch((err) => logger.error({ err }, 'Failed to send customer assignment email'));
    }

    realtimeEmitter.emitBookingAssigned(booking._id.toString(), {
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      technician: {
        displayName: techProfile?.displayName || 'Technician',
        photoUrl: techProfile?.photoUrl,
        rating: techProfile?.rating?.avg,
        vehicleType: techProfile?.vehicleInfo?.type,
      },
    });

    realtimeEmitter.emitBookingStatus(booking._id.toString(), {
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      status: 'assigned',
      updatedAt: now.toISOString(),
      note: `Assigned by ${actor.role}`,
    });

    realtimeEmitter.emitDispatchBoardUpdate({
      type: 'assigned',
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      timestamp: now.toISOString(),
    });

    return booking;
  }

  /**
   * Reassigns a booking to another technician.
   */
  static async manualReassign(
    bookingId: string,
    newTechnicianUserId: string,
    actor: { userId: string; role: string },
    force: boolean = false
  ): Promise<IBooking> {
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.deletedAt) {
      throw createHttpError('Booking not found', 404, 'NOT_FOUND');
    }

    const prevTechId = booking.assignment?.technicianUserId?.toString() || booking.technicianId?.toString();
    if (prevTechId) {
      await TechnicianProfile.updateOne(
        { userId: new mongoose.Types.ObjectId(prevTechId) },
        { $pull: { activeSchedule: { bookingId: booking._id } } }
      );
    }
    const updated = await this.manualAssign(bookingId, newTechnicianUserId, actor, force);

    updated.statusHistory.push({
      status: 'assigned',
      by: `${actor.role}:${actor.userId}`,
      at: new Date(),
      note: `Reassigned from technician ${prevTechId || 'none'} to ${newTechnicianUserId}`,
    });
    await updated.save();

    realtimeEmitter.emitDispatchBoardUpdate({
      type: 'reassigned',
      bookingId: updated._id.toString(),
      bookingNumber: updated.bookingNumber,
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  /**
   * Unassigns technician and returns booking to confirmed unassigned queue.
   */
  static async manualUnassign(
    bookingId: string,
    actor: { userId: string; role: string }
  ): Promise<IBooking> {
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.deletedAt) {
      throw createHttpError('Booking not found', 404, 'NOT_FOUND');
    }

    const prevTech = booking.assignment?.technicianUserId?.toString() || booking.technicianId?.toString();
    const now = new Date();

    booking.status = 'confirmed';
    booking.technicianId = null;
    booking.set('assignment', undefined);
    booking.dispatch = booking.dispatch || { status: 'none', attempts: 0 };
    booking.dispatch.status = 'none';

    booking.statusHistory.push({
      status: 'confirmed',
      by: `${actor.role}:${actor.userId}`,
      at: now,
      note: `Unassigned from technician ${prevTech || 'unknown'} by ${actor.role}:${actor.userId}`,
    });

    await booking.save();

    if (prevTech) {
      await TechnicianProfile.updateOne(
        { userId: new mongoose.Types.ObjectId(prevTech) },
        { $pull: { activeSchedule: { bookingId: booking._id } } }
      );
    }

    realtimeEmitter.emitBookingStatus(booking._id.toString(), {
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      status: 'confirmed',
      updatedAt: now.toISOString(),
      note: 'Booking unassigned; moved back to confirmed queue',
    });

    realtimeEmitter.emitDispatchBoardUpdate({
      type: 'unassigned_manual',
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      timestamp: now.toISOString(),
    });

    return booking;
  }

  /**
   * Resets dispatch attempts and starts dispatch searching fresh.
   */
  static async manualRedispatch(
    bookingId: string,
    actor: { userId: string; role: string }
  ): Promise<IBooking> {
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.deletedAt) {
      throw createHttpError('Booking not found', 404, 'NOT_FOUND');
    }

    const prevTech = booking.assignment?.technicianUserId?.toString() || booking.technicianId?.toString();

    // Cancel existing open offers
    await DispatchOffer.updateMany(
      { bookingId: booking._id, status: 'sent' },
      { $set: { status: 'cancelled', respondedAt: new Date() } }
    );

    booking.status = 'confirmed';
    booking.technicianId = null;
    booking.assignment = undefined;
    booking.dispatch = {
      status: 'searching',
      attempts: 0,
      lastOfferAt: new Date(),
    };

    booking.statusHistory.push({
      status: 'confirmed',
      by: `${actor.role}:${actor.userId}`,
      at: new Date(),
      note: `Manual redispatch initiated by ${actor.role}:${actor.userId}`,
    });

    await booking.save();

    if (prevTech) {
      await TechnicianProfile.updateOne(
        { userId: new mongoose.Types.ObjectId(prevTech) },
        { $pull: { activeSchedule: { bookingId: booking._id } } }
      );
    }

    await this.startDispatch(booking._id, `${actor.role}:${actor.userId}`);
    return (await Booking.findById(bookingId))!;
  }

  /**
   * Retrieves candidate ranking with explanation for admin/dispatcher.
   */
  static async getCandidates(bookingId: string, explain: boolean = true): Promise<CandidateEvaluation[]> {
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.deletedAt) {
      throw createHttpError('Booking not found', 404, 'NOT_FOUND');
    }
    return eligibleTechnicians(booking, { explain });
  }

  /**
   * Retrieves offers history for a given booking (admin/dispatcher view).
   */
  static async getBookingOffers(bookingId: string): Promise<Record<string, unknown>[]> {
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.deletedAt) {
      throw createHttpError('Booking not found', 404, 'NOT_FOUND');
    }

    const offers = await DispatchOffer.find({ bookingId: booking._id })
      .sort({ createdAt: -1 })
      .lean();

    const techUserIds = offers.map((o) => o.technicianUserId);
    const profiles = techUserIds.length > 0
      ? await TechnicianProfile.find({ userId: { $in: techUserIds } }).lean()
      : [];
    const profileMap = new Map(profiles.map((p) => [p.userId.toString(), p.displayName || 'Technician']));

    return offers.map((o) => ({
      _id: o._id.toString(),
      bookingId: o.bookingId.toString(),
      technicianUserId: o.technicianUserId.toString(),
      technicianName: profileMap.get(o.technicianUserId.toString()) || 'Technician',
      status: o.status,
      sentAt: o.sentAt,
      expiresAt: o.expiresAt,
      respondedAt: o.respondedAt,
      declineReason: o.declineReason,
      rank: o.rank,
      source: o.source,
      createdAt: o.createdAt,
    }));
  }

  /**
   * Fetches the dispatch operations board.
   */
  static async getBoard(): Promise<{
    unassigned: unknown[];
    offered: unknown[];
    active: unknown[];
    activeJobs: unknown[];
    onlineTechnicians: unknown[];
  }> {
    const timezone = process.env.BUSINESS_TIMEZONE || 'America/New_York';

    // 1. Unassigned: confirmed or pending, not currently offered, no technician assigned
    const unassignedDocs = await Booking.find({
      status: { $in: ['confirmed', 'pending'] },
      'dispatch.status': { $ne: 'offered' },
      $or: [
        { 'assignment.technicianUserId': { $exists: false } },
        { 'assignment.technicianUserId': null },
      ],
      deletedAt: null,
    })
      .sort({ scheduledAt: 1 })
      .lean();

    // 2. Offered: currently in dispatch offer cycle
    const offeredDocs = await Booking.find({
      'dispatch.status': 'offered',
      status: { $in: ['confirmed', 'pending'] },
      deletedAt: null,
    })
      .sort({ scheduledAt: 1 })
      .lean();

    // 3. Active: assigned, en-route, arrived, in-progress
    const activeDocs = await Booking.find({
      status: { $in: ['assigned', 'technician_en_route', 'arrived', 'in_progress'] },
      deletedAt: null,
    })
      .sort({ scheduledAt: 1 })
      .lean();

    // 4. Batch lookup for assigned technician display names
    const assignedUserIds = activeDocs
      .map((b) => b.assignment?.technicianUserId || b.technicianId)
      .filter(Boolean) as mongoose.Types.ObjectId[];
    const techProfiles = assignedUserIds.length > 0
      ? await TechnicianProfile.find({ userId: { $in: assignedUserIds } }).lean()
      : [];
    const techNameMap = new Map<string, string>(
      techProfiles.map((tp) => [tp.userId.toString(), tp.displayName || 'Technician'])
    );

    // 5. Batch count open offers per booking
    const allBookingIds = [...unassignedDocs, ...offeredDocs, ...activeDocs].map((b) => b._id);
    const openOffers = allBookingIds.length > 0
      ? await DispatchOffer.find({
          bookingId: { $in: allBookingIds },
          status: 'sent',
        }).lean()
      : [];
    const openOffersMap = new Map<string, number>();
    for (const o of openOffers) {
      const bId = o.bookingId.toString();
      openOffersMap.set(bId, (openOffersMap.get(bId) || 0) + 1);
    }

    type BoardBookingDoc = Pick<IBooking, 'bookingNumber' | 'serviceSnapshot' | 'scheduledLocal' | 'timezone' | 'address' | 'status' | 'dispatch'> & {
      _id: mongoose.Types.ObjectId;
      assignment?: { technicianUserId?: mongoose.Types.ObjectId | null };
      technicianId?: mongoose.Types.ObjectId | null;
    };

    const mapBooking = (b: BoardBookingDoc) => {
      const tId = (b.assignment?.technicianUserId || b.technicianId)?.toString();
      const techName = tId ? techNameMap.get(tId) || null : null;
      return {
        id: b._id.toString(),
        _id: b._id.toString(),
        bookingNumber: b.bookingNumber,
        serviceName: b.serviceSnapshot?.name || 'Auto Detailing',
        scheduledLocal: b.scheduledLocal,
        timezone: b.timezone || timezone,
        city: b.address?.city || '',
        zip: b.address?.zip || '',
        status: b.status,
        dispatch: {
          status: b.dispatch?.status || 'none',
        },
        assignedTechnician: techName ? { displayName: techName } : null,
        assignedTechnicianDisplayName: techName,
        openOffersCount: openOffersMap.get(b._id.toString()) || 0,
      };
    };

    const unassigned = unassignedDocs.map(mapBooking);
    const offered = offeredDocs.map(mapBooking);
    const active = activeDocs.map(mapBooking);

    // 6. Online technicians (NO coordinates returned)
    const onlineProfiles = await TechnicianProfile.find({
      'availability.isOnline': true,
      verificationStatus: 'approved',
    }).lean();

    const techUserIds = onlineProfiles.map((p) => p.userId);
    const locations = techUserIds.length > 0
      ? await TechnicianLocation.find({
          technicianUserId: { $in: techUserIds },
        }).lean()
      : [];
    const locationMap = new Map(
      locations.map((l) => [l.technicianUserId.toString(), l])
    );

    // Calculate today's jobs count and active job for online techs
    const now = new Date();
    const todayLocal = utcToLocal(now, timezone).date;
    const startOfTodayUtc = localToUtc(todayLocal, '00:00', timezone);
    const endOfTodayUtc = new Date(startOfTodayUtc.getTime() + 24 * 60 * 60 * 1000);

    const todayBookings = techUserIds.length > 0
      ? await Booking.find({
          $or: [
            { technicianId: { $in: techUserIds } },
            { 'assignment.technicianUserId': { $in: techUserIds } },
          ],
          scheduledAt: { $gte: startOfTodayUtc, $lte: endOfTodayUtc },
          deletedAt: null,
        }).lean()
      : [];

    const jobsTodayMap = new Map<string, number>();
    const techActiveJobMap = new Map<string, string>();
    for (const b of todayBookings) {
      const tId = (b.assignment?.technicianUserId || b.technicianId)?.toString();
      if (tId) {
        jobsTodayMap.set(tId, (jobsTodayMap.get(tId) || 0) + 1);
        if (['assigned', 'technician_en_route', 'arrived', 'in_progress'].includes(b.status)) {
          techActiveJobMap.set(tId, b._id.toString());
        }
      }
    }

    const onlineTechnicians = onlineProfiles.map((p) => {
      const uId = p.userId.toString();
      const loc = locationMap.get(uId);
      return {
        userId: uId,
        technicianUserId: uId,
        displayName: p.displayName || 'Technician',
        isOnline: Boolean(p.availability?.isOnline),
        lastSeenAt: loc?.updatedAt || (p as { updatedAt?: Date }).updatedAt || null,
        jobsToday: jobsTodayMap.get(uId) || 0,
        activeJobId: loc?.bookingId?.toString() || techActiveJobMap.get(uId) || null,
        photoUrl: p.photoUrl,
        phone: p.phone,
        rating: p.rating?.avg ?? 5.0,
      };
    });

    return {
      unassigned,
      offered,
      active,
      activeJobs: active,
      onlineTechnicians,
    };
  }

  /**
   * Sweeper: expires overdue offers, advances dispatch, cleans up expired pings.
   * Safe to run concurrently on multiple instances.
   */
  static async runDispatchSweep(): Promise<{ expiredOffersCount: number; advancedBookings: number }> {
    const now = new Date();
    // Find candidate expired offers
    const candidates = await DispatchOffer.find({
      status: 'sent',
      expiresAt: { $lte: now },
    }).lean();

    let expiredOffersCount = 0;
    const bookingIdsToAdvance = new Set<string>();

    for (const c of candidates) {
      // Atomic status transition sent -> expired guarantees only one worker claims it
      const updated = await DispatchOffer.findOneAndUpdate(
        {
          _id: c._id,
          status: 'sent',
        },
        {
          $set: {
            status: 'expired',
            respondedAt: now,
          },
        },
        { new: true }
      );

      if (updated) {
        expiredOffersCount += 1;
        realtimeEmitter.emitOfferExpired(c.technicianUserId.toString(), {
          offerId: c._id.toString(),
          bookingId: c.bookingId.toString(),
          reason: 'Offer expired automatically',
        });
        bookingIdsToAdvance.add(c.bookingId.toString());
      }
    }

    let advancedBookings = 0;
    for (const bId of bookingIdsToAdvance) {
      // Check if any open offers still remain for this booking
      const openOffers = await DispatchOffer.countDocuments({
        bookingId: bId,
        status: 'sent',
      });
      if (openOffers === 0) {
        const res = await this.startDispatch(bId, 'sweeper');
        if (res.status === 'offered' || res.status === 'exhausted') {
          advancedBookings += 1;
        }
      }
    }

    // Clean up old location pings (> 24h after completion or cancellation)
    try {
      const cutOff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const finishedBookings = await Booking.find({
        status: { $in: ['completed', 'cancelled'] },
        updatedAt: { $lte: cutOff },
      })
        .select('_id')
        .lean();

      if (finishedBookings.length > 0) {
        const finishedIds = finishedBookings.map((b) => b._id);
        await LocationPing.deleteMany({ bookingId: { $in: finishedIds } });
        await TechnicianLocation.updateMany(
          { bookingId: { $in: finishedIds } },
          { $set: { bookingId: null } }
        );
      }
    } catch (err: unknown) {
      logger.error({ err }, 'Sweeper location cleanup error');
    }

    return { expiredOffersCount, advancedBookings };
  }

  /**
   * Reconciles TechnicianProfile.activeSchedule against Bookings (Single Source of Truth).
   * - Removes entries whose booking is missing, deleted, terminal, not assigned to that tech, or has different scheduled times
   * - Adds missing entries for active assigned bookings
   * - Idempotent, safe under concurrency (uses atomic operations)
   * - Logs only aggregate counts (no PII or IDs)
   */
  static async reconcileTechnicianSchedules(): Promise<{ removed: number; added: number }> {
    let removed = 0;
    let added = 0;

    const dispatchSettings = await DispatchSettings.getSettings();
    const bufferMinutes = dispatchSettings.scheduleBufferMinutes ?? 30;

    // 1. Audit existing slots on all technician profiles with non-empty activeSchedule
    const profiles = await TechnicianProfile.find({
      'activeSchedule.0': { $exists: true },
    }).lean();

    for (const profile of profiles) {
      if (!profile.activeSchedule || profile.activeSchedule.length === 0) continue;

      // If technician is not approved, remove all slots
      if (profile.verificationStatus !== 'approved') {
        const pullRes = await TechnicianProfile.updateOne(
          { _id: profile._id },
          { $set: { activeSchedule: [] } }
        );
        if (pullRes.modifiedCount > 0) {
          removed += profile.activeSchedule.length;
        }
        continue;
      }

      for (const slot of profile.activeSchedule) {
        // Entries younger than 120 seconds are protected from removal (in-flight accept grace period)
        const slotCreatedAt = slot.createdAt ? new Date(slot.createdAt).getTime() : 0;
        if (Date.now() - slotCreatedAt < 120_000) {
          continue;
        }

        const booking = await Booking.findById(slot.bookingId).lean();
        let shouldRemove = false;

        if (!booking || booking.deletedAt) {
          shouldRemove = true;
        } else if (['completed', 'cancelled', 'no_show', 'refunded'].includes(booking.status)) {
          shouldRemove = true;
        } else {
          // Check assignment
          const assignedId = (booking.assignment?.technicianUserId || booking.technicianId)?.toString();
          if (assignedId !== profile.userId.toString()) {
            shouldRemove = true;
          } else {
            // Check times: slot.start must match booking.scheduledAt (within 60 seconds tolerance)
            const slotStart = new Date(slot.start).getTime();
            const bookingStart = new Date(booking.scheduledAt).getTime();
            if (Math.abs(slotStart - bookingStart) > 60000) {
              shouldRemove = true;
            }
          }
        }

        if (shouldRemove) {
          const res = await TechnicianProfile.updateOne(
            { _id: profile._id },
            { $pull: { activeSchedule: { bookingId: slot.bookingId } } }
          );
          if (res.modifiedCount > 0) {
            removed++;
          }
        }
      }
    }

    // 2. Find all active assigned bookings and ensure a slot exists
    const activeAssignedBookings = await Booking.find({
      status: { $in: ['assigned', 'technician_en_route', 'arrived', 'in_progress'] },
      $or: [
        { 'assignment.technicianUserId': { $ne: null } },
        { technicianId: { $ne: null } },
      ],
      deletedAt: null,
    }).lean();

    for (const b of activeAssignedBookings) {
      const techUserId = b.assignment?.technicianUserId || b.technicianId;
      if (!techUserId) continue;

      let serviceDurationMinutes = 60;
      if (b.serviceId) {
        const sDoc = (await Service.findById(b.serviceId).lean()) as { durationMinutes?: number } | null;
        if (sDoc && sDoc.durationMinutes) {
          serviceDurationMinutes = sDoc.durationMinutes;
        }
      }

      const bStart = new Date(b.scheduledAt);
      const bEnd = new Date(bStart.getTime() + (serviceDurationMinutes + bufferMinutes) * 60 * 1000);

      // Atomically add if missing
      const pushRes = await TechnicianProfile.updateOne(
        {
          userId: techUserId,
          verificationStatus: 'approved',
          'activeSchedule.bookingId': { $ne: b._id },
        },
        {
          $push: {
            activeSchedule: {
              bookingId: b._id,
              start: bStart,
              end: bEnd,
              createdAt: new Date(),
            },
          },
        }
      );
      if (pushRes.modifiedCount > 0) {
        added++;
      }
    }

    logger.info(
      { removed, added },
      '[Reconcile] Technician activeSchedule reconciliation completed'
    );

    return { removed, added };
  }
}
