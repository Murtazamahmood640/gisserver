import { Request, Response } from 'express';
import { PayoutService } from './service';
import { createPayoutSchema, markPaidSchema } from './schemas';
import logger from '../../config/logger';

interface PayoutErrorLike {
  statusCode?: number;
  code?: string;
  message?: string;
  name?: string;
  errors?: unknown;
  stack?: string;
}

export class PayoutController {
  /**
   * GET /api/v1/technicians/me/earnings
   * Authenticated approved technician: retrieves own earnings summary and paginated items.
   */
  static async getEarnings(req: Request, res: Response) {
    try {
      const technicianUserId = req.user!.userId;
      const result = await PayoutService.getTechnicianEarnings(technicianUserId, req.query);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const e = err as PayoutErrorLike;
      logger.error({ err: e.message || err }, 'Failed to get technician earnings');
      return res.status(e.statusCode || 500).json({
        success: false,
        error: {
          code: e.code || 'EARNINGS_ERROR',
          message: e.message || 'Failed to retrieve earnings',
        },
      });
    }
  }

  /**
   * GET /api/v1/admin/payouts/balances
   * Admin only: lists available payout balances across all technicians.
   */
  static async getBalances(_req: Request, res: Response) {
    try {
      const balances = await PayoutService.getBalances();
      return res.status(200).json({
        success: true,
        data: balances,
      });
    } catch (err: unknown) {
      const e = err as PayoutErrorLike;
      logger.error({ err: e.message || err }, 'Failed to retrieve payout balances');
      return res.status(e.statusCode || 500).json({
        success: false,
        error: {
          code: e.code || 'BALANCES_ERROR',
          message: e.message || 'Failed to retrieve payout balances',
        },
      });
    }
  }

  /**
   * POST /api/v1/admin/payouts
   * Admin only: creates a draft payout for a technician.
   */
  static async createPayout(req: Request, res: Response) {
    try {
      const parsed = createPayoutSchema.parse(req.body);
      const payout = await PayoutService.createPayout(req.user!.userId, parsed);

      return res.status(201).json({
        success: true,
        data: payout,
      });
    } catch (err: unknown) {
      const e = err as PayoutErrorLike;
      if (e.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid payout creation data',
            details: e.errors,
          },
        });
      }
      return res.status(e.statusCode || 500).json({
        success: false,
        error: {
          code: e.code || 'PAYOUT_CREATE_ERROR',
          message: e.message || 'Failed to create payout',
        },
      });
    }
  }

  /**
   * GET /api/v1/admin/payouts
   * Admin only: lists payouts with optional filtering and pagination.
   */
  static async listPayouts(req: Request, res: Response) {
    try {
      const result = await PayoutService.listPayouts(req.query);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const e = err as PayoutErrorLike;
      return res.status(e.statusCode || 500).json({
        success: false,
        error: {
          code: e.code || 'PAYOUT_LIST_ERROR',
          message: e.message || 'Failed to list payouts',
        },
      });
    }
  }

  /**
   * GET /api/v1/admin/payouts/:id
   * Admin only: gets detailed statement for a specific payout.
   */
  static async getPayoutById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const result = await PayoutService.getPayoutById(id);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const e = err as PayoutErrorLike;
      return res.status(e.statusCode || 500).json({
        success: false,
        error: {
          code: e.code || 'PAYOUT_NOT_FOUND',
          message: e.message || 'Failed to retrieve payout',
        },
      });
    }
  }

  /**
   * POST /api/v1/admin/payouts/:id/mark-paid
   * Admin only: marks a draft payout as paid.
   */
  static async markPaid(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const parsed = markPaidSchema.parse(req.body);
      const payout = await PayoutService.markPaid(id, req.user!.userId, parsed);

      return res.status(200).json({
        success: true,
        data: payout,
      });
    } catch (err: unknown) {
      const e = err as PayoutErrorLike;
      if (e.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid mark-paid data',
            details: e.errors,
          },
        });
      }
      return res.status(e.statusCode || 500).json({
        success: false,
        error: {
          code: e.code || 'MARK_PAID_ERROR',
          message: e.message || 'Failed to mark payout as paid',
        },
      });
    }
  }

  /**
   * POST /api/v1/admin/payouts/:id/void
   * Admin only: voids a draft payout and releases bookings.
   */
  static async voidPayout(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const payout = await PayoutService.voidPayout(id, req.user!.userId);

      return res.status(200).json({
        success: true,
        data: payout,
      });
    } catch (err: unknown) {
      const e = err as PayoutErrorLike;
      return res.status(e.statusCode || 500).json({
        success: false,
        error: {
          code: e.code || 'VOID_PAYOUT_ERROR',
          message: e.message || 'Failed to void payout',
        },
      });
    }
  }

  /**
   * GET /api/v1/admin/payouts/:id/export.csv
   * Admin only: exports payout statement as CSV with injection protection.
   */
  static async exportCsv(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const csv = await PayoutService.exportCsv(id);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="payout-${id}.csv"`);
      return res.status(200).send(csv);
    } catch (err: unknown) {
      const e = err as PayoutErrorLike;
      return res.status(e.statusCode || 500).json({
        success: false,
        error: {
          code: e.code || 'CSV_EXPORT_ERROR',
          message: e.message || 'Failed to export CSV',
        },
      });
    }
  }
}
