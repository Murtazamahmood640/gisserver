import { Request, Response } from 'express';
import { CatalogService } from './service';
import { PricingService } from '../pricing/service';

export class CatalogController {
  // ---------------------------------------------------------------------------
  // Public Catalog Endpoints
  // ---------------------------------------------------------------------------
  static async getCategories(_req: Request, res: Response) {
    try {
      const categories = await CatalogService.getActiveCategories();
      return res.status(200).json({ success: true, data: categories });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async getServices(req: Request, res: Response) {
    try {
      const { categoryId, categorySlug } = req.query as { categoryId?: string; categorySlug?: string };
      const services = await CatalogService.getActiveServices({ categoryId, categorySlug });
      return res.status(200).json({ success: true, data: services });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async getAddons(req: Request, res: Response) {
    try {
      const { serviceId, categoryId } = req.query as { serviceId?: string; categoryId?: string };
      const addons = await CatalogService.getActiveAddons({ serviceId, categoryId });
      return res.status(200).json({ success: true, data: addons });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async validateCoupon(req: Request, res: Response) {
    try {
      const { code, subtotalCents } = req.body;
      const result = await CatalogService.validateCoupon(code, subtotalCents);
      return res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async getPriceLookup(req: Request, res: Response) {
    try {
      const { serviceId, serviceSlug, vehicleCategory } = req.query as {
        serviceId?: string;
        serviceSlug?: string;
        vehicleCategory?: string;
      };

      const identifier = serviceId || serviceSlug;
      if (!identifier || !vehicleCategory) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Both service identifier (serviceId or serviceSlug) and vehicleCategory are required',
          },
        });
      }

      const price = await PricingService.lookupPrice(identifier, vehicleCategory);
      return res.status(200).json({ success: true, data: price });
    } catch (error: any) {
      const status = error.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: { code: error.code || 'PRICE_LOOKUP_ERROR', message: error.message },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Admin Endpoints
  // ---------------------------------------------------------------------------
  static async adminGetCategories(_req: Request, res: Response) {
    try {
      const categories = await CatalogService.getAllCategories();
      return res.status(200).json({ success: true, data: categories });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async adminCreateCategory(req: Request, res: Response) {
    try {
      const category = await CatalogService.createCategory(req.body);
      return res.status(201).json({ success: true, data: category });
    } catch (error: any) {
      const status = error.statusCode || 400;
      return res.status(status).json({
        success: false,
        error: { code: error.code || 'VALIDATION_ERROR', message: error.message },
      });
    }
  }

  static async adminUpdateCategory(req: Request, res: Response) {
    try {
      const category = await CatalogService.updateCategory(req.params.id, req.body);
      if (!category) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Category not found' },
        });
      }
      return res.status(200).json({ success: true, data: category });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: { code: 'UPDATE_FAILED', message: error.message },
      });
    }
  }

  static async adminDeleteCategory(req: Request, res: Response) {
    try {
      const deleted = await CatalogService.deleteCategory(req.params.id);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Category not found' },
        });
      }
      return res.status(200).json({ success: true, message: 'Category deleted successfully' });
    } catch (error: any) {
      const status = error.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: { code: error.code || 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async adminGetServices(_req: Request, res: Response) {
    try {
      const services = await CatalogService.getAllServices();
      return res.status(200).json({ success: true, data: services });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async adminCreateService(req: Request, res: Response) {
    try {
      const service = await CatalogService.createService(req.body);
      return res.status(201).json({ success: true, data: service });
    } catch (error: any) {
      const status = error.statusCode || 400;
      return res.status(status).json({
        success: false,
        error: { code: error.code || 'VALIDATION_ERROR', message: error.message },
      });
    }
  }

  static async adminUpdateService(req: Request, res: Response) {
    try {
      const service = await CatalogService.updateService(req.params.id, req.body);
      if (!service) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Service not found' },
        });
      }
      return res.status(200).json({ success: true, data: service });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: { code: 'UPDATE_FAILED', message: error.message },
      });
    }
  }

  static async adminDeleteService(req: Request, res: Response) {
    try {
      const deleted = await CatalogService.deleteService(req.params.id);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Service not found' },
        });
      }
      return res.status(200).json({ success: true, message: 'Service deleted successfully' });
    } catch (error: any) {
      const status = error.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: { code: error.code || 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async adminGetAddons(_req: Request, res: Response) {
    try {
      const addons = await CatalogService.getAllAddons();
      return res.status(200).json({ success: true, data: addons });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async adminCreateAddon(req: Request, res: Response) {
    try {
      const addon = await CatalogService.createAddon(req.body);
      return res.status(201).json({ success: true, data: addon });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: error.message },
      });
    }
  }

  static async adminUpdateAddon(req: Request, res: Response) {
    try {
      const addon = await CatalogService.updateAddon(req.params.id, req.body);
      if (!addon) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Addon not found' },
        });
      }
      return res.status(200).json({ success: true, data: addon });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: { code: 'UPDATE_FAILED', message: error.message },
      });
    }
  }

  static async adminDeleteAddon(req: Request, res: Response) {
    try {
      const deleted = await CatalogService.deleteAddon(req.params.id);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Addon not found' },
        });
      }
      return res.status(200).json({ success: true, message: 'Addon deleted successfully' });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }
}
