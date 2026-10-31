import { Router } from 'express';
import { authenticateToken, requireRoles } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { updateLocationSchema } from './schemas';
import { TrackingController } from './controller';

export const trackingRouter = Router();

trackingRouter.post(
  '/me/location',
  authenticateToken,
  requireRoles('technician'),
  validateBody(updateLocationSchema),
  TrackingController.updateLocation
);
