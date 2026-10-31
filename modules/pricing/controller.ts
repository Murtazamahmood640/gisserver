import { Request, Response } from 'express';
import { PricingService } from './service';

export class PricingController {
  // ---------------------------------------------------------------------------
  // Public Pricing Endpoints
  // ---------------------------------------------------------------------------
  static async lookupPrice(req: Request, res: Response) {
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

  static async getServicePrices(req: Request, res: Response) {
    try {
      const { serviceId } = req.params;
      const prices = await PricingService.getPricesForService(serviceId);
      return res.status(200).json({ success: true, data: prices });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Admin Endpoints
  // ---------------------------------------------------------------------------
  static async adminGetAllPrices(_req: Request, res: Response) {
    try {
      const prices = await PricingService.getAllPrices();
      return res.status(200).json({ success: true, data: prices });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async adminUpsertPrice(req: Request, res: Response) {
    try {
      const { serviceId, vehicleCategory, price } = req.body;
      const result = await PricingService.upsertPrice(serviceId, vehicleCategory, price);
      return res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: { code: 'UPSERT_FAILED', message: error.message },
      });
    }
  }

  static async adminUpdatePrice(req: Request, res: Response) {
    try {
      const { price } = req.body;
      const result = await PricingService.updatePrice(req.params.id, price);
      if (!result) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Price record not found' },
        });
      }
      return res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: { code: 'UPDATE_FAILED', message: error.message },
      });
    }
  }

  static async adminDeletePrice(req: Request, res: Response) {
    try {
      const deleted = await PricingService.deletePrice(req.params.id);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Price record not found' },
        });
      }
      return res.status(200).json({ success: true, message: 'Price record deleted successfully' });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  // Commission Rules
  static async adminGetCommissionRules(_req: Request, res: Response) {
    try {
      const rules = await PricingService.getCommissionRules();
      return res.status(200).json({ success: true, data: rules });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }

  static async adminCreateCommissionRule(req: Request, res: Response) {
    try {
      const rule = await PricingService.createCommissionRule(req.body);
      return res.status(201).json({ success: true, data: rule });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: error.message },
      });
    }
  }

  static async adminUpdateCommissionRule(req: Request, res: Response) {
    try {
      const rule = await PricingService.updateCommissionRule(req.params.id, req.body);
      if (!rule) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Commission rule not found' },
        });
      }
      return res.status(200).json({ success: true, data: rule });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: { code: 'UPDATE_FAILED', message: error.message },
      });
    }
  }

  static async adminDeleteCommissionRule(req: Request, res: Response) {
    try {
      const deleted = await PricingService.deleteCommissionRule(req.params.id);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Commission rule not found' },
        });
      }
      return res.status(200).json({ success: true, message: 'Commission rule deleted successfully' });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  }
}
