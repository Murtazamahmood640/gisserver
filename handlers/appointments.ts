import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectDB } from '../config/database.ts';
import { Appointment } from '../models/Appointment.ts';
import { Coupon } from '../models/Coupon.ts';
import { sendEmail, getBookingConfirmationEmail, getAdminNotificationEmail } from '../services/emailService.ts';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  await connectDB();

  try {
    if (req.method === 'GET') {
      const appointments = await Appointment.find().sort({ createdAt: -1 });
      return res.status(200).json({
        success: true,
        data: appointments,
      });
    } else if (req.method === 'POST') {
      const appointmentData = req.body;

      if (!appointmentData.fullName || !appointmentData.email) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields',
        });
      }

      let processedCoupons: any[] = [];
      let totalDiscount = 0;
      let finalPrice = appointmentData.basePrice || appointmentData.totalPrice;

      if (appointmentData.coupons && Array.isArray(appointmentData.coupons) && appointmentData.coupons.length > 0) {
        const now = new Date();
        const basePrice = appointmentData.basePrice || appointmentData.totalPrice;

        for (const couponData of appointmentData.coupons) {
          const coupon = await Coupon.findOne({ 
            code: couponData.code,
            isActive: true,
            expiryDate: { $gt: now }
          });

          if (coupon) {
            const discountAmount = (basePrice * coupon.discountPercentage) / 100;
            totalDiscount += discountAmount;

            processedCoupons.push({
              code: coupon.code,
              discountPercentage: coupon.discountPercentage,
              discountAmount: discountAmount,
            });
          }
        }

        finalPrice = Math.max(0, basePrice - totalDiscount);
      }

      const appointmentToSave = {
        ...appointmentData,
        basePrice: appointmentData.basePrice || appointmentData.totalPrice,
        coupons: processedCoupons,
        totalDiscount: totalDiscount,
        totalPrice: finalPrice,
        discountApplied: processedCoupons.length > 0,
      };

      const appointment = new Appointment(appointmentToSave);
      await appointment.save();

      try {
        const couponCodes = processedCoupons.map(c => c.code).join(', ');
        await sendEmail({
          to: appointmentData.email,
          subject: 'Luxe Detail Booker - Appointment Confirmation',
          html: getBookingConfirmationEmail({
            fullName: appointmentData.fullName,
            serviceType: appointmentData.serviceType,
            date: appointmentData.date,
            timeSlot: appointmentData.timeSlot,
            totalPrice: finalPrice,
            basePrice: appointmentToSave.basePrice,
            discount: totalDiscount,
            coupons: couponCodes || 'None',
          } as any),
        });

        await sendEmail({
          to: process.env.ADMIN_EMAIL || 'info@vornoxlab.com',
          subject: 'New Booking - Luxe Detail Booker',
          html: getAdminNotificationEmail({
            fullName: appointmentData.fullName,
            phone: appointmentData.phone,
            email: appointmentData.email,
            serviceType: appointmentData.serviceType,
            date: appointmentData.date,
            timeSlot: appointmentData.timeSlot,
            vehicleName: appointmentData.vehicleName,
            totalPrice: finalPrice,
          }),
        });
      } catch (emailError) {
        console.error('Email sending error:', emailError);
      }

      return res.status(201).json({
        success: true,
        message: 'Appointment created successfully',
        data: appointment,
      });
    } else if (req.method === 'PUT') {
      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Invalid appointment ID',
        });
      }

      const appointment = await Appointment.findByIdAndUpdate(
        id,
        req.body,
        { new: true, runValidators: true }
      );

      if (!appointment) {
        return res.status(404).json({
          success: false,
          message: 'Appointment not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Appointment updated successfully',
        data: appointment,
      });
    } else if (req.method === 'DELETE') {
      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Invalid appointment ID',
        });
      }

      const appointment = await Appointment.findByIdAndDelete(id);

      if (!appointment) {
        return res.status(404).json({
          success: false,
          message: 'Appointment not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Appointment deleted successfully',
      });
    } else {
      return res.status(405).json({
        success: false,
        message: 'Method not allowed',
      });
    }
  } catch (error) {
    console.error('Appointments error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
