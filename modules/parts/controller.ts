import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { getErrorDetails } from '../../utils/httpErrors';
import {
  PartCategoryService,
  PartProductService,
  AdminPartProductService,
  MarketplaceService,
  PartOrderService,
} from './service';

// ---------------------------------------------------------------------------
// Multer — memory storage for product image uploads (max 5 MB, single field "image")
// ---------------------------------------------------------------------------
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('image');

export function partsImageUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  memoryUpload(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'Image too large (max 5 MB)',
          error: { code: 'FILE_TOO_LARGE', message: 'Image too large (max 5 MB)' },
        });
      }
      const message = err instanceof Error ? err.message : 'File upload error';
      return res.status(400).json({
        success: false,
        message,
        error: { code: 'UPLOAD_ERROR', message },
      });
    }
    next();
  });
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function uploadProductImageToCloudinary(
  file: Express.Multer.File,
  supplierId: string
): Promise<string> {
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw Object.assign(new Error(`Image type '${file.mimetype}' is not allowed. Use JPEG, PNG, WebP, or GIF.`), {
      statusCode: 400,
      code: 'INVALID_IMAGE_TYPE',
    });
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `parts/products/${supplierId}`,
        resource_type: 'image',
        type: 'upload', // public
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error('Cloudinary upload failed'));
        } else {
          resolve(result.secure_url);
        }
      }
    );
    uploadStream.end(file.buffer);
  });
}

// ---------------------------------------------------------------------------
// PartsController
// ---------------------------------------------------------------------------
export class PartsController {

  // ── Public: Category listing ─────────────────────────────────────────────

