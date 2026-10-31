import { Request, Response } from 'express';
import { CustomerService } from './service';

export class CustomerController {
  static async getMe(req: Request, res: Response) {
    const profile = await CustomerService.getProfile(req.user!.userId);
    return res.status(200).json({
      success: true,
      data: profile,
    });
  }

  static async updateMe(req: Request, res: Response) {
    const profile = await CustomerService.updateProfile(req.user!.userId, req.body);
    return res.status(200).json({
      success: true,
      data: profile,
    });
  }

  static async addAddress(req: Request, res: Response) {
    const addresses = await CustomerService.addAddress(req.user!.userId, req.body);
    return res.status(201).json({
      success: true,
      data: addresses,
    });
  }

  static async updateAddress(req: Request, res: Response) {
    const { addressId } = req.params;
    const addresses = await CustomerService.updateAddress(req.user!.userId, addressId, req.body);
    return res.status(200).json({
      success: true,
      data: addresses,
    });
  }

  static async deleteAddress(req: Request, res: Response) {
    const { addressId } = req.params;
    const addresses = await CustomerService.deleteAddress(req.user!.userId, addressId);
    return res.status(200).json({
      success: true,
      message: 'Address removed successfully',
      data: addresses,
    });
  }
}
