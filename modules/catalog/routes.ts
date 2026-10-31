import { Router } from 'express';
import { CatalogController } from './controller';
import { authenticateToken, requireAdminRole } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { couponValidateLimiter } from '../../middleware/rateLimiter';
import {
  createCategorySchema,
  updateCategorySchema,
  createServiceSchema,
  updateServiceSchema,
  createAddonSchema,
  updateAddonSchema,
  validateCouponSchema,
} from './schema';

const router = Router();

// ---------------------------------------------------------------------------
// Public Catalog Endpoints
// ---------------------------------------------------------------------------
router.get('/categories', CatalogController.getCategories);
router.get('/services', CatalogController.getServices);
router.get('/addons', CatalogController.getAddons);
router.post(
  '/coupons/validate',
  couponValidateLimiter,
  validateBody(validateCouponSchema),
  CatalogController.validateCoupon
);
router.get('/price-lookup', CatalogController.getPriceLookup);

// ---------------------------------------------------------------------------
// Admin Category Endpoints
// ---------------------------------------------------------------------------
router.get(
  '/admin/categories',
  authenticateToken,
  requireAdminRole,
  CatalogController.adminGetCategories
);
router.post(
  '/admin/categories',
  authenticateToken,
  requireAdminRole,
  validateBody(createCategorySchema),
  CatalogController.adminCreateCategory
);
router.put(
  '/admin/categories/:id',
  authenticateToken,
  requireAdminRole,
  validateBody(updateCategorySchema),
  CatalogController.adminUpdateCategory
);
router.delete(
  '/admin/categories/:id',
  authenticateToken,
  requireAdminRole,
  CatalogController.adminDeleteCategory
);

// ---------------------------------------------------------------------------
// Admin Service Endpoints
// ---------------------------------------------------------------------------
router.get(
  '/admin/services',
  authenticateToken,
  requireAdminRole,
  CatalogController.adminGetServices
);
router.post(
  '/admin/services',
  authenticateToken,
  requireAdminRole,
  validateBody(createServiceSchema),
  CatalogController.adminCreateService
);
router.put(
  '/admin/services/:id',
  authenticateToken,
  requireAdminRole,
  validateBody(updateServiceSchema),
  CatalogController.adminUpdateService
);
router.delete(
  '/admin/services/:id',
  authenticateToken,
  requireAdminRole,
  CatalogController.adminDeleteService
);

// ---------------------------------------------------------------------------
// Admin Addon Endpoints
// ---------------------------------------------------------------------------
router.get(
  '/admin/addons',
  authenticateToken,
  requireAdminRole,
  CatalogController.adminGetAddons
);
router.post(
  '/admin/addons',
  authenticateToken,
  requireAdminRole,
  validateBody(createAddonSchema),
  CatalogController.adminCreateAddon
);
router.put(
  '/admin/addons/:id',
  authenticateToken,
  requireAdminRole,
  validateBody(updateAddonSchema),
  CatalogController.adminUpdateAddon
);
router.delete(
  '/admin/addons/:id',
  authenticateToken,
  requireAdminRole,
  CatalogController.adminDeleteAddon
);

export default router;
