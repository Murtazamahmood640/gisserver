export type EarningState = 'pending' | 'available' | 'in_payout' | 'paid' | 'excluded';

export interface BookingEarningInfo {
  bookingId: string;
  bookingNumber: string;
  serviceName: string;
  completedAt?: Date;
  earningCents: number;
  state: EarningState;
}

/**
 * Pure calculation of technician earning in integer cents for a single booking.
 * - Must be status === 'completed'.
 * - If paymentStatus is 'paid': earns booking.pricing.providerPayoutCents.
 * - If paymentStatus is 'partially_refunded': scaled by (paidCents - refundedCents) / paidCents with round half up.
 * - Fully refunded, unpaid, or pending earns 0.
 */
export function computeEarningCents(booking: {
  status?: string;
  pricing?: { providerPayoutCents?: number; totalCents?: number };
  paymentStatus?: string;
  paidCents?: number;
  refundedCents?: number;
  payment?: { amountCents?: number; refundedCents?: number };
}): number {
  if (booking.status !== 'completed') {
    return 0;
  }
  const providerPayoutCents = booking.pricing?.providerPayoutCents ?? 0;
  if (providerPayoutCents <= 0) {
    return 0;
  }

  if (booking.paymentStatus === 'paid') {
    return providerPayoutCents;
  }

  if (booking.paymentStatus === 'partially_refunded') {
    const paid = booking.paidCents ?? booking.payment?.amountCents ?? (booking.pricing?.totalCents ?? 0);
    const refunded = booking.refundedCents ?? booking.payment?.refundedCents ?? 0;
    if (paid <= 0 || refunded >= paid) {
      return 0;
    }
    // Scaled by (paid - refunded) / paid with round half up (Math.round in JS)
    return Math.round((providerPayoutCents * (paid - refunded)) / paid);
  }

  return 0;
}

/**
 * Pure state evaluation of a booking's earnings.
 * States:
 * - 'excluded': not completed or payment is unpaid/pending/refunded
 * - 'pending': within payoutHoldDays after completedAt
 * - 'available': past hold days, not in a payout
 * - 'in_payout': claimed by a draft payout
 * - 'paid': claimed by a paid payout
 */
export function computeEarningState(
  booking: {
    status?: string;
    paymentStatus?: string;
    completedAt?: Date;
    lifecycle?: { completedAt?: Date };
    payout?: { payoutId?: string };
  },
  payoutHoldDays: number = 3,
  payoutStatus?: string,
  now: Date = new Date()
): EarningState {
  if (booking.status !== 'completed') {
    return 'excluded';
  }
  if (!['paid', 'partially_refunded'].includes(booking.paymentStatus || '')) {
    return 'excluded';
  }

  const effectiveCompleted = booking.completedAt ?? booking.lifecycle?.completedAt;

  if (booking.payout?.payoutId) {
    if (payoutStatus === 'paid') {
      return 'paid';
    }
    if (payoutStatus === 'void') {
      const completedTime = effectiveCompleted ? new Date(effectiveCompleted).getTime() : 0;
      const isPastHold = completedTime + payoutHoldDays * 86400000 <= now.getTime();
      return isPastHold ? 'available' : 'pending';
    }
    return 'in_payout';
  }

  const completedTime = effectiveCompleted ? new Date(effectiveCompleted).getTime() : 0;
  const isPastHold = completedTime + payoutHoldDays * 86400000 <= now.getTime();
  return isPastHold ? 'available' : 'pending';
}
