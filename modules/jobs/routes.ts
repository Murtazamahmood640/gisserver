import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken, requireRoles } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { TechnicianProfile } from '../../models/TechnicianProfile';
import { JobsController } from './controller';
import { declineOfferSchema } from '../dispatch/schemas';
import { completeJobSchema, releaseJobSchema } from './schemas';

export const jobsRouter = Router();

/**
 * Middleware ensuring technician profile is approved and active before handling job lifecycle.
 */
export async function requireApprovedTechnician(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || req.user.role !== 'technician') {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Forbidden: Technician role required' },
      });
      return;
    }

    const profile = await TechnicianProfile.findOne({ userId: req.user.userId }).lean();
    if (!profile || profile.verificationStatus !== 'approved') {
      res.status(403).json({
        success: false,
        error: {
          code: 'TECHNICIAN_NOT_APPROVED',
          message: 'Forbidden: Technician profile must be approved to access job operations',
        },
      });
      return;
    }
    next();
  } catch (_err: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to verify technician status' },
    });
  }
}

// All /jobs routes require an authenticated, approved technician
jobsRouter.use(authenticateToken, requireRoles('technician'), requireApprovedTechnician);

// Offer response endpoints
jobsRouter.post('/offers/:offerId/accept', JobsController.acceptOffer);
jobsRouter.post(
  '/offers/:offerId/decline',
  validateBody(declineOfferSchema),
  JobsController.declineOffer
);

// Job listing and details
jobsRouter.get('/config', JobsController.getConfig);
jobsRouter.get('/', JobsController.getMyJobs);
jobsRouter.get('/:bookingId', JobsController.getJobDetail);

// State transitions
jobsRouter.post('/:bookingId/en-route', JobsController.enRoute);
jobsRouter.post('/:bookingId/arrived', JobsController.arrived);
jobsRouter.post('/:bookingId/start', JobsController.start);
jobsRouter.post('/:bookingId/complete', validateBody(completeJobSchema), JobsController.complete);
jobsRouter.post('/:bookingId/release', validateBody(releaseJobSchema), JobsController.release);
