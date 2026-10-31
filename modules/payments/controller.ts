import { Request, Response } from 'express';
import { BookingService } from '../bookings/service';
import { PaymentService } from './service';
import { Payment } from '../../models/Payment';
import { PaymentSettings } from '../../models/PaymentSettings';
import { sweepExpiredPrepayBookings } from './sweeper';
import { refundSchema, updatePaymentSettingsSchema, offlinePaymentSchema } from './schemas';
import { isStripeConfigured } from './stripeClient';
import logger from '../../config/logger';

interface PaymentErrorLike {
  statusCode?: number;
  code?: string;
  message?: string;
  name?: string;
  errors?: unknown;
  stack?: string;
}

export class PaymentController {
  /**
   * POST /payments/bookings/:id/checkout
   * Creates or retrieves a Stripe Checkout Session URL for a booking.
   */
  static async createCheckout(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const guestToken =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);

      const booking = await BookingService.getById(id, req.user, guestToken);

      const result = await PaymentService.createOrReuseCheckout(
        booking._id.toString(),
        req.user?.userId,
        req.user?.role,
        booking.guest?.email
      );

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const error = err as PaymentErrorLike;
      if (error.statusCode === 503 || error.code === 'PAYMENTS_NOT_CONFIGURED') {
        return res.status(503).json({
          success: false,
          error: {
            code: 'PAYMENTS_NOT_CONFIGURED',
            message: 'Payment processing is not configured',
          },
        });
      }
      return res.status(error.statusCode || 500).json({
        success: false,
        error: {
          code: error.code || 'PAYMENT_ERROR',
          message: error.message || 'Payment checkout failed',
        },
      });
    }
  }

  /**
   * GET /payments/bookings/:id
   * Returns current payment status, amounts, and paidAt for a booking.
   */
  static async getPaymentStatus(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const guestToken =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);

      await BookingService.getById(id, req.user, guestToken);
      const data = await PaymentService.getPaymentForBooking(id);

      return res.status(200).json({
        success: true,
        data,
      });
    } catch (err: unknown) {
      const error = err as PaymentErrorLike;
      return res.status(error.statusCode || 500).json({
        success: false,
        error: {
          code: error.code || 'PAYMENT_STATUS_ERROR',
          message: error.message || 'Failed to retrieve payment status',
        },
      });
    }
  }

  /**
   * POST /payments/bookings/:id/refund
   * Admin-only: Issues a full or partial refund for a booking.
   */
  static async refundPayment(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const parsed = refundSchema.parse(req.body);

      const result = await PaymentService.refundBooking(id, req.user!.userId, parsed);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const error = err as PaymentErrorLike;
      logger.error({ err: error?.message || error, stack: error?.stack }, 'Refund controller caught error');
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid refund input',
            details: error.errors,
          },
        });
      }
      return res.status(error.statusCode || 500).json({
        success: false,
        error: {
          code: error.code || 'REFUND_ERROR',
          message: error.message || 'Failed to process refund',
        },
      });
    }
  }

  /**
   * GET /admin/payments
   * Admin-only: Lists payments with filtering by status and date range.
   */
  static async listPayments(req: Request, res: Response) {
    try {
      const { status, from, to } = req.query;
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
      const skip = (page - 1) * limit;

      const filter: Record<string, unknown> = {};
      if (status && typeof status === 'string' && status !== 'all') {
        filter.status = status;
      }
      if (from || to) {
        const dateFilter: Record<string, Date> = {};
        if (from) dateFilter.$gte = new Date(from as string);
        if (to) dateFilter.$lte = new Date(to as string);
        filter.createdAt = dateFilter;
      }

      const [payments, total] = await Promise.all([
        Payment.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate('bookingId', 'bookingNumber guest customerId')
          .lean(),
        Payment.countDocuments(filter),
      ]);

      return res.status(200).json({
        success: true,
        data: {
          items: payments,
          total,
          page,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (err: unknown) {
      const error = err as PaymentErrorLike;
      return res.status(500).json({
        success: false,
        error: {
          code: 'PAYMENTS_LIST_ERROR',
          message: error.message || 'Failed to list payments',
        },
      });
    }
  }

  /**
   * GET /admin/payment-settings
   * Admin & Dispatcher: Retrieves system payment configuration.
   */
  static async getSettings(_req: Request, res: Response) {
    try {
      const settings = await PaymentSettings.getSettings();
      const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
      const stripeMode = stripeKey.startsWith('sk_live_')
        ? 'live'
        : stripeKey.startsWith('sk_test_')
          ? 'test'
          : 'none';
      return res.status(200).json({
        success: true,
        data: {
          ...settings.toObject(),
          isStripeConfigured: isStripeConfigured(),
          stripeMode,
        },
      });
    } catch (err: unknown) {
      const error = err as PaymentErrorLike;
      return res.status(500).json({
        success: false,
        error: {
          code: 'PAYMENT_SETTINGS_ERROR',
          message: error.message || 'Failed to retrieve payment settings',
        },
      });
    }
  }

  /**
   * PUT /admin/payment-settings
   * Admin-only: Updates payment configuration.
   */
  static async updateSettings(req: Request, res: Response) {
    try {
      const parsed = updatePaymentSettingsSchema.parse(req.body);
      const settings = await PaymentSettings.getSettings();
      Object.assign(settings, parsed);
      await settings.save();

      return res.status(200).json({
        success: true,
        data: settings,
      });
    } catch (err: unknown) {
      const error = err as PaymentErrorLike;
      logger.error({ err: error?.message || error, stack: error?.stack }, 'Refund controller caught error');
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid payment settings data',
            details: error.errors,
          },
        });
      }
      return res.status(500).json({
        success: false,
        error: {
          code: 'UPDATE_SETTINGS_ERROR',
          message: error.message || 'Failed to update payment settings',
        },
      });
    }
  }

  /**
   * POST /api/v1/stripe/webhook
   * Handles raw webhook payload from Stripe.
   */
  static async handleWebhook(req: Request, res: Response) {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_SIGNATURE', message: 'Stripe signature header is required' },
      });
    }

    try {
      const result = await PaymentService.handleWebhookEvent(req.body, signature);
      return res.status(200).json(result);
    } catch (err: unknown) {
      const error = err as PaymentErrorLike;
      logger.error({ err: error.message }, 'Stripe webhook processing error');
      return res.status(error.statusCode || 400).json({
        success: false,
        error: { code: error.code || 'WEBHOOK_ERROR', message: error.message },
      });
    }
  }

  /**
   * POST /api/v1/admin/cron/sweep-payments
   * Sweeps expired prepayment bookings.
   */
  static async cronSweep(req: Request, res: Response) {
    try {
      const result = await sweepExpiredPrepayBookings();
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const error = err as PaymentErrorLike;
      return res.status(500).json({
        success: false,
        error: {
          code: 'SWEEP_ERROR',
          message: error.message || 'Failed to sweep prepayments',
        },
      });
    }
  }

  /**
   * POST /payments/bookings/:id/offline
   * Admin-only: Records an offline payment (bank, cash, other) for a booking.
   */
  static async recordOfflinePayment(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const parsed = offlinePaymentSchema.parse(req.body);

      const result = await PaymentService.recordOfflinePayment(
        id,
        req.user!.userId,
        parsed
      );

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const error = err as PaymentErrorLike;
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid offline payment input',
            details: error.errors,
          },
        });
      }
      return res.status(error.statusCode || 500).json({
        success: false,
        error: {
          code: error.code || 'OFFLINE_PAYMENT_ERROR',
          message: error.message || 'Failed to record offline payment',
        },
      });
    }
  }

}
