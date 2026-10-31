import { Booking } from '../../models/Booking';
import { AvailabilityService } from '../bookings/availability';
import { TechnicianProfile } from '../../models/TechnicianProfile';
import { User } from '../../models/User';
import { sendEmail } from '../../services/emailService';
import logger from '../../config/logger';

export async function sweepExpiredPrepayBookings(): Promise<{ sweptCount: number }> {
  const now = new Date();

  // Find candidate booking IDs
  const candidates = await Booking.find({
    paymentStatus: 'pending',
    paymentExpiresAt: { $lt: now },
    status: { $nin: ['cancelled', 'completed'] },
    deletedAt: null,
  }).select('_id');

  let sweptCount = 0;

  for (const candidate of candidates) {
    // Atomically claim and cancel the booking
    const booking = await Booking.findOneAndUpdate(
      {
        _id: candidate._id,
        paymentStatus: 'pending',
        paymentExpiresAt: { $lt: now },
        status: { $nin: ['cancelled', 'completed'] },
      },
      {
        $set: {
          status: 'cancelled',
          paymentStatus: 'failed',
        },
        $push: {
          statusHistory: {
            status: 'cancelled',
            by: 'system_sweep',
            at: new Date(),
            note: 'Cancelled due to unpaid prepayment expiration',
          },
        },
      },
      { new: true }
    );

    if (!booking) {
      // Already cancelled or processed concurrently
      continue;
    }

    sweptCount++;

    // Release slot reservation atomically
    if (booking.scheduledLocal?.date && booking.scheduledLocal?.slot && booking.categoryId) {
      try {
        await AvailabilityService.releaseSlotAtomic(
          booking.scheduledLocal.date,
          booking.scheduledLocal.slot,
          booking.categoryId
        );
      } catch (slotErr) {
        logger.error({ err: slotErr, bookingId: booking._id }, 'Failed to release slot in prepay sweep');
      }
    }

    // Release any technician schedule entry
    const assignedTech = booking.assignment?.technicianUserId || booking.technicianId;
    if (assignedTech) {
      try {
        await TechnicianProfile.updateOne(
          { userId: assignedTech },
          { $pull: { activeSchedule: { bookingId: booking._id } } }
        );
      } catch (techErr) {
        logger.error({ err: techErr, bookingId: booking._id }, 'Failed to release tech schedule');
      }
    }

    // Email customer
    let recipientEmail = booking.guest?.email;
    if (!recipientEmail && booking.customerId) {
      try {
        const u = await User.findById(booking.customerId).select('email');
        recipientEmail = u?.email;
      } catch (uErr) {
        logger.warn({ err: uErr }, 'Could not lookup customer email in sweeper');
      }
    }
    if (recipientEmail) {
      sendEmail({
        to: recipientEmail,
        subject: `Booking Cancelled (Payment Expired) #${booking.bookingNumber}`,
        html: `<p>Your booking #${booking.bookingNumber} has been cancelled because payment was not received within the required window.</p>`,
      }).catch((e) => logger.error({ err: e }, 'Failed to send payment expiry email'));
    }
  }

  logger.info({ sweptCount }, 'Completed prepay payments sweep');
  return { sweptCount };
}
