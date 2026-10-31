import { Request, Response } from 'express';
import { TrackingService } from './service';
import { getErrorDetails } from '../../utils/httpErrors';

export class TrackingController {
  static async updateLocation(req: Request, res: Response): Promise<void> {
    try {
      const technicianUserId = req.user!.userId;
      const result = await TrackingService.updateLocation(technicianUserId, req.body);

      res.status(200).json({
        success: true,
        message: 'Location updated',
        data: result,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'LOCATION_ERROR');
      if (errInfo.statusCode === 429) {
        res.setHeader('Retry-After', String(errInfo.retryAfter || 5));
      }
      res.status(errInfo.statusCode).json({
        success: false,
        error: {
          code: errInfo.code,
          message: errInfo.message,
        },
      });
    }
  }

  static async getTracking(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const guestToken =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);

      const tracking = await TrackingService.getBookingTracking(
        id,
        req.user,
        guestToken
      );

      res.status(200).json({
        success: true,
        data: tracking,
      });
    } catch (err: unknown) {
      const errInfo = getErrorDetails(err, 'TRACKING_ERROR');
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
