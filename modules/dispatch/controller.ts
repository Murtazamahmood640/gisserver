import { Request, Response } from 'express';
import { DispatchService } from './service';
import { DispatchSettings } from '../../models/DispatchSettings';
import { TrackingService } from '../tracking/service';
import logger from '../../config/logger';
import { getErrorDetails } from '../../utils/httpErrors';

export class DispatchController {
  static async getCandidates(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const explain = req.query.explain === 'true';
      const candidates = await DispatchService.getCandidates(id, explain);
      res.status(200).json({
        success: true,
        data: candidates,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'SERVER_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async getOffers(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const offers = await DispatchService.getBookingOffers(id);
      res.status(200).json({
        success: true,
        data: offers,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'SERVER_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async assign(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { technicianUserId, force } = req.body;
      const actor = {
        userId: req.user!.userId,
        role: req.user!.role,
      };

      const updated = await DispatchService.manualAssign(id, technicianUserId, actor, Boolean(force));
      res.status(200).json({
        success: true,
        message: 'Technician assigned successfully',
        data: updated,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'ASSIGN_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async reassign(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { technicianUserId, force } = req.body;
      const actor = {
        userId: req.user!.userId,
        role: req.user!.role,
      };

      const updated = await DispatchService.manualReassign(id, technicianUserId, actor, Boolean(force));
      res.status(200).json({
        success: true,
        message: 'Technician reassigned successfully',
        data: updated,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'REASSIGN_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async unassign(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const actor = {
        userId: req.user!.userId,
        role: req.user!.role,
      };

      const updated = await DispatchService.manualUnassign(id, actor);
      res.status(200).json({
        success: true,
        message: 'Technician unassigned; booking returned to confirmed queue',
        data: updated,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'UNASSIGN_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async redispatch(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const actor = {
        userId: req.user!.userId,
        role: req.user!.role,
      };

      const updated = await DispatchService.manualRedispatch(id, actor);
      res.status(200).json({
        success: true,
        message: 'Redispatch initiated successfully',
        data: updated,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'REDISPATCH_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async getBoard(req: Request, res: Response): Promise<void> {
    try {
      const board = await DispatchService.getBoard();
      res.status(200).json({
        success: true,
        data: board,
      });
    } catch (err: unknown) {
      logger.error({ err }, 'Failed to fetch dispatch board');
      res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Failed to fetch dispatch board',
        },
      });
    }
  }

  static async cronSweep(req: Request, res: Response): Promise<void> {
    try {
      const sweepResult = await DispatchService.runDispatchSweep();
      const cleanupResult = await TrackingService.runTrackingCleanup();
      res.status(200).json({
        success: true,
        message: 'Dispatch sweep completed',
        data: {
          ...sweepResult,
          ...cleanupResult,
        },
      });
    } catch (err: unknown) {
      logger.error({ err }, 'Error during cron dispatch sweep');
      const errInfo = getErrorDetails(err, 'SWEEPER_ERROR');
      res.status(500).json({
        success: false,
        error: {
          code: 'SWEEPER_ERROR',
          message: errInfo.message || 'Dispatch sweep failed',
        },
      });
    }
  }

  static async getSettings(req: Request, res: Response): Promise<void> {
    try {
      const settings = await DispatchSettings.getSettings();
      res.status(200).json({
        success: true,
        data: settings,
      });
    } catch (err: unknown) {
      res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Failed to fetch dispatch settings',
        },
      });
    }
  }

  static async updateSettings(req: Request, res: Response): Promise<void> {
    try {
      const settings = await DispatchSettings.getSettings();
      Object.assign(settings, req.body);
      await settings.save();

      res.status(200).json({
        success: true,
        message: 'Dispatch settings updated successfully',
        data: settings,
      });
    } catch (err: unknown) {
      res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Failed to update dispatch settings',
        },
      });
    }
  }
}
