import { Router } from 'express';
import { SupplierController, supplierDocumentUploadMiddleware } from './controller';
import { authenticateToken, requireRoles, requireVerified } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { registerLimiter, techApplyLimiter, signedUrlLimiter } from '../../middleware/rateLimiter';
import {
  registerSupplierSchema,
  applySupplierSchema,
  updateSupplierProfileSchema,
  adminRejectSupplierSchema,
  adminSuspendSupplierSchema,
  adminReviewDocumentSchema,
  adminRejectDocumentSchema,
} from './schema';

const router = Router();

// ---------------------------------------------------------------------------
// Public Registration
// ---------------------------------------------------------------------------
router.post(
  '/register',
  registerLimiter,
  validateBody(registerSupplierSchema),
  SupplierController.register
);

// ---------------------------------------------------------------------------
// Customer -> Supplier Conversion
// ---------------------------------------------------------------------------
router.post(
  '/apply',
  techApplyLimiter,
  authenticateToken,
  requireVerified,
  requireRoles('customer'),
  validateBody(applySupplierSchema),
  SupplierController.apply
);

// ---------------------------------------------------------------------------
// Supplier Self Management (/me)
// ---------------------------------------------------------------------------
router.get('/me', authenticateToken, requireRoles('supplier'), SupplierController.getMe);
router.put(
  '/me',
  authenticateToken,
  requireRoles('supplier'),
  validateBody(updateSupplierProfileSchema),
  SupplierController.updateMe
);
router.post('/me/submit', authenticateToken, requireRoles('supplier'), SupplierController.submit);
router.post(
  '/me/documents',
  authenticateToken,
  requireRoles('supplier'),
  supplierDocumentUploadMiddleware,
  SupplierController.uploadDocument
);
router.delete(
  '/me/documents/:docId',
  authenticateToken,
  requireRoles('supplier'),
  SupplierController.deleteDocument
);
router.get(
  '/me/documents/:docId/url',
  signedUrlLimiter,
  authenticateToken,
  requireRoles('supplier'),
  SupplierController.getDocumentSignedUrl
);

// ---------------------------------------------------------------------------
// Admin & Operations Management
// ---------------------------------------------------------------------------
router.get('/', authenticateToken, requireRoles('admin', 'dispatcher'), SupplierController.listSuppliers);
router.get('/:id', authenticateToken, requireRoles('admin', 'dispatcher'), SupplierController.getSupplier);
router.post('/:id/approve', authenticateToken, requireRoles('admin'), SupplierController.approve);
router.post(
  '/:id/reject',
  authenticateToken,
  requireRoles('admin'),
  validateBody(adminRejectSupplierSchema),
  SupplierController.reject
);
router.post(
  '/:id/suspend',
  authenticateToken,
  requireRoles('admin'),
  validateBody(adminSuspendSupplierSchema),
  SupplierController.suspend
);
router.post('/:id/reinstate', authenticateToken, requireRoles('admin'), SupplierController.reinstate);
router.post(
  '/:id/documents/:docId/approve',
  authenticateToken,
  requireRoles('admin'),
  validateBody(adminReviewDocumentSchema),
  SupplierController.approveDocument
);
router.post(
  '/:id/documents/:docId/reject',
  authenticateToken,
  requireRoles('admin'),
  validateBody(adminRejectDocumentSchema),
  SupplierController.rejectDocument
);
router.get(
  '/:id/documents/:docId/url',
  signedUrlLimiter,
  authenticateToken,
  requireRoles('admin'),
  SupplierController.getAdminDocumentUrl
);

export default router;
