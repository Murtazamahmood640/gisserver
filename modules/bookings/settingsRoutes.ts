import { Router } from 'express';
import { BookingController } from './controller';
import { authenticateToken, requireRoles, requireAdminRole } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { updateBookingSettingsSchema } from './schema';

const router = Router();

router.use(authenticateToken);

router.get(
  '/',
  requireRoles('admin', 'dispatcher'),
  BookingController.adminGetSettings
);

router.put(
  '/',
  requireAdminRole,
  validateBody(updateBookingSettingsSchema),
  BookingController.adminUpdateSettings
);

export default router;