  static async listCategories(req: Request, res: Response) {
    try {
      const categories = await PartCategoryService.listCategories(true);
      return res.status(200).json({ success: true, data: categories });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  // ── Admin: Category management ────────────────────────────────────────────

  static async adminListCategories(req: Request, res: Response) {
    try {
      const categories = await PartCategoryService.listCategories(false);
      return res.status(200).json({ success: true, data: categories });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async adminCreateCategory(req: Request, res: Response) {
    try {
      const category = await PartCategoryService.createCategory(req.body);
      return res.status(201).json({ success: true, data: category });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async adminUpdateCategory(req: Request, res: Response) {
    try {
      const category = await PartCategoryService.updateCategory(req.params.slug, req.body);
      return res.status(200).json({ success: true, data: category });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  // ── Supplier: Product CRUD ────────────────────────────────────────────────

  static async createProduct(req: Request, res: Response) {
    try {
      const product = await PartProductService.createProduct(req.user!.userId, req.body);
      return res.status(201).json({ success: true, message: 'Product created', data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async listSupplierProducts(req: Request, res: Response) {
    try {
      const { status, category, search, page, limit } = req.query as Record<string, string>;
      const result = await PartProductService.listSupplierProducts(req.user!.userId, {
        status: (status as any) || undefined,
        category,
        search,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });
      return res.status(200).json({ success: true, ...result });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async getSupplierProduct(req: Request, res: Response) {
    try {
      const product = await PartProductService.getSupplierProduct(req.user!.userId, req.params.id);
      return res.status(200).json({ success: true, data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async updateProduct(req: Request, res: Response) {
    try {
      const product = await PartProductService.updateProduct(req.user!.userId, req.params.id, req.body);
      return res.status(200).json({ success: true, message: 'Product updated', data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async archiveOwnProduct(req: Request, res: Response) {
    try {
      const product = await PartProductService.updateProduct(req.user!.userId, req.params.id, {
        status: 'archived',
      });
      return res.status(200).json({ success: true, message: 'Product archived', data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  // ── Supplier: Image management ────────────────────────────────────────────

  static async uploadProductImage(req: Request, res: Response) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'Image file is required',
          error: { code: 'MISSING_FILE', message: 'Image file is required' },
        });
      }

      // Get the supplier profile id for the folder path
      const supplierId = await PartProductService.getSupplierProfileId(req.user!.userId);
      const imageUrl = await uploadProductImageToCloudinary(req.file, supplierId.toString());

      const alt = (req.body?.alt as string) ?? '';
      const isPrimary = req.body?.isPrimary === 'true' || req.body?.isPrimary === true;

      const product = await PartProductService.addProductImage(req.user!.userId, req.params.id, {
        url: imageUrl,
        alt,
        isPrimary,
      });

      return res.status(200).json({ success: true, message: 'Image uploaded', data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async removeProductImage(req: Request, res: Response) {
    try {
      const index = parseInt(req.params.index, 10);
      if (isNaN(index)) {
        return res.status(400).json({
          success: false,
          message: 'Image index must be a number',
          error: { code: 'INVALID_INDEX', message: 'Image index must be a number' },
        });
      }
      const product = await PartProductService.removeProductImage(req.user!.userId, req.params.id, index);
      return res.status(200).json({ success: true, message: 'Image removed', data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  // ── Supplier: Inventory ───────────────────────────────────────────────────

  static async adjustStock(req: Request, res: Response) {
    try {
      const product = await PartProductService.adjustStock(req.user!.userId, req.params.id, req.body);
      return res.status(200).json({ success: true, message: 'Stock adjusted', data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async getInventoryHistory(req: Request, res: Response) {
    try {
      const { page, limit } = req.query as Record<string, string>;
      const result = await PartProductService.getInventoryHistory(
        req.user!.userId,
        req.params.id,
        page ? Number(page) : 1,
        limit ? Number(limit) : 20
      );
      return res.status(200).json({ success: true, ...result });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  // ── Admin: Product management ─────────────────────────────────────────────

  static async adminListProducts(req: Request, res: Response) {
    try {
      const { supplierId, category, status, search, brand, page, limit } = req.query as Record<string, string>;
      const result = await AdminPartProductService.listProducts({
        supplierId,
        category,
        status: (status as any) || undefined,
        search,
        brand,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });
      return res.status(200).json({ success: true, ...result });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async adminGetProduct(req: Request, res: Response) {
    try {
      const product = await AdminPartProductService.getProduct(req.params.id);
      return res.status(200).json({ success: true, data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async adminApproveProduct(req: Request, res: Response) {
    try {
      const product = await AdminPartProductService.approveProduct(
        req.params.id,
        req.user!.userId,
        req.body?.note
      );
      return res.status(200).json({ success: true, message: 'Product approved', data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async adminRejectProduct(req: Request, res: Response) {
    try {
      const product = await AdminPartProductService.rejectProduct(
        req.params.id,
        req.user!.userId,
        req.body.reason,
        req.body?.notes
      );
      return res.status(200).json({ success: true, message: 'Product rejected', data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async adminArchiveProduct(req: Request, res: Response) {
    try {
      const product = await AdminPartProductService.archiveProduct(
        req.params.id,
        req.user!.userId,
        req.body?.reason
      );
      return res.status(200).json({ success: true, message: 'Product archived', data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async adminGetInventoryHistory(req: Request, res: Response) {
    try {
      const { page, limit } = req.query as Record<string, string>;
      const result = await AdminPartProductService.getInventoryHistory(
        req.params.id,
        page ? Number(page) : 1,
        limit ? Number(limit) : 20
      );
      return res.status(200).json({ success: true, ...result });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  // ── Public Marketplace ────────────────────────────────────────────────────

  static async marketplaceBrowse(req: Request, res: Response) {
    try {
      const {
        category, brand, search, minPrice, maxPrice,
        inStockOnly, condition, make, model, page, limit, sort,
      } = req.query as Record<string, string>;

      const result = await MarketplaceService.browse({
        category,
        brand,
        search,
        minPrice: minPrice ? Number(minPrice) : undefined,
        maxPrice: maxPrice ? Number(maxPrice) : undefined,
        inStockOnly: inStockOnly === 'true',
        condition: condition as 'new' | 'used' | 'refurbished' | undefined,
        make,
        model,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        sort: sort as 'price_asc' | 'price_desc' | 'newest' | undefined,
      });
      return res.status(200).json({ success: true, ...result });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async marketplaceGetProduct(req: Request, res: Response) {
    try {
      const product = await MarketplaceService.getProduct(req.params.id);
      return res.status(200).json({ success: true, data: product });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  // ── Customer: Parts Orders & Checkout ────────────────────────────────────

  static async createOrder(req: Request, res: Response) {
    try {
      const order = await PartOrderService.createOrder(req.user!.userId, req.body);
      return res.status(201).json({ success: true, message: 'Order created', data: order });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async getCustomerOrders(req: Request, res: Response) {
    try {
      const orders = await PartOrderService.getCustomerOrders(req.user!.userId);
      return res.status(200).json({ success: true, data: orders });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async getCustomerOrderById(req: Request, res: Response) {
    try {
      const order = await PartOrderService.getCustomerOrderById(req.user!.userId, req.params.id);
      return res.status(200).json({ success: true, data: order });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  // ---------------------------------------------------------------------------
  // Supplier Orders
  // ---------------------------------------------------------------------------
  static async getSupplierOrders(req: Request, res: Response) {
    try {
      const orders = await PartOrderService.getSupplierOrders(req.user!.userId);
      return res.status(200).json({ success: true, data: orders });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async getSupplierOrderById(req: Request, res: Response) {
    try {
      const order = await PartOrderService.getSupplierOrderById(req.user!.userId, req.params.id);
      return res.status(200).json({ success: true, data: order });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async updateSupplierOrderStatus(req: Request, res: Response) {
    try {
      const { status, note } = req.body;
      const order = await PartOrderService.updateSupplierOrderStatus(
        req.user!.userId,
        req.params.id,
        status,
        note
      );
      return res.status(200).json({ success: true, data: order });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  // ---------------------------------------------------------------------------
  // Admin Orders
  // ---------------------------------------------------------------------------
  static async getAdminOrders(req: Request, res: Response) {
    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const result = await PartOrderService.getAdminOrders({
        status: req.query.status as string,
        paymentStatus: req.query.paymentStatus as string,
        search: req.query.search as string,
        page,
        limit,
      });
      return res.status(200).json({ success: true, data: result.orders, meta: result.meta });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async getAdminOrderById(req: Request, res: Response) {
    try {
      const order = await PartOrderService.getAdminOrderById(req.params.id);
      return res.status(200).json({ success: true, data: order });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }

  static async updateAdminOrderStatus(req: Request, res: Response) {
    try {
      const { status, note } = req.body;
      const order = await PartOrderService.updateAdminOrderStatus(
        req.user!.userId,
        req.params.id,
        status,
        note
      );
      return res.status(200).json({ success: true, data: order });
    } catch (err: unknown) {
      const { statusCode, code, message } = getErrorDetails(err);
      return res.status(statusCode).json({ success: false, message, error: { code, message } });
    }
  }
}
