import { Router } from 'express';
import { AdminController } from './controller';
import { authenticateToken, requireRoles } from '../../middleware/auth';

const router = Router();

// Fast badge counts & overview analytics
router.get(
  '/counts',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  AdminController.getCounts
);

router.get(
  '/overview',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  AdminController.getOverview
);

export default router;

