import mongoose from 'mongoose';
import crypto from 'crypto';
import { Booking, IBooking, BookingStatus, BookingSource } from '../../models/Booking';
import { BookingSettings, IBookingSettings } from '../../models/BookingSettings';
import { Vehicle } from '../../models/Vehicle';
import { CustomerProfile } from '../../models/CustomerProfile';
import { getNextSequenceValue } from '../../models/Counter';
import { calculateBookingPricing } from './pricing';
import {
  AvailabilityService,
  localToUtc,
  normalizeSlotTo24h,
  formatSlotTo12h,
} from './availability';
import { isValidTransition } from './stateMachine';
import {
  sendEmail,
  getBookingConfirmationEmail,
  getAdminNotificationEmail,
  getStatusUpdateEmail,
} from '../../services/emailService';
import logger from '../../config/logger';
import { DispatchSettings } from '../../models/DispatchSettings';
import { DispatchService } from '../dispatch/service';
import { TechnicianProfile } from '../../models/TechnicianProfile';
import { Service } from '../../models/Service';
import { checkTechnicianAvailabilityConflict } from '../dispatch/matching';
import { createHttpError } from '../../utils/httpErrors';
import { PaymentSettings } from '../../models/PaymentSettings';
import { PaymentService } from '../payments/service';
import { User } from '../../models/User';

export interface CreateBookingServiceInput {
  serviceId: string;
  vehicleCategory?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleYear?: number;
  vehicleId?: string;
  addonIds?: string[];
  couponCode?: string | null;
  date: string; // "YYYY-MM-DD"
  slot: string; // "HH:mm" or "09:00 AM"
  phone?: string;
  customerPhone?: string;
  address?: any;
  addressId?: string;
  guest?: {
    fullName: string;
    email: string;
    phone: string;
  };
  notes?: string;
  source?: BookingSource;
  legacyAppointmentId?: mongoose.Types.ObjectId | null;
}

