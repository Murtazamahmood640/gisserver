import mongoose from 'mongoose';
import { Booking, IBooking, BookingStatus } from '../../models/Booking';
import { DispatchOffer } from '../../models/DispatchOffer';
import { TechnicianProfile } from '../../models/TechnicianProfile';
import { TechnicianLocation } from '../../models/TechnicianLocation';
import { DispatchSettings } from '../../models/DispatchSettings';
import { Service } from '../../models/Service';
import { isValidTransition } from '../bookings/stateMachine';
import { DispatchService } from '../dispatch/service';
import { realtimeEmitter } from '../../realtime/emitter';
import { createHttpError } from '../../utils/httpErrors';
import {
  sendEmail,
  getCustomerTechnicianEnRouteEmail,
  getCustomerTechnicianArrivedEmail,
  getCustomerJobCompletedEmail,
} from '../../services/emailService';
import logger from '../../config/logger';

function getBaseFrontendUrl(): string {
  const raw = process.env.FRONTEND_URL;
  if (raw && raw.trim()) {
    return raw.split(',')[0].trim().replace(/\/$/, '');
  }
  return 'https://globalintegratedsupport.com';
}

/**
 * Masks an address for offer preview: removes street number and street name; keeps city, state, zip only.
 */
function maskAddressForOffer(address: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!address) return {};
  return {
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country,
  };
}

export class JobsService {
  /**
   * Returns dispatch config fields needed by the technician client.
   * Only the three fields needed for UI behavior are returned — never full admin settings.
   */
  static async getConfig() {
    const settings = await DispatchSettings.getSettings();
    return {
      locationMinIntervalSeconds: settings.locationMinIntervalSeconds ?? 5,
      offerTimeoutSecondsAsap: settings.offerTimeoutSecondsAsap ?? 60,
      offerTimeoutMinutesScheduled: settings.offerTimeoutMinutesScheduled ?? 30,
    };
  }

