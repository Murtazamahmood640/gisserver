import logger from '../config/logger';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectDB } from '../config/database';
import { Coupon } from '../models/Coupon';
import { verifyToken } from '../utils/jwt';
import type { JwtPayload } from '../utils/jwt';

async function getTokenFromRequest(req: VercelRequest): Promise<JwtPayload | null> {
  if ((req as any).user) {
    return (req as any).user;
  }
  const headers = req.headers || (req as any).rawHeaders || {};
  const authHeader = headers['authorization'] || headers['Authorization'];
  const token = typeof authHeader === 'string' ? authHeader.split(' ')[1] : null;
  if (!token) return null;
  return verifyToken(token);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  await connectDB();

  try {
    if (req.method === 'GET' && req.query.active === 'true') {
      const now = new Date();
      const activeCoupons = await Coupon.find({
        isActive: true,
        expiryDate: { $gt: now }
      }).select('code discountPercentage expiryDate').sort({ createdAt: -1 });

      return res.status(200).json({
        success: true,
        data: activeCoupons,
      });
    }

    const user = await getTokenFromRequest(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      });
    }

    if (req.method === 'GET') {
      const { search, status } = req.query;

      const query: any = {};

      if (search) {
        query.code = { $regex: search, $options: 'i' };
      }

      if (status && status !== 'all') {
        query.isActive = status === 'active';
      }

      const coupons = await Coupon.find(query)
        .sort({ createdAt: -1 })
        .limit(100);

      return res.status(200).json({
        success: true,
        coupons,
        data: coupons,
      });
    }

    if (req.method === 'POST') {
      const { code, discountPercentage, expiryDate } = req.body;

      if (!code || !discountPercentage || !expiryDate) {
        return res.status(400).json({
          success: false,
          message: 'Code, discount percentage, and expiry date are required',
        });
      }

      if (discountPercentage < 1 || discountPercentage > 100) {
        return res.status(400).json({
          success: false,
          message: 'Discount must be between 1 and 100',
        });
      }

      const expiry = new Date(expiryDate);
      if (expiry <= new Date()) {
        return res.status(400).json({
          success: false,
          message: 'Expiry date must be in the future',
        });
      }

      const existingCoupon = await Coupon.findOne({
        code: code.toUpperCase(),
      });

      if (existingCoupon) {
        return res.status(400).json({
          success: false,
          message: 'Coupon with this code already exists',
        });
      }

      const newCoupon = new Coupon({
        code: code.toUpperCase(),
        discountPercentage,
        expiryDate: expiry,
        isActive: true,
      });

      await newCoupon.save();

      return res.status(201).json({
        success: true,
        coupon: newCoupon,
      });
    }

    if (req.method === 'PUT') {
      const id = (req.query?.id || (req as any).params?.id) as string;
      const { discountPercentage, expiryDate, isActive } = req.body;

      if (!id || typeof id !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Coupon ID is required',
        });
      }

      if (discountPercentage !== undefined) {
        if (discountPercentage < 1 || discountPercentage > 100) {
          return res.status(400).json({
            success: false,
            message: 'Discount must be between 1 and 100',
          });
        }
      }

      if (expiryDate !== undefined) {
        const expiry = new Date(expiryDate);
        if (expiry <= new Date()) {
          return res.status(400).json({
            success: false,
            message: 'Expiry date must be in the future',
          });
        }
      }

      const updateData: any = {};
      if (discountPercentage !== undefined) updateData.discountPercentage = discountPercentage;
      if (expiryDate !== undefined) updateData.expiryDate = new Date(expiryDate);
      if (isActive !== undefined) updateData.isActive = isActive;

      const updatedCoupon = await Coupon.findByIdAndUpdate(
        id,
        updateData,
        { new: true, returnDocument: 'after', runValidators: true }
      );

      if (!updatedCoupon) {
        return res.status(404).json({
          success: false,
          message: 'Coupon not found',
        });
      }

      return res.status(200).json({
        success: true,
        coupon: updatedCoupon,
      });
    }

    if (req.method === 'DELETE') {
      const id = (req.query?.id || (req as any).params?.id) as string;

      if (!id || typeof id !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Coupon ID is required',
        });
      }

      const deletedCoupon = await Coupon.findByIdAndDelete(id);

      if (!deletedCoupon) {
        return res.status(404).json({
          success: false,
          message: 'Coupon not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Coupon deleted successfully',
      });
    }

    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
    });
  } catch (error) {
    logger.error({ err: error }, 'Coupons handler error');

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error:
        process.env.NODE_ENV === 'development'
          ? error instanceof Error
            ? error.message
            : String(error)
          : undefined,
    });
  }
}
