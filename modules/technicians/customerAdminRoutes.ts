import { Router } from 'express';
import { TechnicianController } from './controller';
import { authenticateToken, requireRoles } from '../../middleware/auth';

const router = Router();

router.get(
  '/',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  TechnicianController.listCustomers
);

router.post(
  '/:id/suspend',
  authenticateToken,
  requireRoles('admin'),
  TechnicianController.suspendCustomer
);

router.post(
  '/:id/reinstate',
  authenticateToken,
  requireRoles('admin'),
  TechnicianController.reinstateCustomer
);

export default router;