  /**
   * Returns jobs for a technician filtered by view:
   *   offers   — active (sent, non-expired) offers
   *   upcoming — assigned bookings scheduled in the future
   *   active   — bookings currently in progress (en_route, arrived, in_progress)
   *   history  — completed or cancelled bookings
   * Default (no view): returns all assigned bookings + active offers.
   * Address is masked (city/zip only) for offers; full address shown once assigned.
   */
  static async getMyJobs(
    technicianUserId: string,
    query: { page?: number; limit?: number; status?: string; view?: string }
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(query.limit) || 20));
    const skip = (page - 1) * limit;
    const view = query.view as string | undefined;

    const techObjId = new mongoose.Types.ObjectId(technicianUserId);

    // ── Offers view ────────────────────────────────────────────────────────
    if (view === 'offers') {
      const offers = await DispatchOffer.find({
        technicianUserId: techObjId,
        status: 'sent',
        expiresAt: { $gt: new Date() },
      })
        .sort({ expiresAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const totalOffers = await DispatchOffer.countDocuments({
        technicianUserId: techObjId,
        status: 'sent',
        expiresAt: { $gt: new Date() },
      });

      // Enrich each offer with masked booking details
      const enriched = await Promise.all(
        offers.map(async (offer) => {
          const booking = await Booking.findById(offer.bookingId).lean();
          if (!booking) return { offer };
          let serviceName = booking.serviceSnapshot?.name || '';
          if (!serviceName && booking.serviceId) {
            const svc = await Service.findById(booking.serviceId).lean();
            if (svc) serviceName = (svc as { name?: string }).name || '';
          }
          return {
            offer: {
              _id: offer._id,
              expiresAt: offer.expiresAt,
            },
            booking: {
              _id: booking._id,
              bookingNumber: booking.bookingNumber,
              status: booking.status,
              serviceSnapshot: { ...booking.serviceSnapshot, name: serviceName },
              vehicleSnapshot: booking.vehicleSnapshot,
              address: maskAddressForOffer(booking.address as Record<string, unknown>),
              scheduledAt: booking.scheduledAt,
              scheduledLocal: booking.scheduledLocal,
              timezone: booking.timezone,
              notes: booking.notes,
            },
          };
        })
      );

      return {
        view: 'offers',
        offers: enriched,
        pagination: {
          total: totalOffers,
          page,
          limit,
          totalPages: Math.ceil(totalOffers / limit),
        },
      };
    }

    // ── Booking-based views ────────────────────────────────────────────────
    const assignmentFilter = {
      $or: [
        { 'assignment.technicianUserId': techObjId },
        { technicianId: techObjId },
      ],
      deletedAt: null,
    };

    let statusFilter: Record<string, unknown> = {};
    if (view === 'upcoming') {
      statusFilter = {
        status: 'assigned',
        scheduledAt: { $gte: new Date() },
      };
    } else if (view === 'active') {
      statusFilter = {
        status: { $in: ['technician_en_route', 'arrived', 'in_progress'] },
      };
    } else if (view === 'history') {
      statusFilter = {
        status: { $in: ['completed', 'cancelled', 'no_show', 'refunded'] },
      };
    } else if (query.status) {
      statusFilter = { status: query.status };
    }

    const filter = { ...assignmentFilter, ...statusFilter };

    const [total, rawBookings] = await Promise.all([
      Booking.countDocuments(filter),
      Booking.find(filter)
        .sort({ scheduledAt: view === 'history' ? -1 : 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const activeStatuses = ['assigned', 'technician_en_route', 'arrived', 'in_progress'];

    const sanitizedJobs = await Promise.all(
      rawBookings.map(async (b) => {
        const customerFullName = b.guest?.fullName || '';
        const firstName = customerFullName ? customerFullName.split(' ')[0] : 'Customer';
        const isActive = activeStatuses.includes(b.status);
        const isCompleted = b.status === 'completed';
        const completedRecently =
          isCompleted &&
          b.completedAt &&
          Date.now() - new Date(b.completedAt).getTime() <= 24 * 60 * 60 * 1000;
        const showPhone = Boolean(isActive || completedRecently);

        let serviceName = b.serviceSnapshot?.name || '';
        if (!serviceName && b.serviceId) {
          const svc = await Service.findById(b.serviceId).lean();
          if (svc) serviceName = (svc as { name?: string }).name || '';
        }

        return {
          _id: b._id,
          bookingNumber: b.bookingNumber,
          status: b.status,
          serviceSnapshot: { ...b.serviceSnapshot, name: serviceName },
          vehicleSnapshot: b.vehicleSnapshot,
          address: b.address,
          scheduledAt: b.scheduledAt,
          scheduledLocal: b.scheduledLocal,
          timezone: b.timezone,
          notes: b.notes,
          enRouteAt: b.enRouteAt,
          arrivedAt: b.arrivedAt,
          startedAt: b.startedAt,
          completedAt: b.completedAt,
          completion: b.completion,
          customer: {
            firstName,
            phone: showPhone ? (b.guest?.phone || '') : '',
          },
        };
      })
    );

    // For the default (no view), also include active offers
    let offersSection: unknown[] = [];
    if (!view) {
      const activeOffers = await DispatchOffer.find({
        technicianUserId: techObjId,
        status: 'sent',
        expiresAt: { $gt: new Date() },
      })
        .sort({ expiresAt: 1 })
        .lean();
      offersSection = activeOffers;
    }

    return {
      view: view || 'all',
      jobs: sanitizedJobs,
      ...(view ? {} : { offers: offersSection }),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Fetches full job detail for a technician.
   * Customer phone and first name are visible ONLY once assigned; NEVER customer email.
   */
  static async getJobDetail(bookingId: string, technicianUserId: string) {
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null }).lean();
    if (!booking) {
      throw createHttpError('Job not found', 404, 'NOT_FOUND');
    }

    const isAssigned =
      booking.assignment?.technicianUserId?.toString() === technicianUserId ||
      booking.technicianId?.toString() === technicianUserId;

    if (!isAssigned) {
      // Check if tech has an active offer for this job
      const offer = await DispatchOffer.findOne({
        bookingId: booking._id,
        technicianUserId: new mongoose.Types.ObjectId(technicianUserId),
        status: 'sent',
      }).lean();

      if (!offer) {
        throw createHttpError('Forbidden: You are not assigned to this job and have no active offer', 403, 'FORBIDDEN');
      }

      // Return offer preview: no customer PII at all
      return {
        _id: booking._id,
        bookingNumber: booking.bookingNumber,
        status: booking.status,
        serviceSnapshot: booking.serviceSnapshot,
        vehicleSnapshot: booking.vehicleSnapshot,
        address: {
          city: booking.address?.city,
          state: booking.address?.state,
          zip: booking.address?.zip,
        },
        scheduledAt: booking.scheduledAt,
        scheduledLocal: booking.scheduledLocal,
        notes: booking.notes,
        offer,
      };
    }

    // After cancel, technician gets 403 on job detail
    if (booking.status === 'cancelled') {
      throw createHttpError('Forbidden: Job has been cancelled', 403, 'FORBIDDEN');
    }

    // Full assigned view
    const customerFullName = booking.guest?.fullName || '';
    const firstName = customerFullName ? customerFullName.split(' ')[0] : 'Customer';

    const activeStatuses = ['assigned', 'technician_en_route', 'arrived', 'in_progress'];
    const isActive = activeStatuses.includes(booking.status);
    const isCompleted = booking.status === 'completed';
    const completedRecently =
      isCompleted &&
      booking.completedAt &&
      Date.now() - new Date(booking.completedAt).getTime() <= 24 * 60 * 60 * 1000;
    const showPhone = Boolean(isActive || completedRecently);

    return {
      _id: booking._id,
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      serviceSnapshot: booking.serviceSnapshot,
      addons: booking.addons,
      vehicleSnapshot: booking.vehicleSnapshot,
      address: booking.address,
      scheduledAt: booking.scheduledAt,
      scheduledLocal: booking.scheduledLocal,
      notes: booking.notes,
      enRouteAt: booking.enRouteAt,
      arrivedAt: booking.arrivedAt,
      startedAt: booking.startedAt,
      completedAt: booking.completedAt,
      completion: booking.completion,
      customer: {
        firstName,
        phone: showPhone ? (booking.guest?.phone || '') : '',
        // email strictly excluded
      },
    };
  }

  /**
   * Helper to verify and execute state machine transitions for the assigned technician.
   */
  private static async transitionJobState(
    bookingId: string,
    technicianUserId: string,
    targetStatus: BookingStatus,
    timestampField?: 'enRouteAt' | 'arrivedAt' | 'startedAt' | 'completedAt',
    extraUpdates?: Record<string, unknown>
  ): Promise<IBooking> {
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null });
    if (!booking) {
      throw createHttpError('Job not found', 404, 'NOT_FOUND');
    }

    const isAssigned =
      booking.assignment?.technicianUserId?.toString() === technicianUserId ||
      booking.technicianId?.toString() === technicianUserId;

    if (!isAssigned) {
      throw createHttpError('Forbidden: Only the assigned technician can update job status', 403, 'FORBIDDEN');
    }

    if (booking.status === targetStatus || !isValidTransition(booking.status, targetStatus)) {
      throw createHttpError(
        `Invalid status transition from '${booking.status}' to '${targetStatus}'`,
        400,
        'INVALID_TRANSITION'
      );
    }

    const now = new Date();
    booking.status = targetStatus;
    if (timestampField) {
      booking[timestampField] = now;
    }

    if (extraUpdates) {
      Object.assign(booking, extraUpdates);
    }

    booking.statusHistory.push({
      status: targetStatus,
      by: `technician:${technicianUserId}`,
      at: now,
      note: `Job transitioned to ${targetStatus} by technician`,
    });

    await booking.save();

    realtimeEmitter.emitBookingStatus(booking._id.toString(), {
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      status: targetStatus,
      updatedAt: now.toISOString(),
    });

    return booking;
  }

  /**
   * Technician marks En Route.
   */
  static async enRoute(bookingId: string, technicianUserId: string): Promise<IBooking> {
    const booking = await this.transitionJobState(
      bookingId,
      technicianUserId,
      'technician_en_route',
      'enRouteAt'
    );

    // Link active job to technician current location
    await TechnicianLocation.updateOne(
      { technicianUserId: new mongoose.Types.ObjectId(technicianUserId) },
      { $set: { bookingId: booking._id, updatedAt: new Date() } }
    );

    // Send customer email
    const techProfile = await TechnicianProfile.findOne({
      userId: new mongoose.Types.ObjectId(technicianUserId),
    }).lean();
    const customerEmail = booking.guest?.email;
    if (customerEmail) {
      sendEmail({
        to: customerEmail,
        subject: `Your Technician is On The Way - Booking #${booking.bookingNumber}`,
        html: getCustomerTechnicianEnRouteEmail({
          fullName: booking.guest?.fullName || 'Valued Customer',
          bookingNumber: booking.bookingNumber,
          technicianName: techProfile?.displayName || 'Your Technician',
          trackingUrl: `${getBaseFrontendUrl()}/book/track?id=${booking._id}`,
        }),
      }).catch((err) => logger.error({ err }, 'Failed to send en route customer email'));
    }

    return booking;
  }

  /**
   * Technician marks Arrived.
   */
  static async arrived(bookingId: string, technicianUserId: string): Promise<IBooking> {
    const booking = await this.transitionJobState(
      bookingId,
      technicianUserId,
      'arrived',
      'arrivedAt'
    );

    const techProfile = await TechnicianProfile.findOne({
      userId: new mongoose.Types.ObjectId(technicianUserId),
    }).lean();
    const customerEmail = booking.guest?.email;
    if (customerEmail) {
      sendEmail({
        to: customerEmail,
        subject: `Technician Has Arrived - Booking #${booking.bookingNumber}`,
        html: getCustomerTechnicianArrivedEmail({
          fullName: booking.guest?.fullName || 'Valued Customer',
          bookingNumber: booking.bookingNumber,
          technicianName: techProfile?.displayName || 'Your Technician',
        }),
      }).catch((err) => logger.error({ err }, 'Failed to send arrived customer email'));
    }

    return booking;
  }

  /**
   * Technician starts service (In Progress).
   */
  static async start(bookingId: string, technicianUserId: string): Promise<IBooking> {
    return this.transitionJobState(
      bookingId,
      technicianUserId,
      'in_progress',
      'startedAt'
    );
  }

  /**
   * Technician completes service.
   */
  static async complete(
    bookingId: string,
    technicianUserId: string,
    data: { notes?: string; checklist?: Array<{ label: string; done: boolean }> }
  ): Promise<IBooking> {
    const booking = await this.transitionJobState(
      bookingId,
      technicianUserId,
      'completed',
      'completedAt',
      { completion: data }
    );

    // Update technician profile stats and remove active schedule slot
    await TechnicianProfile.updateOne(
      { userId: new mongoose.Types.ObjectId(technicianUserId) },
      {
        $inc: { 'stats.jobsCompleted': 1 },
        $pull: { activeSchedule: { bookingId: booking._id } },
      }
    );

    // Clear active job link on technician location
    await TechnicianLocation.updateOne(
      { technicianUserId: new mongoose.Types.ObjectId(technicianUserId) },
      { $set: { bookingId: null, updatedAt: new Date() } }
    );

    const customerEmail = booking.guest?.email;
    if (customerEmail) {
      sendEmail({
        to: customerEmail,
        subject: `Service Completed - Booking #${booking.bookingNumber}`,
        html: getCustomerJobCompletedEmail({
          fullName: booking.guest?.fullName || 'Valued Customer',
          bookingNumber: booking.bookingNumber,
          serviceName: booking.serviceSnapshot?.name || 'Car Detailing Service',
        }),
      }).catch((err) => logger.error({ err }, 'Failed to send complete customer email'));
    }

    return booking;
  }

  /**
   * Technician voluntarily releases job back to dispatch.
   */
  static async release(
    bookingId: string,
    technicianUserId: string,
    reason: string
  ): Promise<IBooking> {
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null });
    if (!booking) {
      throw createHttpError('Job not found', 404, 'NOT_FOUND');
    }

    const isAssigned =
      booking.assignment?.technicianUserId?.toString() === technicianUserId ||
      booking.technicianId?.toString() === technicianUserId;

    if (!isAssigned) {
      throw createHttpError('Forbidden: Only the assigned technician can release this job', 403, 'FORBIDDEN');
    }

    if (['in_progress', 'completed', 'cancelled'].includes(booking.status)) {
      throw createHttpError(`Cannot release job in status '${booking.status}'`, 400, 'INVALID_STATE');
    }

    const now = new Date();
    booking.status = 'confirmed';
    booking.technicianId = null;
    booking.assignment = undefined;
    booking.dispatch = {
      status: 'searching',
      attempts: (booking.dispatch?.attempts || 0) + 1,
      lastOfferAt: now,
    };

    booking.statusHistory.push({
      status: 'confirmed',
      by: `technician:${technicianUserId}`,
      at: now,
      note: `Job released by technician: ${reason}`,
    });

    await booking.save();

    // Pull active schedule slot on technician profile
    await TechnicianProfile.updateOne(
      { userId: new mongoose.Types.ObjectId(technicianUserId) },
      { $pull: { activeSchedule: { bookingId: booking._id } } }
    );

    // Clear active job link on technician location
    await TechnicianLocation.updateOne(
      { technicianUserId: new mongoose.Types.ObjectId(technicianUserId) },
      { $set: { bookingId: null, updatedAt: now } }
    );

    realtimeEmitter.emitBookingStatus(booking._id.toString(), {
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      status: 'confirmed',
      updatedAt: now.toISOString(),
      note: 'Job released by technician, returned to dispatch queue',
    });

    // Advance automated dispatch
    await DispatchService.startDispatch(booking._id, `release:${technicianUserId}`);

    return booking;
  }
}
