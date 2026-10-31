import logger from '../config/logger';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import mongoose from 'mongoose';
import { connectDB } from '../config/database';
import { Appointment } from '../models/Appointment';
import { Booking, BookingStatus } from '../models/Booking';
import { Service } from '../models/Service';
import { BookingService } from '../modules/bookings/service';
import { AvailabilityService, formatSlotTo12h } from '../modules/bookings/availability';

/**
 * Normalizes vehicle category string to supported slug enum.
 */
function mapVehicleCategoryToSlug(category: string): string | null {
  const clean = category.toLowerCase().trim();
  if (clean === 'sedan' || clean === 'car') return 'sedan';
  if (clean === 'crossover') return 'crossover';
  if (clean === 'suv') return 'suv';
  if (clean === 'truck') return 'truck';
  if (
    clean === 'rv-boat-semi' ||
    clean === 'rv/boat/semi' ||
    clean.includes('boat') ||
    clean.includes('semi') ||
    clean.includes('rv')
  ) {
    return 'rv-boat-semi';
  }
  return null;
}

/**
 * Maps modern booking document to legacy appointment shape in dollars.
 */
function mapBookingToLegacyShape(booking: any) {
  const statusMap: Record<string, string> = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    assigned: 'Confirmed',
    technician_en_route: 'Confirmed',
    arrived: 'Confirmed',
    in_progress: 'Confirmed',
    completed: 'Completed',
    cancelled: 'Cancelled',
    no_show: 'Cancelled',
    refunded: 'Cancelled',
  };

  const formattedCategory =
    booking.vehicleSnapshot.category === 'rv-boat-semi'
      ? 'RV/Boat/Semi'
      : booking.vehicleSnapshot.category === 'crossover'
      ? 'CrossOver'
      : booking.vehicleSnapshot.category.charAt(0).toUpperCase() +
        booking.vehicleSnapshot.category.slice(1);

  return {
    _id: booking.legacyAppointmentId || booking._id,
    id: (booking.legacyAppointmentId || booking._id).toString(),
    bookingId: booking._id.toString(),
    bookingNumber: booking.bookingNumber,
    fullName: booking.guest?.fullName || '',
    phone: booking.guest?.phone || '',
    email: booking.guest?.email || '',
    address: booking.address?.line1
      ? `${booking.address.line1}, ${booking.address.city || ''} ${booking.address.state || ''}`.trim()
      : booking.address?.freeText || '',
    vehicleName: `${booking.vehicleSnapshot?.make || ''} ${booking.vehicleSnapshot?.model || ''}`.trim(),
    make: booking.vehicleSnapshot?.make || '',
    vehicleModel: booking.vehicleSnapshot?.model || '',
    year: String(booking.vehicleSnapshot?.year || ''),
    serviceType: booking.serviceSnapshot?.name || '',
    vehicleCategory: formattedCategory,
    date: booking.scheduledLocal.date,
    timeSlot: formatSlotTo12h(booking.scheduledLocal.slot),
    promoCode: booking.pricing.couponCode || '',
    coupons: booking.pricing.couponCode
      ? [
          {
            code: booking.pricing.couponCode,
            discountPercentage: booking.pricing.couponPercent,
            discountAmount: Number((booking.pricing.discountCents / 100).toFixed(2)),
          },
        ]
      : [],
    addons: (booking.addons || []).map((a: any) => ({
      name: a.name,
      price: Number((a.priceCents / 100).toFixed(2)),
    })),
    basePrice: Number((booking.pricing.baseCents / 100).toFixed(2)),
    totalDiscount: Number((booking.pricing.discountCents / 100).toFixed(2)),
    discountApplied: booking.pricing.discountCents > 0,
    totalPrice: Number((booking.pricing.totalCents / 100).toFixed(2)),
    status: statusMap[booking.status] || 'Pending',
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await connectDB();

  try {
    if (req.method === 'GET') {
      // 1. List bookings mapped to legacy appointments
      const bookings = await Booking.find({ deletedAt: null }).sort({ createdAt: -1 });
      const legacyAppointments = bookings.map(mapBookingToLegacyShape);

      return res.status(200).json({
        success: true,
        data: legacyAppointments,
      });
    } else if (req.method === 'POST') {
      const appointmentData = req.body;

      if (!appointmentData.fullName || !appointmentData.email) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: fullName and email are required',
        });
      }

      // 1. Map serviceType display name to Service
      const serviceTypeInput = appointmentData.serviceType?.trim();
      if (!serviceTypeInput) {
        return res.status(400).json({
          success: false,
          message: 'Service type is required',
        });
      }

      const normalizedServiceInput = serviceTypeInput.toLowerCase().trim();
      const activeServices = await Service.find({ isActive: true });
      const service = activeServices.find(
        (s) =>
          s.name.toLowerCase().trim() === normalizedServiceInput ||
          s.slug.toLowerCase().trim() === normalizedServiceInput
      );

      if (!service) {
        return res.status(400).json({
          success: false,
          message: `Unknown service name '${serviceTypeInput}'. Please select a valid service.`,
        });
      }

      // 2. Map vehicleCategory to slug enum
      const rawCategory = appointmentData.vehicleCategory || appointmentData.vehicleType || 'Sedan';
      const vehicleCategorySlug = mapVehicleCategoryToSlug(rawCategory);

      if (!vehicleCategorySlug) {
        return res.status(400).json({
          success: false,
          message: `Unknown vehicle category '${rawCategory}'. Supported categories: Sedan, CrossOver, SUV, Truck, RV/Boat/Semi.`,
        });
      }

      // 3. Extract coupon
      let couponCode: string | null = null;
      if (appointmentData.coupons && Array.isArray(appointmentData.coupons) && appointmentData.coupons.length > 0) {
        couponCode = appointmentData.coupons[0]?.code;
      } else if (appointmentData.promoCode) {
        couponCode = appointmentData.promoCode;
      }

      // 4. Extract addon names
      const addonNames: string[] = [];
      if (Array.isArray(appointmentData.addons)) {
        for (const a of appointmentData.addons) {
          if (typeof a === 'string') addonNames.push(a);
          else if (a && a.name) addonNames.push(a.name);
        }
      }

      // 5. Create legacy Appointment record first for backwards compatibility
      const legacyAppointment = new Appointment({
        fullName: appointmentData.fullName,
        phone: appointmentData.phone,
        email: appointmentData.email.toLowerCase(),
        address: appointmentData.address,
        make: appointmentData.make || 'Unknown',
        vehicleModel: appointmentData.vehicleModel || 'Unknown',
        year: String(appointmentData.year || new Date().getFullYear()),
        serviceType: service.name,
        vehicleCategory: rawCategory,
        date: appointmentData.date,
        timeSlot: appointmentData.timeSlot,
        promoCode: couponCode || '',
        coupons: appointmentData.coupons || [],
        addons: appointmentData.addons || [],
        basePrice: appointmentData.basePrice || 0,
        totalDiscount: appointmentData.totalDiscount || 0,
        totalPrice: appointmentData.totalPrice || 0,
        status: 'Pending',
      });
      await legacyAppointment.save();

      // 6. Delegate to unified BookingService with server-side price calculation
      try {
        const booking = await BookingService.createBooking({
          serviceId: service._id.toString(),
          vehicleCategory: vehicleCategorySlug,
          vehicleMake: appointmentData.make,
          vehicleModel: appointmentData.vehicleModel,
          vehicleYear: Number(appointmentData.year) || new Date().getFullYear(),
          addonIds: addonNames,
          couponCode,
          date: appointmentData.date,
          slot: appointmentData.timeSlot,
          address: { freeText: appointmentData.address, country: 'USA' },
          guest: {
            fullName: appointmentData.fullName,
            email: appointmentData.email.toLowerCase(),
            phone: appointmentData.phone,
          },
          source: 'web',
          legacyAppointmentId: legacyAppointment._id,
        });

        // Update legacy appointment with exact server totals
        legacyAppointment.basePrice = Number((booking.pricing.baseCents / 100).toFixed(2));
        legacyAppointment.totalDiscount = Number((booking.pricing.discountCents / 100).toFixed(2));
        legacyAppointment.totalPrice = Number((booking.pricing.totalCents / 100).toFixed(2));
        legacyAppointment.discountApplied = booking.pricing.discountCents > 0;
        await legacyAppointment.save();

        const responsePayload = mapBookingToLegacyShape(booking);

        return res.status(201).json({
          success: true,
          message: 'Appointment created successfully',
          data: responsePayload,
        });
      } catch (bookingErr: any) {
        // Rollback the created legacy appointment if booking creation failed
        await Appointment.findByIdAndDelete(legacyAppointment._id);
        logger.error({ err: bookingErr }, 'Booking adapter creation failed');
        return res.status(bookingErr.statusCode || 500).json({
          success: false,
          message: bookingErr.message || 'Failed to create appointment',
        });
      }
    } else if (req.method === 'PUT') {
      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Invalid appointment ID',
        });
      }

      // Try finding booking by legacyAppointmentId or by _id
      let booking = null;
      if (mongoose.isValidObjectId(id)) {
        booking = await Booking.findOne({
          $or: [{ legacyAppointmentId: id }, { _id: id }],
          deletedAt: null,
        });
      }

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Appointment not found',
        });
      }

      // Map status from legacy to modern
      if (req.body.status) {
        const rawStatus = req.body.status.toLowerCase();
        const mappedStatus: BookingStatus =
          rawStatus === 'confirmed'
            ? 'confirmed'
            : rawStatus === 'completed'
            ? 'completed'
            : rawStatus === 'cancelled'
            ? 'cancelled'
            : 'pending';

        booking.status = mappedStatus;
        booking.statusHistory.push({
          status: mappedStatus,
          by: (req as any).user?.email || 'admin',
          at: new Date(),
          note: 'Status updated via legacy appointments tab',
        });
      }

      if (req.body.address) {
        booking.address.freeText = req.body.address;
      }

      await booking.save();

      // Also update legacy appointment model if present
      if (booking.legacyAppointmentId) {
        await Appointment.findByIdAndUpdate(booking.legacyAppointmentId, {
          status: req.body.status || 'Pending',
          address: req.body.address,
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Appointment updated successfully',
        data: mapBookingToLegacyShape(booking),
      });
    } else if (req.method === 'DELETE') {
      const { id } = req.query;
      const hard = req.query.hard === 'true';

      if (!id || typeof id !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Invalid appointment ID',
        });
      }

      let booking = null;
      if (mongoose.isValidObjectId(id)) {
        booking = await Booking.findOne({
          $or: [{ legacyAppointmentId: id }, { _id: id }],
        });
      }

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Appointment not found',
        });
      }

      // Release slot reservation if booking was active
      if (!['cancelled', 'completed', 'refunded'].includes(booking.status)) {
        await AvailabilityService.releaseSlotAtomic(
          booking.scheduledLocal.date,
          booking.scheduledLocal.slot,
          booking.categoryId
        );
      }

      if (hard) {
        await Booking.findByIdAndDelete(booking._id);
        if (booking.legacyAppointmentId) {
          await Appointment.findByIdAndDelete(booking.legacyAppointmentId);
        }
      } else {
        booking.deletedAt = new Date();
        await booking.save();
      }

      return res.status(200).json({
        success: true,
        message: 'Appointment deleted successfully',
      });
    } else {
      return res.status(405).json({
        success: false,
        message: 'Method not allowed',
      });
    }
  } catch (error: any) {
    logger.error({ err: error }, 'Appointments legacy adapter error');
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    });
  }
}
