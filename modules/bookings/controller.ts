import { Request, Response } from 'express';
import { BookingService } from './service';
import { AvailabilityService } from './availability';
import { BookingSettings } from '../../models/BookingSettings';
import { calculateBookingPricing } from './pricing';
import { TechnicianProfile } from '../../models/TechnicianProfile';

export function sanitizeBookingForGuest(booking: any) {
  const b = typeof booking.toObject === 'function' ? booking.toObject() : { ...booking };
  delete b.guestAccessTokenHash;
  delete b.legacyAppointmentId;
  delete b.deletedAt;
  if (b.pricing) {
    const {
      commissionPercent,
      processingPercent,
      commissionCents,
      processingCents,
      providerPayoutCents,
      ...publicPricing
    } = b.pricing;
    b.pricing = publicPricing;
  }
  return b;
}

export class BookingController {
  /**
   * Public / Authenticated: Check slot availability.
   */
  static async getAvailability(req: Request, res: Response) {
    const { date, serviceId, categoryId } = req.query as {
      date: string;
      serviceId?: string;
      categoryId?: string;
    };

    if (!date) {
      return res.status(400).json({
        success: false,
        error: { code: 'DATE_REQUIRED', message: 'Date parameter (YYYY-MM-DD) is required' },
      });
    }

    const availability = await AvailabilityService.getAvailability({
      date,
      serviceId,
      categoryId,
    });

    return res.status(200).json({
      success: true,
      data: availability,
    });
  }

  /**
   * Public: Calculate server pricing quote without creating a booking.
   */
  static async getQuote(req: Request, res: Response) {
    const { serviceId, vehicleCategory, addonIds, couponCode } = req.body;
    const pricingResult = await calculateBookingPricing({
      serviceId,
      vehicleCategory,
      addonIds,
      couponCode,
    });

    return res.status(200).json({
      success: true,
      data: {
        pricing: {
          baseCents: pricingResult.pricing.baseCents,
          addonsCents: pricingResult.pricing.addonsCents,
          discountCents: pricingResult.pricing.discountCents,
          couponCode: pricingResult.pricing.couponCode,
          couponPercent: pricingResult.pricing.couponPercent,
          taxCents: pricingResult.pricing.taxCents,
          totalCents: pricingResult.pricing.totalCents,
        },
        service: {
          id: pricingResult.service._id,
          name: pricingResult.service.name,
          slug: pricingResult.service.slug,
          durationMinutes: pricingResult.service.durationMinutes,
        },
        category: {
          id: pricingResult.category._id,
          name: pricingResult.category.name,
          slug: pricingResult.category.slug,
        },
        vehicleCategory: pricingResult.vehicleCategory,
        addons: pricingResult.addons.map((a) => ({
          id: a.addonId,
          name: a.name,
          priceCents: a.priceCents,
        })),
        display: {
          basePrice: (pricingResult.pricing.baseCents / 100).toFixed(2),
          addonsPrice: (pricingResult.pricing.addonsCents / 100).toFixed(2),
          discount: (pricingResult.pricing.discountCents / 100).toFixed(2),
          total: (pricingResult.pricing.totalCents / 100).toFixed(2),
          currency: 'USD',
        },
      },
    });
  }

  /**
   * Public (Guest) or Authenticated Customer: Create booking.
   */
  static async create(req: Request, res: Response) {
    const booking = await BookingService.createBooking(req.body, req.user);
    return res.status(201).json({
      success: true,
      data: booking,
    });
  }

  /**
   * Authenticated Customer: List my bookings.
   */
  static async getMine(req: Request, res: Response) {
    const result = await BookingService.getMine(req.user!.userId, req.query);
    return res.status(200).json({
      success: true,
      ...result,
    });
  }

