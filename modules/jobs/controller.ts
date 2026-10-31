import { Request, Response } from 'express';
import { JobsService } from './service';
import { DispatchService } from '../dispatch/service';
import { getErrorDetails } from '../../utils/httpErrors';

export class JobsController {
  static async getConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = await JobsService.getConfig();
      res.status(200).json({ success: true, data: config });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'SERVER_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: { code: errInfo.code, message: errInfo.message },
      });
    }
  }

  static async acceptOffer(req: Request, res: Response): Promise<void> {
    try {
      const { offerId } = req.params;
      const technicianUserId = req.user!.userId;
      const result = await DispatchService.acceptOffer(offerId, technicianUserId);

      res.status(200).json({
        success: true,
        message: 'Offer accepted successfully. Booking assigned to you.',
        data: result,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'ACCEPT_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async declineOffer(req: Request, res: Response): Promise<void> {
    try {
      const { offerId } = req.params;
      const technicianUserId = req.user!.userId;
      const { reason } = req.body;
      const result = await DispatchService.declineOffer(offerId, technicianUserId, reason);

      res.status(200).json({
        success: true,
        message: 'Offer declined',
        data: result,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'DECLINE_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async getMyJobs(req: Request, res: Response): Promise<void> {
    try {
      const technicianUserId = req.user!.userId;
      const result = await JobsService.getMyJobs(technicianUserId, req.query);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'SERVER_ERROR');
      res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: errInfo.message,
        },
      });
    }
  }

  static async getJobDetail(req: Request, res: Response): Promise<void> {
    try {
      const { bookingId } = req.params;
      const technicianUserId = req.user!.userId;
      const job = await JobsService.getJobDetail(bookingId, technicianUserId);

      res.status(200).json({
        success: true,
        data: job,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'NOT_FOUND');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async enRoute(req: Request, res: Response): Promise<void> {
    try {
      const { bookingId } = req.params;
      const technicianUserId = req.user!.userId;
      const updated = await JobsService.enRoute(bookingId, technicianUserId);

      res.status(200).json({
        success: true,
        message: 'Status updated to technician_en_route',
        data: updated,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'STATUS_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async arrived(req: Request, res: Response): Promise<void> {
    try {
      const { bookingId } = req.params;
      const technicianUserId = req.user!.userId;
      const updated = await JobsService.arrived(bookingId, technicianUserId);

      res.status(200).json({
        success: true,
        message: 'Status updated to arrived',
        data: updated,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'STATUS_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async start(req: Request, res: Response): Promise<void> {
    try {
      const { bookingId } = req.params;
      const technicianUserId = req.user!.userId;
      const updated = await JobsService.start(bookingId, technicianUserId);

      res.status(200).json({
        success: true,
        message: 'Status updated to in_progress',
        data: updated,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'STATUS_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async complete(req: Request, res: Response): Promise<void> {
    try {
      const { bookingId } = req.params;
      const technicianUserId = req.user!.userId;
      const updated = await JobsService.complete(bookingId, technicianUserId, req.body);

      res.status(200).json({
        success: true,
        message: 'Status updated to completed',
        data: updated,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'STATUS_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async release(req: Request, res: Response): Promise<void> {
    try {
      const { bookingId } = req.params;
      const technicianUserId = req.user!.userId;
      const { reason } = req.body;
      const updated = await JobsService.release(bookingId, technicianUserId, reason);

      res.status(200).json({
        success: true,
        message: 'Job released and returned to dispatch',
        data: updated,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'RELEASE_ERROR');
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }
}