export class BookingService {
  /**
   * Creates a booking with atomic concurrency reservation, server pricing, and email alerts.
   */
  static async createBooking(
    input: CreateBookingServiceInput,
    authUser?: { userId: string; email: string; role: string; emailVerified?: boolean }
  ): Promise<IBooking> {
    const isGuest = !authUser;

    // 1. Validate customer / guest details
    let customerId: mongoose.Types.ObjectId | null = null;
    let customerUser: any = null;
    const guestInfo = input.guest;

    if (!isGuest) {
      customerId = new mongoose.Types.ObjectId(authUser.userId);
      try {
        customerUser = await User.findById(customerId).select('fullName email phone phoneCountryCode');
        if (customerUser && !customerUser.phone && (input.phone || input.customerPhone)) {
          customerUser.phone = input.phone || input.customerPhone;
          await customerUser.save().catch(() => {});
        }
      } catch (uErr) {
        logger.warn({ err: uErr }, 'Failed to lookup booking customer user details');
      }
    } else {
      if (!guestInfo?.fullName || !guestInfo?.email || !guestInfo?.phone) {
        const err = new Error('Guest booking requires full name, email, and phone number') as any;
        err.statusCode = 400;
        err.code = 'GUEST_INFO_REQUIRED';
        throw err;
      }
    }

    // Generate guest token if booking is made as a guest
    let guestAccessToken: string | null = null;
    let guestAccessTokenHash: string | null = null;
    if (isGuest) {
      guestAccessToken = crypto.randomBytes(32).toString('hex');
      guestAccessTokenHash = crypto.createHash('sha256').update(guestAccessToken).digest('hex');
    }

    // 2. Resolve vehicle details
    let resolvedVehicleCategory = input.vehicleCategory || 'sedan';
    let vehicleMake = input.vehicleMake || '';
    let vehicleModel = input.vehicleModel || '';
    let vehicleYear = input.vehicleYear || new Date().getFullYear();
    let vehicleId: mongoose.Types.ObjectId | null = null;

    if (input.vehicleId && mongoose.isValidObjectId(input.vehicleId)) {
      const vehicle = await Vehicle.findOne({
        _id: input.vehicleId,
        deletedAt: null,
      });
      if (vehicle) {
        vehicleId = vehicle._id;
        resolvedVehicleCategory = vehicle.category;
        vehicleMake = vehicle.make;
        vehicleModel = vehicle.vehicleModel;
        vehicleYear = vehicle.year;
      }
    }

    // 3. Resolve address details
    let resolvedAddress = input.address || { country: 'USA' };
    if (input.addressId && customerId && mongoose.isValidObjectId(input.addressId)) {
      const profile = await CustomerProfile.findOne({ userId: customerId });
      const savedAddr = profile?.savedAddresses.find(
        (a: any) => a._id?.toString() === input.addressId
      );
      if (savedAddr) {
        resolvedAddress = {
          line1: savedAddr.line1,
          line2: savedAddr.line2,
          city: savedAddr.city,
          state: savedAddr.state,
          zip: savedAddr.zip,
          country: savedAddr.country,
        };
      }
    }

    // 4. Server-side pricing calculation (never trusts client price)
    const pricingResult = await calculateBookingPricing({
      serviceId: input.serviceId,
      vehicleCategory: resolvedVehicleCategory,
      addonIds: input.addonIds,
      couponCode: input.couponCode,
    });

    // 5. Scheduling, Timezone, and Availability
    const settings = await AvailabilityService.getBookingSettings();
    const timezone = settings.businessTimezone;
    const slot24 = normalizeSlotTo24h(input.slot);
    const scheduledAt = localToUtc(input.date, slot24, timezone);
    const scheduledLocal = { date: input.date, slot: slot24 };

    // 6. Concurrency-safe atomic slot reservation
    await AvailabilityService.reserveSlotAtomic(
      input.date,
      slot24,
      pricingResult.service.categoryId,
      settings.slotCapacity
    );

    // 7. Generate atomic booking number
    let bookingNumber = '';
    try {
      const seq = await getNextSequenceValue('bookings');
      bookingNumber = `GIS-${String(seq).padStart(6, '0')}`;
    } catch (seqErr) {
      bookingNumber = `GIS-${Date.now().toString().slice(-6)}`;
    }

    // 8. Determine initial paymentStatus and expiry from PaymentSettings
    let initialPaymentStatus = 'unpaid';
    let paymentExpiresAt: Date | undefined;
    try {
      const paySettings = await PaymentSettings.getSettings();
      if (paySettings.requirePrepayment) {
        initialPaymentStatus = 'pending';
        paymentExpiresAt = new Date(Date.now() + paySettings.unpaidExpiryMinutes * 60000);
      }
    } catch {
      // Fallback to unpaid
    }

    // 9. Create booking document
    const booking = new Booking({
      bookingNumber,
      customerId,
      guest: guestInfo || (customerUser ? {
        fullName: customerUser.fullName || 'Customer',
        email: customerUser.email || authUser?.email || '',
        phone: customerUser.phone || input.phone || input.customerPhone || '',
      } : (input.phone || input.customerPhone) ? {
        fullName: 'Customer',
        email: authUser?.email || '',
        phone: input.phone || input.customerPhone || '',
      } : undefined),
      guestAccessTokenHash,
      vehicleId,
      vehicleSnapshot: {
        category: pricingResult.vehicleCategory,
        make: vehicleMake,
        model: vehicleModel,
        year: vehicleYear,
      },
      categoryId: pricingResult.service.categoryId,
      serviceId: pricingResult.service._id,
      serviceSnapshot: {
        name: pricingResult.service.name,
        slug: pricingResult.service.slug,
      },
      addons: pricingResult.addons,
      address: resolvedAddress,
      scheduledAt,
      scheduledLocal,
      timezone,
      isAsap: false,
      status: 'pending',
      statusHistory: [
        {
          status: 'pending',
          by: authUser ? authUser.email : (guestInfo?.email || 'guest'),
          at: new Date(),
          note: 'Booking created via ' + (input.source || 'web'),
        },
      ],
      pricing: pricingResult.pricing,
      paymentStatus: initialPaymentStatus,
      ...(paymentExpiresAt ? { paymentExpiresAt } : {}),
      notes: input.notes || '',
      source: input.source || 'web',
      ...(input.legacyAppointmentId ? { legacyAppointmentId: input.legacyAppointmentId } : {}),
      deletedAt: null,
    });

    try {
      await booking.save();
    } catch (saveErr) {
      // Rollback the slot reservation on save failure
      await AvailabilityService.releaseSlotAtomic(
        input.date,
        slot24,
        pricingResult.service.categoryId
      );
      throw saveErr;
    }

    // 9. Send emails asynchronously
    const recipientPhone =
      guestInfo?.phone ||
      customerUser?.phone ||
      input.phone ||
      input.customerPhone ||
      booking.guest?.phone ||
      '';
    const recipientEmail = guestInfo?.email || customerUser?.email || authUser?.email;
    const recipientName = guestInfo?.fullName || customerUser?.fullName || 'Customer';

    if (recipientEmail) {
      const frontendUrl =
        process.env.FRONTEND_URL?.split(',')[0].trim().replace(/\/$/, '') ||
        'https://globalintegratedsupport.com';
      const guestAccessLink = guestAccessToken
        ? `${frontendUrl}/book?id=${booking._id}&token=${guestAccessToken}`
        : undefined;

      sendEmail({
        to: recipientEmail,
        subject: `Global Integrated Support - Booking Confirmation #${booking.bookingNumber}`,
        html: getBookingConfirmationEmail({
          fullName: recipientName,
          email: recipientEmail,
          phone: recipientPhone,
          address: resolvedAddress.line1 ? `${resolvedAddress.line1}, ${resolvedAddress.city || ''} ${resolvedAddress.state || ''}` : resolvedAddress.freeText,
          vehicleName: `${vehicleMake} ${vehicleModel} (${vehicleYear})`.trim() || 'Vehicle',
          make: vehicleMake,
          vehicleModel,
          year: String(vehicleYear),
          vehicleCategory: pricingResult.vehicleCategory,
          serviceType: pricingResult.service.name,
          date: input.date,
          timeSlot: formatSlotTo12h(slot24),
          totalPrice: Number((pricingResult.pricing.totalCents / 100).toFixed(2)),
          basePrice: Number((pricingResult.pricing.baseCents / 100).toFixed(2)),
          discount: Number((pricingResult.pricing.discountCents / 100).toFixed(2)),
          coupons: pricingResult.pricing.couponCode || 'None',
          addons: pricingResult.addons.map((a) => ({
            name: a.name,
            price: Number((a.priceCents / 100).toFixed(2)),
          })),
          guestAccessLink,
        }),
      }).catch((emailErr) => {
        logger.error({ err: emailErr }, 'Failed to send customer booking confirmation email');
      });

      sendEmail({
        to: process.env.ADMIN_EMAIL || 'support@globalintegratedsupport.com',
        subject: `New Booking #${booking.bookingNumber} - Global Integrated Support`,
        html: getAdminNotificationEmail({
          fullName: recipientName,
          phone: recipientPhone,
          email: recipientEmail,
          address: resolvedAddress.line1 ? `${resolvedAddress.line1}, ${resolvedAddress.city || ''} ${resolvedAddress.state || ''}` : resolvedAddress.freeText,
          vehicleName: `${vehicleMake} ${vehicleModel} (${vehicleYear})`.trim() || 'Vehicle',
          make: vehicleMake,
          vehicleModel,
          year: String(vehicleYear),
          vehicleCategory: pricingResult.vehicleCategory,
          serviceType: pricingResult.service.name,
          date: input.date,
          timeSlot: formatSlotTo12h(slot24),
          totalPrice: Number((pricingResult.pricing.totalCents / 100).toFixed(2)),
          addons: pricingResult.addons.map((a) => ({
            name: a.name,
            price: Number((a.priceCents / 100).toFixed(2)),
          })),
        }),
      }).catch((adminEmailErr) => {
        logger.error({ err: adminEmailErr }, 'Failed to send admin booking notification email');
      });
    }

    // 10. Link existing guest bookings if user is verified
    if (authUser && authUser.emailVerified) {
      Booking.updateMany(
        { customerId: null, 'guest.email': authUser.email.toLowerCase() },
        { $set: { customerId: new mongoose.Types.ObjectId(authUser.userId) } }
      ).catch((linkErr) => {
        logger.error({ err: linkErr }, 'Failed to link guest bookings on create');
      });
    }

    if (guestAccessToken) {
      (booking as any).guestAccessToken = guestAccessToken;
    }

    return booking;
  }

