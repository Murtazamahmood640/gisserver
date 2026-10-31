import { Router } from 'express';
import { authenticateToken, requireAdminRole } from '../../middleware/auth';
import { PayoutController } from './controller';

export const payoutsAdminRouter = Router();

// All payout management endpoints are strictly admin-only (dispatchers get 403)
payoutsAdminRouter.use(authenticateToken, requireAdminRole);

payoutsAdminRouter.get('/balances', PayoutController.getBalances);
payoutsAdminRouter.post('/', PayoutController.createPayout);
payoutsAdminRouter.get('/', PayoutController.listPayouts);
payoutsAdminRouter.get('/:id', PayoutController.getPayoutById);
payoutsAdminRouter.post('/:id/mark-paid', PayoutController.markPaid);
payoutsAdminRouter.post('/:id/void', PayoutController.voidPayout);
payoutsAdminRouter.get('/:id/export.csv', PayoutController.exportCsv);
