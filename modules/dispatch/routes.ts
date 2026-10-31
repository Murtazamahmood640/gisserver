import { Router } from 'express';
import { authenticateToken, requireRoles, requireAdminRole } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { cronSecretMiddleware } from '../technicians/routes';
import { DispatchController } from './controller';
import { assignBookingSchema, updateDispatchSettingsSchema } from './schemas';

export const dispatchRouter = Router();

// Candidates list with explainability
dispatchRouter.get(
  '/bookings/:id/candidates',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  DispatchController.getCandidates
);

// Offers history for a booking
dispatchRouter.get(
  '/bookings/:id/offers',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  DispatchController.getOffers
);

// Manual dispatch actions
dispatchRouter.post(
  '/bookings/:id/assign',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  validateBody(assignBookingSchema),
  DispatchController.assign
);

dispatchRouter.post(
  '/bookings/:id/reassign',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  validateBody(assignBookingSchema),
  DispatchController.reassign
);

dispatchRouter.post(
  '/bookings/:id/unassign',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  DispatchController.unassign
);

dispatchRouter.post(
  '/bookings/:id/redispatch',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  DispatchController.redispatch
);

// Dispatch operations board
dispatchRouter.get(
  '/board',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  DispatchController.getBoard
);

// Serverless / external cron sweep endpoint protected by CRON_SECRET
dispatchRouter.post(
  '/cron/sweep',
  cronSecretMiddleware,
  DispatchController.cronSweep
);

// ---------------------------------------------------------------------------
// Dispatch Settings Router (/api/v1/admin/dispatch-settings)
// ---------------------------------------------------------------------------
export const dispatchSettingsRouter = Router();

dispatchSettingsRouter.get(
  '/',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  DispatchController.getSettings
);

dispatchSettingsRouter.put(
  '/',
  authenticateToken,
  requireAdminRole,
  validateBody(updateDispatchSettingsSchema),
  DispatchController.updateSettings
);
