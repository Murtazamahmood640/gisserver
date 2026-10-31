import { Payout } from '../../models/Payout';
import { PayoutAdjustment } from '../../models/PayoutAdjustment';
import { computeEarningCents } from '../payouts/earningsService';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { Booking } from '../../models/Booking';
import { Payment, PaymentStatus } from '../../models/Payment';
import { StripeEvent } from '../../models/StripeEvent';
import { PaymentSettings } from '../../models/PaymentSettings';
import { getStripe, isStripeConfigured } from './stripeClient';
import { DispatchService } from '../dispatch/service';
import { sendEmail } from '../../services/emailService';
import logger from '../../config/logger';

export interface CancellationPolicyOptions {
  isLate?: boolean;
  lateFeePercent?: number;
}

export class PaymentService {
  /**
   * Creates a new Stripe Checkout session or reuses an existing pending session.
   */
  static async createOrReuseCheckout(
    bookingId: string,
    actorId?: string,
    actorRole?: string,
    guestEmail?: string
  ): Promise<{ url: string }> {
    const booking = await Booking.findOne({
      _id: bookingId,
      deletedAt: null,
      isDeleted: { $ne: true },
    });

    if (!booking) {
      throw Object.assign(new Error('Booking not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }

    if (booking.status === 'cancelled') {
      throw Object.assign(new Error('Cannot pay for a cancelled booking'), {
        statusCode: 400,
        code: 'BOOKING_CANCELLED',
      });
    }

    if (booking.paymentStatus === 'paid') {
      throw Object.assign(new Error('Booking is already paid'), {
        statusCode: 409,
        code: 'ALREADY_PAID',
      });
    }

    const totalCents = booking.pricing?.totalCents;
    if (!totalCents || totalCents <= 0) {
      throw Object.assign(new Error('Booking total amount must be greater than zero'), {
        statusCode: 400,
        code: 'INVALID_AMOUNT',
      });
    }

    const stripe = getStripe();

    // Check for open existing payment session
    const existingPayment = await Payment.findOne({
      bookingId: booking._id,
      status: 'pending',
      stripeCheckoutSessionId: { $exists: true, $ne: '' },
    }).sort({ createdAt: -1 });

    if (existingPayment?.stripeCheckoutSessionId) {
      try {
        const session = await stripe.checkout.sessions.retrieve(
          existingPayment.stripeCheckoutSessionId
        );
        if (session && session.status === 'open' && session.url) {
          return { url: session.url };
        }
      } catch (err) {
        // If retrieving session fails, proceed to create a fresh one
      }
    }

    const frontendUrl =
      process.env.FRONTEND_URL?.split(',')[0].trim().replace(/\/$/, '') ||
      'https://globalintegratedsupport.com';

    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60; // 30 minutes

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: booking.serviceSnapshot?.name || 'GIS Service',
              description: `Booking #${booking.bookingNumber}`,
            },
            unit_amount: totalCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookingId: booking._id.toString(),
      },
      customer_email: guestEmail || booking.guest?.email,
      success_url: `${frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/payment/cancelled`,
      expires_at: expiresAt,
    });

    if (!session.url) {
      throw Object.assign(new Error('Failed to generate checkout URL'), {
        statusCode: 500,
        code: 'CHECKOUT_SESSION_FAILED',
      });
    }

    await Payment.create({
      bookingId: booking._id,
      ...(booking.customerId ? { customerId: booking.customerId } : {}),
      stripeCheckoutSessionId: session.id,
      amountCents: totalCents,
      currency: 'usd',
      status: 'pending',
      refundedCents: 0,
      history: [
        {
          action: 'checkout_created',
          amountCents: totalCents,
          by: actorRole || 'guest',
          at: new Date(),
        },
      ],
    });

    booking.paymentStatus = 'pending';
    booking.paymentExpiresAt = new Date(expiresAt * 1000);
    await booking.save();