  /**
   * Retrieves paginated bookings for the authenticated customer.
   */
  static async getMine(
    userId: string,
    query: { page?: number; limit?: number; status?: string }
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter: any = { customerId: userId, deletedAt: null };
    if (query.status) {
      filter.status = query.status;
    }

    const [bookings, total] = await Promise.all([
      Booking.find(filter).sort({ scheduledAt: -1 }).skip(skip).limit(limit),
      Booking.countDocuments(filter),
    ]);

    return {
      data: bookings,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Retrieves a booking by ID with ownership, token, or admin check.
   */
  static async getById(
    bookingId: string,
    authUser?: { userId: string; email: string; role: string },
    guestToken?: string
  ) {
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null });
    if (!booking) {
      const err = new Error('Booking not found') as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    const isPrivileged = authUser && (authUser.role === 'admin' || authUser.role === 'dispatcher');
    const isCustomerOwner =
      Boolean(authUser && booking.customerId && booking.customerId.toString() === authUser.userId);

    let isGuestTokenValid = false;
    if (guestToken && booking.guestAccessTokenHash) {
      const hashed = crypto.createHash('sha256').update(guestToken.trim()).digest('hex');
      isGuestTokenValid = hashed === booking.guestAccessTokenHash;
    }

    if (!isPrivileged && !isCustomerOwner && !isGuestTokenValid) {
      const err = new Error('Forbidden: You do not have permission to access this booking') as any;
      err.statusCode = 403;
      err.code = 'FORBIDDEN';
      throw err;
    }

    return booking;
  }

  /**
   * Cancels a booking, checks cancellation window, and releases the slot reservation.
   */
  static async cancelBooking(
    bookingId: string,
    authUser?: { userId: string; email: string; role: string },
    reason?: string,
    guestToken?: string
  ) {
    const booking = await this.getById(bookingId, authUser, guestToken);
    const isPrivileged = authUser && (authUser.role === 'admin' || authUser.role === 'dispatcher');

    const bookingSettings = await AvailabilityService.getBookingSettings();
    if (!isPrivileged) {
      const hoursBefore = (booking.scheduledAt.getTime() - Date.now()) / (3600 * 1000);
      if (hoursBefore < bookingSettings.cancellation.freeCancelHours) {
        logger.info(
          { bookingId, hoursBefore, fee: bookingSettings.cancellation.lateFeePercent },
          'Late cancellation policy applies'
        );
      }
    }

    if (!isValidTransition(booking.status, 'cancelled')) {
      const err = new Error(
        `Cannot cancel booking with current status '${booking.status}'`
      ) as any;
      err.statusCode = 400;
      err.code = 'INVALID_TRANSITION';
      throw err;
    }

    booking.status = 'cancelled';
    booking.statusHistory.push({
      status: 'cancelled',
      by: authUser ? authUser.email : (booking.guest?.email || 'guest'),
      at: new Date(),
      note: reason || 'Cancelled by customer',
    });

    await booking.save();

    // Release technician activeSchedule slot if assigned
    const assignedTech = booking.assignment?.technicianUserId || booking.technicianId;
    if (assignedTech) {
      await TechnicianProfile.updateOne(
        { userId: assignedTech },
        { $pull: { activeSchedule: { bookingId: booking._id } } }
      );
    }

    // Release slot reservation
    await AvailabilityService.releaseSlotAtomic(
      booking.scheduledLocal.date,
      booking.scheduledLocal.slot,
      booking.categoryId
    );

    // Process automatic refund on cancellation of a paid booking
    try {
      const hoursBefore = (booking.scheduledAt.getTime() - Date.now()) / (3600 * 1000);
      const isLate = !isPrivileged && hoursBefore < bookingSettings.cancellation.freeCancelHours;
      await PaymentService.cancelAndRefundIfPaid(
        booking._id.toString(),
        authUser ? authUser.email : (booking.guest?.email || 'guest'),
        {
          isLate,
          lateFeePercent: isLate ? bookingSettings.cancellation.lateFeePercent : 0,
        }
      );
    } catch (refundErr) {
      logger.error({ err: refundErr, bookingId: booking._id }, 'Error processing cancellation refund');
    }

    // Send cancellation email
    const recipientEmail = booking.guest?.email || authUser?.email;
    if (recipientEmail) {
      sendEmail({
        to: recipientEmail,
        subject: `Booking Cancelled #${booking.bookingNumber}`,
        html: getStatusUpdateEmail({
          fullName: booking.guest?.fullName || 'Customer',
          bookingNumber: booking.bookingNumber,
          serviceName: booking.serviceSnapshot.name,
          status: 'cancelled',
          scheduledLocal: booking.scheduledLocal,
          note: reason,
        }),
      }).catch((e) => logger.error({ err: e }, 'Failed to send cancellation email'));
    }

    return booking;
  }

  /**
   * Reschedules a booking, atomically re-reserving the slot.
   * If the booking has an assigned technician, checks availability at the new time.
   * Admin/dispatcher may pass unassignTechnician=true to force-unassign instead of 409.
   */
  static async rescheduleBooking(
    bookingId: string,
    authUser: { userId: string; email: string; role: string } | undefined,
    input: { date: string; slot: string; reason?: string; unassignTechnician?: boolean },
    guestToken?: string
  ) {
    const booking = await this.getById(bookingId, authUser, guestToken);
    const settings = await AvailabilityService.getBookingSettings();
    const newSlot24 = normalizeSlotTo24h(input.slot);
    let bufferMinutes = 30;
    let timezone = settings.businessTimezone || 'America/New_York';
    try {
      const dispatchSettings = await DispatchSettings.getSettings();
      bufferMinutes = dispatchSettings.scheduleBufferMinutes ?? 30;
    } catch {
      // DispatchSettings unavailable — use default buffer
    }
    try {
      timezone = (booking as unknown as { timezone?: string }).timezone || settings.businessTimezone || 'America/New_York';
    } catch {
      // use default
    }

    const newScheduledAt = localToUtc(input.date, newSlot24, settings.businessTimezone);

    // If booking has an assigned technician, check for conflicts at the new time
    const assignedTechId = booking.assignment?.technicianUserId || booking.technicianId;
    if (assignedTechId) {
      const techProfile = await TechnicianProfile.findOne({ userId: assignedTechId }).lean();
      if (techProfile) {
        let serviceDurationMinutes = 60;
        if (booking.serviceId) {
          const sDoc = await Service.findById(booking.serviceId).lean();
          if (sDoc && (sDoc as { durationMinutes?: number }).durationMinutes) {
            serviceDurationMinutes = (sDoc as { durationMinutes?: number }).durationMinutes!;
          }
        }
        const newStart = newScheduledAt;
        const newEnd = new Date(newStart.getTime() + (serviceDurationMinutes + bufferMinutes) * 60 * 1000);

        const conflictCheck = checkTechnicianAvailabilityConflict(
          techProfile,
          newStart,
          newEnd,
          serviceDurationMinutes,
          timezone,
          booking._id.toString()
        );

        if (conflictCheck.hasConflict) {
          const isAdminOrDispatcher = authUser && ['admin', 'dispatcher'].includes(authUser.role);
          if (isAdminOrDispatcher && input.unassignTechnician) {
            // Unassign the technician and return booking to dispatch queue
            const prevTech = assignedTechId.toString();
            booking.status = 'confirmed';
            booking.technicianId = null;
            booking.set('assignment', undefined);
            booking.dispatch = booking.dispatch || { status: 'none', attempts: 0 };
            booking.dispatch.status = 'none';
            booking.statusHistory.push({
              status: 'confirmed',
              by: authUser!.email,
              at: new Date(),
              note: `Technician unassigned due to reschedule conflict. ${conflictCheck.reason || ''}`.trim(),
            });
            // Release the old slot from the technician's profile (will be re-added after save)
            await TechnicianProfile.updateOne(
              { userId: new mongoose.Types.ObjectId(prevTech) },
              { $pull: { activeSchedule: { bookingId: booking._id } } }
            );
          } else {
            throw createHttpError(
              conflictCheck.reason || 'Technician has a schedule conflict at the new time',
              409,
              'SCHEDULE_CONFLICT'
            );
          }
        }
      }
    }

    // 1. Reserve new slot atomically
    await AvailabilityService.reserveSlotAtomic(
      input.date,
      newSlot24,
      booking.categoryId,
      settings.slotCapacity
    );

    // 2. Release old slot
    await AvailabilityService.releaseSlotAtomic(
      booking.scheduledLocal.date,
      booking.scheduledLocal.slot,
      booking.categoryId
    );

    const oldDate = booking.scheduledLocal.date;
    const oldSlot = booking.scheduledLocal.slot;

    // 3. Update scheduling fields
    booking.scheduledLocal = { date: input.date, slot: newSlot24 };
    booking.scheduledAt = newScheduledAt;
    booking.statusHistory.push({
      status: booking.status,
      by: authUser ? authUser.email : (booking.guest?.email || 'guest'),
      at: new Date(),
      note: `Rescheduled from ${oldDate} ${oldSlot} to ${input.date} ${newSlot24}. ${input.reason || ''}`.trim(),
    });

    await booking.save();

    // Update technician activeSchedule slot times if booking is still assigned
    const stillAssignedTech = booking.assignment?.technicianUserId || booking.technicianId;
    if (stillAssignedTech) {
      let serviceDurationMinutes = 60;
      if (booking.serviceId) {
        const sDoc = await Service.findById(booking.serviceId).lean();
        if (sDoc && (sDoc as { durationMinutes?: number }).durationMinutes) {
          serviceDurationMinutes = (sDoc as { durationMinutes?: number }).durationMinutes!;
        }
      }
      const newStart = booking.scheduledAt;
      const newEnd = new Date(newStart.getTime() + (serviceDurationMinutes + bufferMinutes) * 60 * 1000);

      await TechnicianProfile.updateOne(
        { userId: stillAssignedTech },
        { $pull: { activeSchedule: { bookingId: booking._id } } }
      );
      await TechnicianProfile.updateOne(
        { userId: stillAssignedTech },
        { $push: { activeSchedule: { bookingId: booking._id, start: newStart, end: newEnd, createdAt: new Date() } } }
      );
    }

    // Send update email
    const recipientEmail = booking.guest?.email || authUser?.email;
    if (recipientEmail) {
      sendEmail({
        to: recipientEmail,
        subject: `Booking Rescheduled #${booking.bookingNumber}`,
        html: getStatusUpdateEmail({
          fullName: booking.guest?.fullName || 'Customer',
          bookingNumber: booking.bookingNumber,
          serviceName: booking.serviceSnapshot.name,
          status: booking.status,
          scheduledLocal: booking.scheduledLocal,
          note: `Appointment rescheduled to ${input.date} at ${formatSlotTo12h(newSlot24)}`,
        }),
      }).catch((e) => logger.error({ err: e }, 'Failed to send reschedule email'));
    }

    return booking;
  }

  /**
   * Admin / Dispatcher: List bookings with filters, search, pagination, and CSV export.
   */
  static async adminList(query: {
    status?: string;
    startDate?: string;
    endDate?: string;
    categoryId?: string;
    search?: string;
    page?: number;
    limit?: number;
    format?: string;
  }) {
    const filter: any = { deletedAt: null };

    if (query.status) {
      filter.status = query.status;
    }

    if (query.categoryId && mongoose.isValidObjectId(query.categoryId)) {
      filter.categoryId = query.categoryId;
    }

    if (query.startDate || query.endDate) {
      filter.scheduledAt = {};
      if (query.startDate) filter.scheduledAt.$gte = new Date(query.startDate);
      if (query.endDate) filter.scheduledAt.$lte = new Date(query.endDate);
    }

    if (query.search) {
      const searchRegex = new RegExp(query.search.trim(), 'i');
      filter.$or = [
        { bookingNumber: searchRegex },
        { 'guest.fullName': searchRegex },
        { 'guest.email': searchRegex },
        { 'guest.phone': searchRegex },
        { 'vehicleSnapshot.make': searchRegex },
        { 'vehicleSnapshot.model': searchRegex },
      ];
    }

    // CSV Export
    if (query.format === 'csv') {
      const allBookings = await Booking.find(filter).sort({ scheduledAt: -1 });
      const csvRows = [
        'Booking Number,Date,Time Slot,Customer Name,Customer Email,Customer Phone,Service,Category,Vehicle,Status,Total USD',
      ];

      for (const b of allBookings) {
        const name = `"${b.guest?.fullName || ''}"`;
        const email = `"${b.guest?.email || ''}"`;
        const phone = `"${b.guest?.phone || ''}"`;
        const service = `"${b.serviceSnapshot.name}"`;
        const category = `"${b.vehicleSnapshot.category}"`;
        const vehicle = `"${b.vehicleSnapshot.year} ${b.vehicleSnapshot.make} ${b.vehicleSnapshot.model}"`;
        const total = (b.pricing.totalCents / 100).toFixed(2);
        csvRows.push(
          `${b.bookingNumber},${b.scheduledLocal.date},${b.scheduledLocal.slot},${name},${email},${phone},${service},${category},${vehicle},${b.status},${total}`
        );
      }

      return {
        isCsv: true,
        csv: csvRows.join('\n'),
      };
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const [bookings, total] = await Promise.all([
      Booking.find(filter).sort({ scheduledAt: -1 }).skip(skip).limit(limit),
      Booking.countDocuments(filter),
    ]);

    return {
      isCsv: false,
      data: bookings,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Admin / Dispatcher: State machine transition update.
   */
  static async adminUpdateStatus(
    bookingId: string,
    authUser: { email: string },
    input: { status: BookingStatus; note?: string }
  ) {
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null });
    if (!booking) {
      const err = new Error('Booking not found') as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (!isValidTransition(booking.status, input.status)) {
      const err = new Error(
        `Invalid status transition from '${booking.status}' to '${input.status}'`
      ) as any;
      err.statusCode = 400;
      err.code = 'INVALID_STATUS_TRANSITION';
      throw err;
    }

    const previousStatus = booking.status;
    booking.status = input.status;
    booking.statusHistory.push({
      status: input.status,
      by: authUser.email,
      at: new Date(),
      note: input.note || `Status changed from ${previousStatus} to ${input.status}`,
    });

    // If transitioned to cancelled, release slot
    if (input.status === 'cancelled') {
      await AvailabilityService.releaseSlotAtomic(
        booking.scheduledLocal.date,
        booking.scheduledLocal.slot,
        booking.categoryId
      );
    }

    // If transitioned to confirmed, trigger automated dispatch if autoDispatch is enabled
    if (input.status === 'confirmed') {
      try {
        const dispatchSettings = await DispatchSettings.getSettings();
        if (dispatchSettings.autoDispatch) {
          DispatchService.startDispatch(booking._id, `adminUpdateStatus:${authUser.email}`).catch((err) =>
            logger.error({ err }, 'Failed auto-dispatch on booking confirmation')
          );
        }
      } catch (dispErr) {
        logger.error({ err: dispErr }, 'Error checking dispatch settings');
      }
    }

    await booking.save();

    // Release technician activeSchedule slot if transitioned to terminal
    const assignedTech = booking.assignment?.technicianUserId || booking.technicianId;
    if (assignedTech && ['completed', 'cancelled', 'no_show', 'refunded'].includes(input.status)) {
      await TechnicianProfile.updateOne(
        { userId: assignedTech },
        { $pull: { activeSchedule: { bookingId: booking._id } } }
      );
    }

    // Trigger status change emails for confirmed, cancelled, completed
    if (['confirmed', 'cancelled', 'completed'].includes(input.status)) {
      const recipientEmail = booking.guest?.email;
      if (recipientEmail) {
        sendEmail({
          to: recipientEmail,
          subject: `Booking Update #${booking.bookingNumber} - ${input.status.toUpperCase()}`,
          html: getStatusUpdateEmail({
            fullName: booking.guest?.fullName || 'Customer',
            bookingNumber: booking.bookingNumber,
            serviceName: booking.serviceSnapshot.name,
            status: input.status,
            scheduledLocal: booking.scheduledLocal,
            note: input.note,
          }),
        }).catch((e) => logger.error({ err: e }, 'Failed to send admin status update email'));
      }
    }

    return booking;
  }

  /**
   * Admin / Dispatcher: Update booking notes, address, or assigned technician.
   */
  static async adminUpdate(
    bookingId: string,
    authUser: { email: string },
    input: { notes?: string; address?: any; technicianId?: string | null }
  ) {
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null });
    if (!booking) {
      const err = new Error('Booking not found') as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (input.notes !== undefined) booking.notes = input.notes;
    if (input.address !== undefined) Object.assign(booking.address, input.address);
    if (input.technicianId !== undefined) {
      booking.technicianId = input.technicianId
        ? new mongoose.Types.ObjectId(input.technicianId)
        : null;
    }

    booking.statusHistory.push({
      status: booking.status,
      by: authUser.email,
      at: new Date(),
      note: 'Booking details updated by admin',
    });

    await booking.save();
    return booking;
  }

  /**
   * Admin: Delete booking (soft by default, hard if requested).
   */
  static async adminDelete(bookingId: string, hardDelete = false) {
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      const err = new Error('Booking not found') as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Release slot if booking was still active
    if (!['cancelled', 'completed', 'refunded'].includes(booking.status)) {
      await AvailabilityService.releaseSlotAtomic(
        booking.scheduledLocal.date,
        booking.scheduledLocal.slot,
        booking.categoryId
      );
    }

    if (hardDelete) {
      await Booking.findByIdAndDelete(bookingId);
      logger.info({ bookingId }, 'Booking hard-deleted');
    } else {
      booking.deletedAt = new Date();
      await booking.save();
      logger.info({ bookingId }, 'Booking soft-deleted');
    }

    // Release technician activeSchedule slot if assigned
    const assignedTech = booking.assignment?.technicianUserId || booking.technicianId;
    if (assignedTech) {
      await TechnicianProfile.updateOne(
        { userId: assignedTech },
        { $pull: { activeSchedule: { bookingId: booking._id } } }
      );
    }

    return true;
  }
}
