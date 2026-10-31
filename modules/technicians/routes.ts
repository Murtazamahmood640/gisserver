import { PayoutController } from '../payouts/controller';
import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { TechnicianController, documentUploadMiddleware } from './controller';
import { authenticateToken, requireRoles, requireVerified } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { registerLimiter, techApplyLimiter, signedUrlLimiter } from '../../middleware/rateLimiter';
import {
  registerTechnicianSchema,
  updateProfileSchema,
  updateSkillsSchema,
  updateServiceAreaSchema,
  updateAvailabilitySchema,
  adminRejectSchema,
  adminSuspendSchema,
  adminPatchSchema,
  docApproveSchema,
  docRejectSchema,
} from './schema';

import { updateLocationSchema } from '../tracking/schemas';
import { TrackingController } from '../tracking/controller';

const router = Router();

/**
 * Middleware to authenticate requests using CRON_SECRET bearer token.
 * Rejects everything with 401 when CRON_SECRET is unset.
 * Uses crypto.timingSafeEqual for constant-time comparison.
 */
export function cronSecretMiddleware(req: Request, res: Response, next: NextFunction): void {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (!cronSecret || !cronSecret.trim() || !token) {
    res.status(401).json({
      success: false,
      message: 'Unauthorized: Invalid or missing cron secret',
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid cron secret',
      },
    });
    return;
  }

  const secretBuf = Buffer.from(cronSecret);
  const tokenBuf = Buffer.from(token);

  if (secretBuf.length !== tokenBuf.length || !crypto.timingSafeEqual(secretBuf, tokenBuf)) {
    res.status(401).json({
      success: false,
      message: 'Unauthorized: Invalid or missing cron secret',
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid cron secret',
      },
    });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Public / Applicant Endpoints
// ---------------------------------------------------------------------------
router.post(
  '/register',
  registerLimiter,
  validateBody(registerTechnicianSchema),
  TechnicianController.register
);

router.post(
  '/apply',
  techApplyLimiter,
  authenticateToken,
  requireVerified,
  requireRoles('customer'),
  TechnicianController.apply
);

// ---------------------------------------------------------------------------
// Technician Self Management (/me)
// ---------------------------------------------------------------------------
router.get('/me', authenticateToken, requireRoles('technician'), TechnicianController.getMe);
router.get('/me/earnings', authenticateToken, requireRoles('technician'), PayoutController.getEarnings);
router.put(
  '/me',
  authenticateToken,
  requireRoles('technician'),
  validateBody(updateProfileSchema),
  TechnicianController.updateMe
);
router.put(
  '/me/skills',
  authenticateToken,
  requireRoles('technician'),
  validateBody(updateSkillsSchema),
  TechnicianController.updateSkills
);
router.put(
  '/me/service-area',
  authenticateToken,
  requireRoles('technician'),
  validateBody(updateServiceAreaSchema),
  TechnicianController.updateServiceArea
);
router.put(
  '/me/availability',
  authenticateToken,
  requireRoles('technician'),
  validateBody(updateAvailabilitySchema),
  TechnicianController.updateAvailability
);
router.post('/me/online', authenticateToken, requireRoles('technician'), TechnicianController.setOnline);
router.post('/me/submit', authenticateToken, requireRoles('technician'), TechnicianController.submit);
router.post(
  '/me/location',
  authenticateToken,
  requireRoles('technician'),
  validateBody(updateLocationSchema),
  TrackingController.updateLocation
);
router.post(
  '/me/documents',
  authenticateToken,
  requireRoles('technician'),
  documentUploadMiddleware,
  TechnicianController.uploadDocument
);
router.delete(
  '/me/documents/:docId',
  authenticateToken,
  requireRoles('technician'),
  TechnicianController.deleteDocument
);
router.get(
  '/me/documents/:docId/url',
  signedUrlLimiter,
  authenticateToken,
  requireRoles('technician'),
  TechnicianController.getMyDocumentUrl
);

// ---------------------------------------------------------------------------
// Cron Trigger Endpoint
// ---------------------------------------------------------------------------
router.post('/cron/document-expiry-check', cronSecretMiddleware, TechnicianController.runExpiryCheck);

// ---------------------------------------------------------------------------
// Admin & Dispatcher Endpoints
// ---------------------------------------------------------------------------
router.get(
  '/',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  TechnicianController.listTechnicians
);
router.get(
  '/:id',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  TechnicianController.getTechnician
);
router.get(
  '/:id/documents/:docId/url',
  signedUrlLimiter,
  authenticateToken,
  requireRoles('admin'),
  TechnicianController.getAdminDocumentUrl
);
router.post('/:id/approve', authenticateToken, requireRoles('admin'), TechnicianController.approve);
router.post(
  '/:id/reject',
  authenticateToken,
  requireRoles('admin'),
  validateBody(adminRejectSchema),
  TechnicianController.reject
);
router.post(
  '/:id/suspend',
  authenticateToken,
  requireRoles('admin'),
  validateBody(adminSuspendSchema),
  TechnicianController.suspend
);
router.post(
  '/:id/reinstate',
  authenticateToken,
  requireRoles('admin'),
  TechnicianController.reinstate
);
router.patch(
  '/:id',
  authenticateToken,
  requireRoles('admin'),
  validateBody(adminPatchSchema),
  TechnicianController.adminPatch
);
router.post(
  '/:id/documents/:docId/approve',
  authenticateToken,
  requireRoles('admin'),
  validateBody(docApproveSchema),
  TechnicianController.approveDocument
);
router.post(
  '/:id/documents/:docId/reject',
  authenticateToken,
  requireRoles('admin'),
  validateBody(docRejectSchema),
  TechnicianController.rejectDocument
);
router.get(
  '/:id/jobs',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  TechnicianController.getTechnicianJobs
);

export default router;
