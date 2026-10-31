import { Request, Response } from 'express';
import { VehicleService } from './service';

export class VehicleController {
  static async create(req: Request, res: Response) {
    const vehicle = await VehicleService.createVehicle(req.user!.userId, req.body);
    return res.status(201).json({
      success: true,
      data: vehicle,
    });
  }

  static async list(req: Request, res: Response) {
    const all = req.query.all === 'true';
    const vehicles = await VehicleService.getVehicles(req.user!.userId, {
      all,
      userRole: req.user!.role,
    });
    return res.status(200).json({
      success: true,
      data: vehicles,
    });
  }

  static async getById(req: Request, res: Response) {
    const { id } = req.params;
    const vehicle = await VehicleService.getVehicleById(id, req.user!.userId, req.user!.role);
    return res.status(200).json({
      success: true,
      data: vehicle,
    });
  }

  static async update(req: Request, res: Response) {
    const { id } = req.params;
    const vehicle = await VehicleService.updateVehicle(id, req.user!.userId, req.user!.role, req.body);
    return res.status(200).json({
      success: true,
      data: vehicle,
    });
  }

  static async delete(req: Request, res: Response) {
    const { id } = req.params;
    await VehicleService.deleteVehicle(id, req.user!.userId, req.user!.role);
    return res.status(200).json({
      success: true,
      message: 'Vehicle deleted successfully',
    });
  }
}
