import mongoose from 'mongoose';
import { Vehicle, IVehicle } from '../../models/Vehicle';
import logger from '../../config/logger';

export class VehicleService {
  /**
   * Creates a vehicle for the owner.
   */
  static async createVehicle(ownerUserId: string, data: Partial<IVehicle>): Promise<IVehicle> {
    if (data.isDefault) {
      await Vehicle.updateMany({ ownerUserId, deletedAt: null }, { $set: { isDefault: false } });
    } else {
      const count = await Vehicle.countDocuments({ ownerUserId, deletedAt: null });
      if (count === 0) {
        data.isDefault = true;
      }
    }

    const vehicle = new Vehicle({
      ...data,
      ownerUserId,
      deletedAt: null,
    });

    await vehicle.save();
    logger.info({ vehicleId: vehicle._id.toString(), ownerUserId }, 'Vehicle created');
    return vehicle;
  }

  /**
   * Retrieves vehicles for the owner (or all vehicles if admin/dispatcher requests ?all=true).
   */
  static async getVehicles(
    ownerUserId: string,
    options: { all?: boolean; userRole?: string } = {}
  ): Promise<IVehicle[]> {
    const isAdminOrDispatcher =
      options.userRole === 'admin' || options.userRole === 'dispatcher';

    if (isAdminOrDispatcher && options.all) {
      return Vehicle.find({ deletedAt: null })
        .populate('ownerUserId', 'fullName email phone')
        .sort({ createdAt: -1 });
    }

    return Vehicle.find({ ownerUserId, deletedAt: null }).sort({ isDefault: -1, createdAt: -1 });
  }

  /**
   * Retrieves a vehicle by ID with ownership or admin check.
   */
  static async getVehicleById(
    vehicleId: string,
    userId: string,
    userRole?: string
  ): Promise<IVehicle> {
    const vehicle = await Vehicle.findOne({ _id: vehicleId, deletedAt: null });
    if (!vehicle) {
      const err = new Error('Vehicle not found') as any;
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    const isAuthorized =
      userRole === 'admin' ||
      userRole === 'dispatcher' ||
      vehicle.ownerUserId.toString() === userId;

    if (!isAuthorized) {
      const err = new Error('Forbidden: You do not own this vehicle') as any;
      err.statusCode = 403;
      err.code = 'FORBIDDEN';
      throw err;
    }

    return vehicle;
  }

  /**
   * Updates a vehicle with ownership or admin check.
   */
  static async updateVehicle(
    vehicleId: string,
    userId: string,
    userRole: string | undefined,
    data: Partial<IVehicle>
  ): Promise<IVehicle> {
    const vehicle = await this.getVehicleById(vehicleId, userId, userRole);

    if (data.isDefault) {
      await Vehicle.updateMany(
        { ownerUserId: vehicle.ownerUserId, deletedAt: null },
        { $set: { isDefault: false } }
      );
    }

    Object.assign(vehicle, data);
    await vehicle.save();
    logger.info({ vehicleId }, 'Vehicle updated');
    return vehicle;
  }

  /**
   * Soft-deletes a vehicle by setting deletedAt with ownership or admin check.
   */
  static async deleteVehicle(
    vehicleId: string,
    userId: string,
    userRole?: string
  ): Promise<boolean> {
    const vehicle = await this.getVehicleById(vehicleId, userId, userRole);
    vehicle.deletedAt = new Date();
    await vehicle.save();
    logger.info({ vehicleId }, 'Vehicle soft-deleted');
    return true;
  }
}
