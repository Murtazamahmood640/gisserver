import { Router } from 'express';
import { PricingController } from './controller';
import { authenticateToken, requireAdminRole } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import {
  createPriceSchema,
  updatePriceSchema,
  createCommissionRuleSchema,
  updateCommissionRuleSchema,
} from './schema';

const router = Router();

// ---------------------------------------------------------------------------
// Public Pricing Endpoints
// ---------------------------------------------------------------------------
router.get('/lookup', PricingController.lookupPrice);
router.get('/services/:serviceId/prices', PricingController.getServicePrices);

// ---------------------------------------------------------------------------
// Admin Pricing Endpoints
// ---------------------------------------------------------------------------
router.get(
  '/admin/prices',
  authenticateToken,
  requireAdminRole,
  PricingController.adminGetAllPrices
);
router.post(
  '/admin/prices',
  authenticateToken,
  requireAdminRole,
  validateBody(createPriceSchema),
  PricingController.adminUpsertPrice
);
router.put(
  '/admin/prices/:id',
  authenticateToken,
  requireAdminRole,
  validateBody(updatePriceSchema),
  PricingController.adminUpdatePrice
);
router.delete(
  '/admin/prices/:id',
  authenticateToken,
  requireAdminRole,
  PricingController.adminDeletePrice
);

// ---------------------------------------------------------------------------
// Admin Commission Rules Endpoints
// ---------------------------------------------------------------------------
router.get(
  '/admin/commission-rules',
  authenticateToken,
  requireAdminRole,
  PricingController.adminGetCommissionRules
);
router.post(
  '/admin/commission-rules',
  authenticateToken,
  requireAdminRole,
  validateBody(createCommissionRuleSchema),
  PricingController.adminCreateCommissionRule
);
router.put(
  '/admin/commission-rules/:id',
  authenticateToken,
  requireAdminRole,
  validateBody(updateCommissionRuleSchema),
  PricingController.adminUpdateCommissionRule
);
router.delete(
  '/admin/commission-rules/:id',
  authenticateToken,
  requireAdminRole,
  PricingController.adminDeleteCommissionRule
);

export default router;
