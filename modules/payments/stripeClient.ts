import Stripe from 'stripe';
import logger from '../../config/logger';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      const err = Object.assign(new Error('Payment processing is not configured'), {
        statusCode: 503,
        code: 'PAYMENTS_NOT_CONFIGURED',
      });
      throw err;
    }
    _stripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' as Stripe.LatestApiVersion, typescript: true });
  }
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

export function _resetStripeClient(): void {
  _stripe = null;
}