    return { url: session.url };
  }

  /**
   * Handles incoming Stripe webhook events with idempotency and signature validation.
   */
  static async handleWebhookEvent(
    rawBody: Buffer | string,
    signature: string
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw Object.assign(new Error('Payment processing is not configured'), {
        statusCode: 503,
        code: 'PAYMENTS_NOT_CONFIGURED',
      });
    }

    const stripe = getStripe();
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: unknown) {
      const e = err as Error;
      logger.warn({ err: e.message }, 'Stripe webhook signature verification failed');
      throw Object.assign(new Error(`Webhook Error: ${e.message}`), {
        statusCode: 400,
        code: 'INVALID_WEBHOOK_SIGNATURE',
      });
    }

    // Idempotency: insert eventId
    try {
      await StripeEvent.create({
        eventId: event.id,
        type: event.type,
        processedAt: new Date(),
      });
    } catch (err: unknown) {
      const e = err as { code?: number };
      if (e.code === 11000) {
        logger.info({ eventId: event.id, type: event.type }, 'Duplicate Stripe webhook event ignored');
        return { received: true, duplicate: true };
      }
      throw err;
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const payment = await Payment.findOne({ stripeCheckoutSessionId: session.id });
        if (payment) {
          payment.status = 'paid';
          payment.paidAt = new Date();

          const piId =
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id;

          if (piId) {
            payment.stripePaymentIntentId = piId;
            try {
              const pi = await stripe.paymentIntents.retrieve(piId, {
                expand: ['latest_charge.balance_transaction'],
              });
              const charge = pi.latest_charge as Stripe.Charge | undefined;
              const bt = charge?.balance_transaction as Stripe.BalanceTransaction | undefined;
              if (bt) {
                payment.stripeFeeCents = bt.fee;
                payment.stripeNetCents = bt.net;
              }
            } catch (piErr) {
              logger.warn({ err: piErr }, 'Could not retrieve fee/net from balance_transaction');
            }
          }

          payment.history.push({
            action: 'payment_completed',
            amountCents: payment.amountCents,
            by: 'stripe_webhook',
            at: new Date(),
          });
          await payment.save();

          const booking = await Booking.findById(payment.bookingId);
          if (booking) {
            booking.paymentStatus = 'paid';
            booking.paidAt = payment.paidAt;
            booking.statusHistory.push({
              status: booking.status,
              by: 'system',
              at: new Date(),
              note: 'Payment received via Stripe Checkout',
            });

            const settings = await PaymentSettings.getSettings();
            if (settings.autoConfirmOnPayment && booking.status === 'pending') {
              // Atomically claim the transition from pending -> confirmed to avoid race with manual admin action
              const confirmedBooking = await Booking.findOneAndUpdate(
                { _id: booking._id, status: 'pending' },
                {
                  $set: {
                    paymentStatus: 'paid',
                    paidAt: payment.paidAt,
                    status: 'confirmed',
                  },
                  $push: {
                    statusHistory: {
                      $each: [
                        {
                          status: 'pending',
                          by: 'system',
                          at: new Date(),
                          note: 'Payment received via Stripe Checkout',
                        },
                        {
                          status: 'confirmed',
                          by: 'system',
                          at: new Date(),
                          note: 'Auto-confirmed on successful payment',
                        },
                      ],
                    },
                  },
                },
                { new: true }
              );

              if (confirmedBooking) {
                try {
                  await DispatchService.startDispatch(booking._id.toString());
                } catch (dispatchErr) {
                  logger.error(
                    { err: dispatchErr, bookingId: booking._id },
                    'Failed to start dispatch on payment confirmation'
                  );
                }
              } else {
                await Booking.findByIdAndUpdate(booking._id, {
                  $set: { paymentStatus: 'paid', paidAt: payment.paidAt },
                  $push: {
                    statusHistory: {
                      status: booking.status,
                      by: 'system',
                      at: new Date(),
                      note: 'Payment received via Stripe Checkout',
                    },
                  },
                });
              }
            } else {
              await booking.save();
            }

            let recipientEmail = booking.guest?.email;
            if (!recipientEmail && booking.customerId) {
              const u = await Booking.db.model('User').findById(booking.customerId).select('email');
              recipientEmail = u?.email;
            }

            if (recipientEmail) {
              sendEmail({
                to: recipientEmail,
                subject: `Payment Receipt for Booking #${booking.bookingNumber}`,
                html: `<p>Thank you! Your payment of $${(payment.amountCents / 100).toFixed(
                  2
                )} for Booking #${booking.bookingNumber} has been received.</p>`,
              }).catch((e) => logger.error({ err: e }, 'Failed to send receipt email'));
            }
          }
        }
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        const payment = await Payment.findOne({ stripeCheckoutSessionId: session.id });
        if (payment) {
          payment.status = 'expired';
          payment.history.push({
            action: 'checkout_expired',
            amountCents: payment.amountCents,
            by: 'stripe_webhook',
            at: new Date(),
          });
          await payment.save();

          const booking = await Booking.findById(payment.bookingId);
          if (booking) {
            const settings = await PaymentSettings.getSettings();
            booking.paymentStatus = settings.requirePrepayment ? 'failed' : 'unpaid';
            await booking.save();
          }
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const payment = await Payment.findOne({
          $or: [{ stripePaymentIntentId: pi.id }, { stripeCheckoutSessionId: pi.id }],
        });
        if (payment) {
          payment.status = 'failed';
          payment.history.push({
            action: 'payment_failed',
            amountCents: payment.amountCents,
            by: 'stripe_webhook',
            at: new Date(),
            note: pi.last_payment_error?.message,
          });
          await payment.save();

          const booking = await Booking.findById(payment.bookingId);
          if (booking) {
            booking.paymentStatus = 'failed';
            await booking.save();
          }
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const piId =
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id;

        const payment = await Payment.findOne({
          $or: [
            ...(piId ? [{ stripePaymentIntentId: piId }] : []),
          ],
        });

        if (payment) {
          payment.refundedCents = charge.amount_refunded;
          payment.status =
            payment.refundedCents >= payment.amountCents ? 'refunded' : 'partially_refunded';
          payment.history.push({
            action: 'charge_refunded',
            amountCents: charge.amount_refunded,
            by: 'stripe_webhook',
            at: new Date(),
          });
          await payment.save();

          const booking = await Booking.findById(payment.bookingId);
          if (booking) {
            booking.paymentStatus = payment.status;
            await booking.save();
          }
        }
        break;
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        const paymentIntentId = typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : dispute.payment_intent?.id;
        const payment = await Payment.findOne({
          $or: [
            ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
            { status: { $in: ['paid', 'partially_refunded', 'refunded'] } },
          ],
        }).sort({ createdAt: -1 });

        if (payment) {
          payment.history.push({
            action: 'dispute_created',
            amountCents: dispute.amount,
            by: 'stripe_webhook',
            at: new Date(),
            note: dispute.reason,
          });
          await payment.save();
        }

        const adminEmail =
          process.env.ADMIN_EMAIL || process.env.STACKMAIL_USER || 'admin@globalintegratedsupport.com';
        sendEmail({
          to: adminEmail,
          subject: `Payment Dispute Created: ${dispute.id}`,
          html: `<p>A dispute was opened for $${(dispute.amount / 100).toFixed(2)}. Reason: ${
            dispute.reason
          }</p>`,
        }).catch((e) => logger.error({ err: e }, 'Failed to send dispute email to admin'));
        break;
      }

      default:
        break;
    }

    return { received: true };
  }

  /**
   * Processes a refund requested by an admin with idempotency support.
   */
  static async refundBooking(
    bookingId: string,
    adminId: string,
    params: { amountCents?: number; reason: string }
  ) {
    const payment = await Payment.findOne({
      bookingId,
      status: { $in: ['paid', 'partially_refunded'] },
    });

    if (!payment) {
      throw Object.assign(new Error('No paid payment found for this booking'), {
        statusCode: 404,
        code: 'PAYMENT_NOT_FOUND',
      });
    }

    const availableCents = payment.amountCents - payment.refundedCents;
    const targetCents = params.amountCents ?? availableCents;

    if (targetCents <= 0 || targetCents > availableCents) {
      throw Object.assign(
        new Error(`Invalid refund amount. Available to refund: ${availableCents} cents`),
        {
          statusCode: 400,
          code: 'REFUND_EXCEEDS_BALANCE',
        }
      );
    }

    if (payment.source === 'offline') {
      payment.refundedCents += targetCents;
      payment.status =
        payment.refundedCents >= payment.amountCents ? 'refunded' : 'partially_refunded';
      payment.history.push({
        action: 'refund',
        amountCents: targetCents,
        by: adminId,
        at: new Date(),
        note: `Offline refund: ${params.reason}`,
      });
      await payment.save();

      const booking = await Booking.findById(bookingId);
      if (booking) {
        booking.paymentStatus = payment.status;
        booking.statusHistory.push({
          status: booking.status,
          by: adminId,
          at: new Date(),
          note: `Offline refund of $${(targetCents / 100).toFixed(2)}: ${params.reason}`,
        });
        await booking.save();
      }

      await this.syncPayoutAdjustmentOnRefund(bookingId, adminId);
      return {
        refundId: `offline_ref_${Date.now()}`,
        status: 'succeeded',
        amountCents: targetCents,
      };
    }

    const stripe = getStripe();
    const idempotencyKey = `refund-${payment._id}-${Date.now()}`;

    const refund = await stripe.refunds.create(
      {
        payment_intent: payment.stripePaymentIntentId,
        amount: targetCents,
        reason: 'requested_by_customer',
      },
      { idempotencyKey }
    );

    payment.refundedCents += targetCents;
    payment.status =
      payment.refundedCents >= payment.amountCents ? 'refunded' : 'partially_refunded';
    payment.history.push({
      action: 'refund',
      amountCents: targetCents,
      by: adminId,
      at: new Date(),
      note: params.reason,
    });
    await payment.save();

    const booking = await Booking.findById(bookingId);
    if (booking) {
      booking.paymentStatus = payment.status;
      booking.statusHistory.push({
        status: booking.status,
        by: adminId,
        at: new Date(),
        note: `Refund issued: $${(targetCents / 100).toFixed(2)} (${params.reason})`,
      });
      await booking.save();
    }

    return {
      paymentId: payment._id,
      refundId: refund.id,
      refundedCents: targetCents,
      status: payment.status,
    };
  }

  /**
   * Retrieves clean payment details for a booking without exposing keys or sensitive card data.
   */
  static async getPaymentForBooking(bookingId: string) {
    const payment = await Payment.findOne({ bookingId }).sort({ createdAt: -1 });
    if (!payment) {
      return {
        status: 'unpaid',
        amountCents: 0,
        refundedCents: 0,
        paidAt: null,
      };
    }

    return {
      status: payment.status,
      amountCents: payment.amountCents,
      refundedCents: payment.refundedCents,
      paidAt: payment.paidAt || null,
      stripeFeeCents: payment.stripeFeeCents,
      stripeNetCents: payment.stripeNetCents,
    };
  }

  /**
   * Computes and issues refund on booking cancellation based on policy. Never blocks cancellation.
   */
  static async cancelAndRefundIfPaid(
    bookingId: string,
    cancelledBy: string,
    cancellationSettings?: CancellationPolicyOptions
  ) {
    if (!isStripeConfigured()) {
      logger.info({ bookingId }, 'Stripe not configured; skipping automatic refund on cancellation');
      return null;
    }

    const payment = await Payment.findOne({
      bookingId,
      status: { $in: ['paid', 'partially_refunded'] },
    });

    if (!payment) return null;

    const availableCents = payment.amountCents - payment.refundedCents;
    if (availableCents <= 0) return null;

    let refundPercent = 100;
    if (cancellationSettings?.isLate) {
      const lateFeePercent = cancellationSettings.lateFeePercent ?? 0;
      refundPercent = Math.max(0, 100 - lateFeePercent);
    }

    const targetCents = Math.round((payment.amountCents * refundPercent) / 100);
    const refundAmount = Math.min(targetCents, availableCents);

    if (refundAmount <= 0) return null;

    try {
      if (payment.source === 'offline') {
        payment.refundedCents += refundAmount;
        payment.status =
          payment.refundedCents >= payment.amountCents ? 'refunded' : 'partially_refunded';
        payment.history.push({
          action: 'cancellation_refund',
          amountCents: refundAmount,
          by: cancelledBy,
          at: new Date(),
          note: `Automatic offline cancellation refund (${refundPercent}%)`,
        });
        await payment.save();
      } else {
        const stripe = getStripe();
        const idempotencyKey = `cancel-refund-${payment._id}-${Date.now()}`;
        await stripe.refunds.create(
          {
            payment_intent: payment.stripePaymentIntentId,
            amount: refundAmount,
            reason: 'requested_by_customer',
          },
          { idempotencyKey }
        );
      }

      payment.refundedCents += refundAmount;
      payment.status =
        payment.refundedCents >= payment.amountCents ? 'refunded' : 'partially_refunded';
      payment.history.push({
        action: 'cancellation_refund',
        amountCents: refundAmount,
        by: cancelledBy,
        at: new Date(),
        note: `Automatic cancellation refund (${refundPercent}%)`,
      });
      await payment.save();

      await Booking.findByIdAndUpdate(bookingId, {
        $set: { paymentStatus: payment.status },
        $push: {
          statusHistory: {
            status: 'cancelled',
            by: 'system',
            at: new Date(),
            note: `Automatic cancellation refund: ${refundAmount} cents (${payment.status})`,
          },
        },
      });

      await PaymentService.syncPayoutAdjustmentOnRefund(bookingId, cancelledBy);
      return { refundedCents: refundAmount, status: payment.status };
    } catch (refundErr) {
      logger.error({ err: refundErr, bookingId }, 'Failed to issue refund on booking cancellation');
      payment.history.push({
        action: 'refund_failed',
        amountCents: refundAmount,
        by: cancelledBy,
        at: new Date(),
        note: 'Automatic cancellation refund failed — flagged for admin review',
      });
      await payment.save();

      await Booking.findByIdAndUpdate(bookingId, {
        $push: {
          statusHistory: {
            status: 'cancelled',
            by: 'system',
            at: new Date(),
            note: 'REFUND_FAILED_ADMIN_REVIEW_REQUIRED: Cancellation refund failed',
          },
        },
      });

      return null;
    }
  }

  /**
   * Adjusts payouts when a booking is refunded after being claimed in a payout.
   * - If draft payout: automatically voids draft and releases bookings.
   * - If paid payout: creates a PayoutAdjustment for the reduction in earnings (idempotent).
   */
  static async syncPayoutAdjustmentOnRefund(bookingId: string, actorId: string = 'system') {
    try {
      const booking = await Booking.findById(bookingId);
      if (!booking || !booking.payout?.payoutId) {
        return;
      }

      const payout = await Payout.findById(booking.payout.payoutId);
      if (!payout) {
        return;
      }

      if (payout.status === 'draft') {
        payout.status = 'void';
        payout.notes = (payout.notes ? payout.notes + '\n' : '') +
          `Draft payout automatically voided due to refund on booking ${booking.bookingNumber}`;
        payout.history.push({
          action: 'voided_on_refund',
          by: actorId,
          at: new Date(),
          note: `Voided because booking ${booking.bookingNumber} was refunded`,
        });
        await payout.save();

        await Booking.updateMany(
          { _id: { $in: payout.bookingIds } },
          { $unset: { payout: 1 } }
        );
        await PayoutAdjustment.updateMany(
          { settledInPayoutId: payout._id },
          { $unset: { settledInPayoutId: 1 } }
        );
        logger.info({ payoutId: payout._id, bookingId }, 'Draft payout voided due to refund on booking');
        return;
      }

      if (payout.status === 'paid') {
        const payment = await Payment.findOne({ bookingId: booking._id });
        const providerPayoutCents = booking.pricing?.providerPayoutCents ?? 0;
        const newEarning = computeEarningCents({
          status: booking.status,
          pricing: booking.pricing,
          paymentStatus: payment?.status,
          paidCents: payment?.amountCents,
          refundedCents: payment?.refundedCents,
        });

        const targetReduction = newEarning - providerPayoutCents;
        if (targetReduction < 0) {
          const existing = await PayoutAdjustment.find({ bookingId: booking._id });
          const alreadyAdjusted = existing.reduce((sum, a) => sum + a.amountCents, 0);
          const diff = targetReduction - alreadyAdjusted;

          if (diff < 0) {
            await PayoutAdjustment.create({
              technicianUserId: payout.technicianUserId,
              bookingId: booking._id,
              amountCents: diff,
              reason: 'refund_after_payout',
            });
            logger.info(
              { bookingId, technicianUserId: payout.technicianUserId, adjustmentCents: diff },
              'Created payout adjustment for refund after paid payout'
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err, bookingId }, 'Failed to sync payout adjustment on refund');
    }
  }

  /**
   * Records an offline payment (bank, cash, other) for a booking.
   * Admin-only. Amount must equal totalCents. Runs same confirm-and-dispatch logic.
   */
  static async recordOfflinePayment(
    bookingId: string,
    adminId: string,
    params: { method: 'bank' | 'cash' | 'other'; reference: string; amountCents: number }
  ): Promise<{ payment: import('../../models/Payment').IPayment; booking: import('../../models/Booking').IBooking }> {
    const booking = await Booking.findOne({
      _id: bookingId,
      deletedAt: null,
      isDeleted: { $ne: true },
    });

    if (!booking) {
      throw Object.assign(new Error('Booking not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }

    if (booking.status === 'cancelled') {
      throw Object.assign(new Error('Cannot pay for a cancelled booking'), {
        statusCode: 400,
        code: 'BOOKING_CANCELLED',
      });
    }

    if (booking.paymentStatus === 'paid') {
      throw Object.assign(new Error('Booking is already paid'), {
        statusCode: 409,
        code: 'ALREADY_PAID',
      });
    }

    const totalCents = booking.pricing?.totalCents ?? 0;
    if (totalCents <= 0) {
      throw Object.assign(new Error('Booking total amount must be greater than zero'), {
        statusCode: 400,
        code: 'INVALID_AMOUNT',
      });
    }

    if (params.amountCents !== totalCents) {
      throw Object.assign(
        new Error(
          `Offline payment amount ($${(params.amountCents / 100).toFixed(2)}) must exactly match the booking total ($${(totalCents / 100).toFixed(2)})`
        ),
        {
          statusCode: 400,
          code: 'AMOUNT_MISMATCH',
        }
      );
    }

    const now = new Date();
    const payment = await Payment.create({
      bookingId: booking._id,
      customerId: booking.customerId || undefined,
      amountCents: params.amountCents,
      currency: 'usd',
      status: 'paid',
      source: 'offline',
      paidAt: now,
      offline: { method: params.method, reference: params.reference },
      history: [
        {
          action: 'offline_payment_recorded',
          amountCents: params.amountCents,
          by: adminId,
          at: now,
          note: `Method: ${params.method}, Reference: ${params.reference}`,
        },
      ],
    });

    const settings = await PaymentSettings.getSettings();
    if (settings.autoConfirmOnPayment && booking.status === 'pending') {
      const confirmedBooking = await Booking.findOneAndUpdate(
        { _id: booking._id, status: 'pending' },
        {
          $set: {
            paymentStatus: 'paid',
            paidAt: now,
            status: 'confirmed',
          },
          $push: {
            statusHistory: {
              $each: [
                {
                  status: 'pending',
                  by: adminId,
                  at: now,
                  note: `Offline payment recorded: ${params.method.toUpperCase()} #${params.reference}`,
                },
                {
                  status: 'confirmed',
                  by: 'system',
                  at: now,
                  note: 'Auto-confirmed on offline payment',
                },
              ],
            },
          },
        },
        { new: true }
      );

      if (confirmedBooking) {
        try {
          await DispatchService.startDispatch(booking._id.toString());
        } catch (dispatchErr) {
          logger.error(
            { err: dispatchErr, bookingId: booking._id },
            'Failed to start dispatch on offline payment confirmation'
          );
        }
      } else {
        await Booking.findByIdAndUpdate(booking._id, {
          $set: { paymentStatus: 'paid', paidAt: now },
          $push: {
            statusHistory: {
              status: booking.status,
              by: adminId,
              at: now,
              note: `Offline payment recorded: ${params.method.toUpperCase()} #${params.reference}`,
            },
          },
        });
      }
    } else {
      booking.paymentStatus = 'paid';
      booking.paidAt = now;
      booking.statusHistory.push({
        status: booking.status,
        by: adminId,
        at: now,
        note: `Offline payment recorded: ${params.method.toUpperCase()} #${params.reference}`,
      });
      await booking.save();
    }

    logger.info(
      {
        bookingId: booking._id,
        actorId: adminId,
        method: params.method,
        reference: params.reference,
        amountCents: params.amountCents,
      },
      'Offline payment recorded'
    );

    return { payment, booking };
  }

}
