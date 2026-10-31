import { Router, Request, Response, NextFunction } from 'express';
import {
  authenticateToken,
  requireRoles,
  requireAdminRole,
} from '../../middleware/auth';
import { PaymentController } from './controller';

export const paymentsAdminRouter = Router();

function cronOrAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (cronSecret && token && cronSecret === token) {
    return next();
  }

  authenticateToken(req, res, () => {
    requireAdminRole(req, res, next);
  });
}

// GET /api/v1/admin/payments
paymentsAdminRouter.get(
  '/payments',
  authenticateToken,
  requireAdminRole,
  PaymentController.listPayments
);

// GET /api/v1/admin/payment-settings
paymentsAdminRouter.get(
  '/payment-settings',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  PaymentController.getSettings
);

// PUT /api/v1/admin/payment-settings
paymentsAdminRouter.put(
  '/payment-settings',
  authenticateToken,
  requireAdminRole,
  PaymentController.updateSettings
);

// POST /api/v1/admin/cron/sweep-payments
paymentsAdminRouter.post(
  '/cron/sweep-payments',
  cronOrAdminMiddleware,
  PaymentController.cronSweep
);
