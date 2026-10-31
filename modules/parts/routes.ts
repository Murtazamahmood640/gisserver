import { Router } from 'express';
import { PartsController, partsImageUploadMiddleware } from './controller';
import { authenticateToken, requireRoles } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { partsImageUploadLimiter } from '../../middleware/rateLimiter';
import {
  createProductSchema,
  updateProductSchema,
  adjustStockSchema,
  adminRejectProductSchema,
  adminArchiveProductSchema,
  createPartCategorySchema,
  updatePartCategorySchema,
  createPartOrderSchema,
  updatePartOrderStatusSchema,
} from './schema';

const router = Router();

// ---------------------------------------------------------------------------
// Public: Category listing
// ---------------------------------------------------------------------------
router.get('/categories', PartsController.listCategories);

// ---------------------------------------------------------------------------
// Public: Marketplace
// ---------------------------------------------------------------------------
router.get('/marketplace', PartsController.marketplaceBrowse);
router.get('/marketplace/:id', PartsController.marketplaceGetProduct);

// ---------------------------------------------------------------------------
// Customer: Parts Cart & Order Checkout
// ---------------------------------------------------------------------------
router.post(
  '/orders',
  authenticateToken,
  requireRoles('customer', 'admin'),
  validateBody(createPartOrderSchema),
  PartsController.createOrder
);
router.get(
  '/orders',
  authenticateToken,
  requireRoles('customer', 'admin'),
  PartsController.getCustomerOrders
);
router.get(
  '/orders/:id',
  authenticateToken,
  requireRoles('customer', 'admin'),
  PartsController.getCustomerOrderById
);

// ---------------------------------------------------------------------------
// Admin: Category management
// ---------------------------------------------------------------------------
router.get('/admin/categories', authenticateToken, requireRoles('admin'), PartsController.adminListCategories);
router.post(
  '/admin/categories',
  authenticateToken,
  requireRoles('admin'),
  validateBody(createPartCategorySchema),
  PartsController.adminCreateCategory
);
router.put(
  '/admin/categories/:slug',
  authenticateToken,
  requireRoles('admin'),
  validateBody(updatePartCategorySchema),
  PartsController.adminUpdateCategory
);

// ---------------------------------------------------------------------------
// Admin: Product management
// ---------------------------------------------------------------------------
router.get('/admin/products', authenticateToken, requireRoles('admin'), PartsController.adminListProducts);
router.get('/admin/products/:id', authenticateToken, requireRoles('admin'), PartsController.adminGetProduct);
router.post('/admin/products/:id/approve', authenticateToken, requireRoles('admin'), PartsController.adminApproveProduct);
router.post(
  '/admin/products/:id/reject',
  authenticateToken,
  requireRoles('admin'),
  validateBody(adminRejectProductSchema),
  PartsController.adminRejectProduct
);
router.post(
  '/admin/products/:id/archive',
  authenticateToken,
  requireRoles('admin'),
  validateBody(adminArchiveProductSchema),
  PartsController.adminArchiveProduct
);
router.get(
  '/admin/products/:id/inventory',
  authenticateToken,
  requireRoles('admin'),
  PartsController.adminGetInventoryHistory
);

// ---------------------------------------------------------------------------
// Admin: Parts Order management
// ---------------------------------------------------------------------------
router.get('/admin/orders', authenticateToken, requireRoles('admin'), PartsController.getAdminOrders);
router.get('/admin/orders/:id', authenticateToken, requireRoles('admin'), PartsController.getAdminOrderById);
router.patch(
  '/admin/orders/:id/status',
  authenticateToken,
  requireRoles('admin'),
  validateBody(updatePartOrderStatusSchema),
  PartsController.updateAdminOrderStatus
);

// ---------------------------------------------------------------------------
// Supplier: Product management
// ---------------------------------------------------------------------------
router.get('/products', authenticateToken, requireRoles('supplier'), PartsController.listSupplierProducts);
router.post(
  '/products',
  authenticateToken,
  requireRoles('supplier'),
  validateBody(createProductSchema),
  PartsController.createProduct
);
router.get('/products/:id', authenticateToken, requireRoles('supplier'), PartsController.getSupplierProduct);
router.put(
  '/products/:id',
  authenticateToken,
  requireRoles('supplier'),
  validateBody(updateProductSchema),
  PartsController.updateProduct
);
router.delete('/products/:id', authenticateToken, requireRoles('supplier'), PartsController.archiveOwnProduct);

// Supplier: Image management
router.post(
  '/products/:id/images',
  partsImageUploadLimiter,
  authenticateToken,
  requireRoles('supplier'),
  partsImageUploadMiddleware,
  PartsController.uploadProductImage
);
router.delete(
  '/products/:id/images/:index',
  authenticateToken,
  requireRoles('supplier'),
  PartsController.removeProductImage
);

// Supplier: Inventory
router.patch(
  '/products/:id/stock',
  authenticateToken,
  requireRoles('supplier'),
  validateBody(adjustStockSchema),
  PartsController.adjustStock
);
router.get(
  '/products/:id/inventory',
  authenticateToken,
  requireRoles('supplier'),
  PartsController.getInventoryHistory
);

// ---------------------------------------------------------------------------
// Supplier: Orders & Fulfillment
// ---------------------------------------------------------------------------
router.get('/supplier/orders', authenticateToken, requireRoles('supplier'), PartsController.getSupplierOrders);
router.get('/supplier/orders/:id', authenticateToken, requireRoles('supplier'), PartsController.getSupplierOrderById);
router.patch(
  '/supplier/orders/:id/status',
  authenticateToken,
  requireRoles('supplier'),
  validateBody(updatePartOrderStatusSchema),
  PartsController.updateSupplierOrderStatus
);

export default router;
