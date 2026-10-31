import { Router } from 'express';
import {
  authenticateToken,
  optionalAuthenticateToken,
  requireAdminRole,
} from '../../middleware/auth';
import { bookingLookupLimiter } from '../../middleware/rateLimiter';
import { PaymentController } from './controller';

export const paymentsRouter = Router();

paymentsRouter.post(
  '/bookings/:id/checkout',
  optionalAuthenticateToken,
  bookingLookupLimiter,
  PaymentController.createCheckout
);

paymentsRouter.get(
  '/bookings/:id',
  optionalAuthenticateToken,
  bookingLookupLimiter,
  PaymentController.getPaymentStatus
);

paymentsRouter.post(
  '/bookings/:id/refund',
  authenticateToken,
  requireAdminRole,
  PaymentController.refundPayment
);

paymentsRouter.post(
  '/bookings/:id/offline',
  authenticateToken,
  requireAdminRole,
  PaymentController.recordOfflinePayment
);