  /**
   * Owner or Admin: Get single booking (guests use X-Booking-Token header or ?token=).
   */
  static async getById(req: Request, res: Response) {
    const { id } = req.params;
    const guestToken =
      (req.headers['x-booking-token'] as string) || (req.query.token as string);
    const booking = await BookingService.getById(id, req.user, guestToken);
    const isPrivileged = req.user && (req.user.role === 'admin' || req.user.role === 'dispatcher');
    const responseData = isPrivileged
      ? (typeof (booking as any).toObject === 'function' ? (booking as any).toObject() : { ...booking })
      : sanitizeBookingForGuest(booking);

    // Attach technician card once assigned: displayName, photoUrl, rating, vehicle type only (no phone or email)
    const assignedTechUserId = booking.assignment?.technicianUserId || booking.technicianId;
    if (assignedTechUserId) {
      const techProfile = await TechnicianProfile.findOne({ userId: assignedTechUserId }).lean();
      if (techProfile) {
        responseData.technician = {
          displayName: techProfile.displayName || 'Certified Technician',
          photoUrl: techProfile.photoUrl || null,
          rating: techProfile.rating?.avg ?? 5.0,
          vehicleType: techProfile.vehicleInfo?.type || 'Van',
        };
      }
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  }

  /**
   * Owner or Admin: Cancel booking (guests use X-Booking-Token header or ?token=).
   */
  static async cancel(req: Request, res: Response) {
    const { id } = req.params;
    const guestToken =
      (req.headers['x-booking-token'] as string) || (req.query.token as string);
    const booking = await BookingService.cancelBooking(id, req.user, req.body.reason, guestToken);
    return res.status(200).json({
      success: true,
      message: 'Booking cancelled successfully',
      data: booking,
    });
  }

  /**
   * Owner or Admin: Reschedule booking (guests use X-Booking-Token header or ?token=).
   */
  static async reschedule(req: Request, res: Response) {
    const { id } = req.params;
    const guestToken =
      (req.headers['x-booking-token'] as string) || (req.query.token as string);
    const booking = await BookingService.rescheduleBooking(id, req.user, req.body, guestToken);
    return res.status(200).json({
      success: true,
      message: 'Booking rescheduled successfully',
      data: booking,
    });
  }

  /**
   * Admin / Dispatcher: List all bookings.
   */
  static async adminList(req: Request, res: Response) {
    const result = await BookingService.adminList(req.query as any);
    if (result.isCsv) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="bookings.csv"');
      return res.status(200).send(result.csv);
    }

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
    });
  }

  /**
   * Admin / Dispatcher: State machine status transition.
   */
  static async adminUpdateStatus(req: Request, res: Response) {
    const { id } = req.params;
    const booking = await BookingService.adminUpdateStatus(id, req.user!, req.body);
    return res.status(200).json({
      success: true,
      message: 'Booking status updated successfully',
      data: booking,
    });
  }

  /**
   * Admin / Dispatcher: Edit notes, address, or technician.
   */
  static async adminUpdate(req: Request, res: Response) {
    const { id } = req.params;
    const booking = await BookingService.adminUpdate(id, req.user!, req.body);
    return res.status(200).json({
      success: true,
      message: 'Booking updated successfully',
      data: booking,
    });
  }

  /**
   * Admin-only: Delete booking.
   */
  static async adminDelete(req: Request, res: Response) {
    const { id } = req.params;
    const hard = req.query.hard === 'true';
    await BookingService.adminDelete(id, hard);
    return res.status(200).json({
      success: true,
      message: hard ? 'Booking permanently deleted' : 'Booking archived successfully',
    });
  }

  /**
   * Admin / Dispatcher: Get booking settings.
   */
  static async adminGetSettings(_req: Request, res: Response) {
    const settings = await AvailabilityService.getBookingSettings();
    return res.status(200).json({
      success: true,
      data: settings,
    });
  }

  /**
   * Admin-only: Update booking settings.
   */
  static async adminUpdateSettings(req: Request, res: Response) {
    let settings = await BookingSettings.findOne();
    if (!settings) {
      settings = new BookingSettings(req.body);
    } else {
      Object.assign(settings, req.body);
    }
    await settings.save();
    return res.status(200).json({
      success: true,
      message: 'Booking settings updated successfully',
      data: settings,
    });
  }
}
