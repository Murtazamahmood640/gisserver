import { Request, Response } from 'express';
import { AdminService } from './service';
import { adminOverviewQuerySchema } from './schema';
import logger from '../../config/logger';

export class AdminController {
  /**
   * GET /api/v1/admin/counts
   * Fast badge counts polling endpoint.
   */
  static async getCounts(_req: Request, res: Response): Promise<void> {
    try {
      const counts = await AdminService.getCounts();
      res.status(200).json({
        success: true,
        data: counts,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch admin badge counts');
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch badge counts' },
      });
    }
  }

  /**
   * GET /api/v1/admin/overview?range=7d|30d|90d
   * Dashboard overview KPIs and trends.
   */
  static async getOverview(req: Request, res: Response): Promise<void> {
    try {
      const parseResult = adminOverviewQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: 'Invalid query parameters',
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Query parameter "range" must be "7d", "30d", or "90d"',
            details: parseResult.error.flatten(),
          },
        });
        return;
      }

      const { range } = parseResult.data;
      const isAdmin = req.user?.role === 'admin';

      const overview = await AdminService.getOverview(range, isAdmin);
      res.status(200).json({
        success: true,
        data: overview,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate admin overview analytics');
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: { code: 'INTERNAL_ERROR', message: 'Failed to generate overview analytics' },
      });
    }
  }
}
