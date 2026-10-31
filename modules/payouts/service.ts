import mongoose from 'mongoose';
import { Booking, IBooking } from '../../models/Booking';
import { Payment } from '../../models/Payment';
import { PaymentSettings } from '../../models/PaymentSettings';
import { Payout, IPayout, PayoutMethod } from '../../models/Payout';
import { PayoutAdjustment, IPayoutAdjustment } from '../../models/PayoutAdjustment';
import { User } from '../../models/User';
import { computeEarningCents, computeEarningState, EarningState } from './earningsService';
import logger from '../../config/logger';

export interface CreatePayoutParams {
  technicianUserId: string;
  upToDate?: string;
}

export interface MarkPaidParams {
  reference: string;
  method: PayoutMethod;
  paidAt?: string;
}

export interface TechEarningsSummary {
  pendingCents: number;
  availableCents: number;
  inPayoutCents: number;
  paidCents: number;
  adjustmentsCents: number;
}

export interface TechEarningItem {
  bookingId: string;
  bookingNumber: string;
  serviceName: string;
  completedAt?: Date;
  earningCents: number;
  state: EarningState;
}

export class PayoutService {
  /**
   * Retrieves summary and paginated earning items for a technician.
   * STRICT: NEVER exposes customer name, phone, email, or total amount.
   */
  static async getTechnicianEarnings(
    technicianUserId: string,
    query: { page?: string; limit?: string }
  ): Promise<{
    summary: TechEarningsSummary;
    items: TechEarningItem[];
    page: number;
    pages: number;
    total: number;
  }> {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const skip = (page - 1) * limit;

    const settings = await PaymentSettings.getSettings();
    const holdDays = settings.payoutHoldDays ?? 3;
    const now = new Date();

    // Find all bookings for this technician
    const techOid = new mongoose.Types.ObjectId(technicianUserId);
    const bookings = await Booking.find({
      $or: [
        { technicianId: techOid },
        { technicianUserId: techOid },
        { 'assignment.technicianUserId': techOid },
        { 'assignment.technicianId': techOid },
      ],
      deletedAt: null,
      isDeleted: { $ne: true },
    })
      .sort({ completedAt: -1, createdAt: -1 })
      .lean();

    // Map payout IDs to statuses
    const payoutIds = bookings
      .map((b) => b.payout?.payoutId)
      .filter((id): id is string => Boolean(id));

    const payouts = payoutIds.length > 0
      ? await Payout.find({ _id: { $in: payoutIds } }).select('_id status').lean()
      : [];
    const payoutStatusMap = new Map<string, string>();
    for (const p of payouts) {
      payoutStatusMap.set(p._id.toString(), p.status);
    }

    // Get payments for partial refund scaling
    const bookingIds = bookings.map((b) => b._id);
    const payments = await Payment.find({ bookingId: { $in: bookingIds } }).lean();
    const paymentMap = new Map<string, (typeof payments)[0]>();
    for (const p of payments) {
      paymentMap.set(p.bookingId.toString(), p);
    }

    let pendingCents = 0;
    let availableCents = 0;
    let inPayoutCents = 0;
    let paidCents = 0;

    const allItems: TechEarningItem[] = [];

    for (const b of bookings) {
      const pm = paymentMap.get(b._id.toString());
      const pStatus = b.payout?.payoutId ? payoutStatusMap.get(b.payout.payoutId) : undefined;

      const earningCents = computeEarningCents({
        status: b.status,
        pricing: b.pricing,
        paymentStatus: b.paymentStatus,
        paidCents: pm?.amountCents,
        refundedCents: pm?.refundedCents,
      });

      const state = computeEarningState(
        {
          status: b.status,
          paymentStatus: b.paymentStatus,
          completedAt: b.completedAt,
          payout: b.payout,
        },
        holdDays,
        pStatus,
        now
      );

      if (state === 'pending') pendingCents += earningCents;
      else if (state === 'available') availableCents += earningCents;
      else if (state === 'in_payout') inPayoutCents += earningCents;
      else if (state === 'paid') paidCents += earningCents;

      // Only include in items if completed or has earning potential
      if (b.status === 'completed' || earningCents > 0) {
        allItems.push({
          bookingId: b._id.toString(),
          bookingNumber: b.bookingNumber,
          serviceName: b.serviceSnapshot?.name || 'Service',
          completedAt: b.completedAt,
          earningCents,
          state,
        });
      }
    }

    // Unsettled adjustments (negative)
    const adjustments = await PayoutAdjustment.find({
      technicianUserId: new mongoose.Types.ObjectId(technicianUserId),
    }).lean();

    const adjustmentsCents = adjustments
      .filter((a) => !a.settledInPayoutId)
      .reduce((sum, a) => sum + a.amountCents, 0);

    const total = allItems.length;
    const paginatedItems = allItems.slice(skip, skip + limit);

    return {
      summary: {
        pendingCents,
        availableCents,
        inPayoutCents,
        paidCents,
        adjustmentsCents,
      },
      items: paginatedItems,
      page,
      pages: Math.ceil(total / limit) || 1,
      total,
    };
  }

  /**
   * Retrieves available payout balances per technician for admin overview.
   */
  static async getBalances(): Promise<
    Array<{
      technicianUserId: string;
      technicianName: string;
      email: string;
      availableCents: number;
      eligibleBookingsCount: number;
      oldestEligibleDate: Date | null;
    }>
  > {
    const settings = await PaymentSettings.getSettings();
    const holdDays = settings.payoutHoldDays ?? 3;
    const cutoff = new Date(Date.now() - holdDays * 86400000);

    // Active approved technicians
    const techUsers = await User.find({ role: 'technician', status: 'active' })
      .select('_id fullName email')
      .lean();

    const balances = [];

    for (const tech of techUsers) {
      const eligibleBookings = await Booking.find({
        $and: [
          {
            $or: [
              { technicianId: tech._id },
              { technicianUserId: tech._id },
              { 'assignment.technicianUserId': tech._id },
              { 'assignment.technicianId': tech._id },
            ],
          },
          {
            $or: [
              { payout: { $exists: false } },
              { 'payout.payoutId': { $exists: false } },
            ],
          },
          {
            $or: [
              { completedAt: { $lte: cutoff } },
              { 'lifecycle.completedAt': { $lte: cutoff } },
            ],
          },
        ],
        status: 'completed',
        paymentStatus: { $in: ['paid', 'partially_refunded'] },
        deletedAt: null,
      }).lean();

      // Find payments for scaling
      const bIds = eligibleBookings.map((b) => b._id);
      const payments = bIds.length > 0 ? await Payment.find({ bookingId: { $in: bIds } }).lean() : [];
      const paymentMap = new Map<string, (typeof payments)[0]>();
      for (const p of payments) {
        paymentMap.set(p.bookingId.toString(), p);
      }

      let grossEarnings = 0;
      let oldestDate: Date | null = null;

      for (const b of eligibleBookings) {
        const pm = paymentMap.get(b._id.toString());
        const earning = computeEarningCents({
          status: b.status,
          pricing: b.pricing,
          paymentStatus: b.paymentStatus,
          paidCents: pm?.amountCents,
          refundedCents: pm?.refundedCents,
        });
        grossEarnings += earning;

        const comp = b.completedAt || (b as { lifecycle?: { completedAt?: Date } }).lifecycle?.completedAt;
        if (comp) {
          if (!oldestDate || new Date(comp) < oldestDate) {
            oldestDate = new Date(comp);
          }
        }
      }

      // Unsettled adjustments
      const adjustments = await PayoutAdjustment.find({
        technicianUserId: tech._id,
        $or: [
          { settledInPayoutId: { $exists: false } },
          { settledInPayoutId: null },
        ],
      }).lean();

      const adjustmentsCents = adjustments.reduce((sum, a) => sum + a.amountCents, 0);
      const availableCents = grossEarnings + adjustmentsCents;

      balances.push({
        technicianUserId: tech._id.toString(),
        technicianName: tech.fullName || 'Technician',
        email: tech.email,
        availableCents,
        eligibleBookingsCount: eligibleBookings.length,
        oldestEligibleDate: oldestDate,
      });
    }

    return balances;
  }

  /**
   * Creates a draft payout by ATOMICALLY claiming eligible bookings.
   * Concurrency-safe: two concurrent creates will each claim each booking once.
   */
  static async createPayout(
    adminUserId: string,
    params: CreatePayoutParams
  ): Promise<IPayout> {
    const techUser = await User.findOne({
      _id: params.technicianUserId,
      role: 'technician',
    });

    if (!techUser) {
      throw Object.assign(new Error('Technician not found or invalid role'), {
        statusCode: 404,
        code: 'TECHNICIAN_NOT_FOUND',
      });
    }

    const settings = await PaymentSettings.getSettings();
    const holdDays = settings.payoutHoldDays ?? 3;
    const minPayoutCents = settings.minPayoutCents ?? 0;

    let cutoff = new Date(Date.now() - holdDays * 86400000);
    if (params.upToDate) {
      const parsedUpTo = new Date(params.upToDate);
      if (!isNaN(parsedUpTo.getTime()) && parsedUpTo < cutoff) {
        cutoff = parsedUpTo;
      }
    }

    // 1. Create a draft payout doc
    const payout = new Payout({
      technicianUserId: techUser._id,
      createdBy: new mongoose.Types.ObjectId(adminUserId),
      status: 'draft',
      bookingIds: [],
      grossCents: 0,
      adjustmentsCents: 0,
      netCents: 0,
      periodTo: cutoff,
      history: [
        {
          action: 'draft_created',
          by: adminUserId,
          at: new Date(),
          note: `Draft payout initiated up to ${cutoff.toISOString()}`,
        },
      ],
    });
    await payout.save();

    // 2. Find eligible candidate bookings
    const candidates = await Booking.find({
      $and: [
        {
          $or: [
            { technicianId: techUser._id },
            { technicianUserId: techUser._id },
            { 'assignment.technicianUserId': techUser._id },
            { 'assignment.technicianId': techUser._id },
          ],
        },
        {
          $or: [
            { payout: { $exists: false } },
            { 'payout.payoutId': { $exists: false } },
          ],
        },
        {
          $or: [
            { completedAt: { $lte: cutoff } },
            { 'lifecycle.completedAt': { $lte: cutoff } },
          ],
        },
      ],
      status: 'completed',
      paymentStatus: { $in: ['paid', 'partially_refunded'] },
      deletedAt: null,
    }).select('_id completedAt lifecycle pricing paymentStatus');

    const claimedBookings: IBooking[] = [];

    // Atomically claim each candidate
    for (const cand of candidates) {
      const claimed = await Booking.findOneAndUpdate(
        {
          _id: cand._id,
          $or: [
            { payout: { $exists: false } },
            { 'payout.payoutId': { $exists: false } },
          ],
        },
        {
          $set: {
            payout: { payoutId: payout._id.toString() },
          },
        },
        { new: true }
      );

      if (claimed) {
        claimedBookings.push(claimed);
      }
    }

    // 3. Atomically claim unsettled adjustments
    const adjustments = await PayoutAdjustment.find({
      technicianUserId: techUser._id,
      $or: [
        { settledInPayoutId: { $exists: false } },
        { settledInPayoutId: null },
      ],
    });

    const claimedAdjustments: IPayoutAdjustment[] = [];
    for (const adj of adjustments) {
      const claimedAdj = await PayoutAdjustment.findOneAndUpdate(
        {
          _id: adj._id,
          $or: [
            { settledInPayoutId: { $exists: false } },
            { settledInPayoutId: null },
          ],
        },
        {
          $set: { settledInPayoutId: payout._id },
        },
        { new: true }
      );
      if (claimedAdj) {
        claimedAdjustments.push(claimedAdj);
      }
    }

    // 4. Calculate gross earnings
    const bIds = claimedBookings.map((b) => b._id);
    const payments = bIds.length > 0 ? await Payment.find({ bookingId: { $in: bIds } }).lean() : [];
    const paymentMap = new Map<string, (typeof payments)[0]>();
    for (const p of payments) {
      paymentMap.set(p.bookingId.toString(), p);
    }

    let grossCents = 0;
    for (const b of claimedBookings) {
      const pm = paymentMap.get(b._id.toString());
      grossCents += computeEarningCents({
        status: b.status,
        pricing: b.pricing,
        paymentStatus: b.paymentStatus,
        paidCents: pm?.amountCents,
        refundedCents: pm?.refundedCents,
      });
    }

    const adjustmentsCents = claimedAdjustments.reduce((sum, a) => sum + a.amountCents, 0);
    const netCents = grossCents + adjustmentsCents;

    // 5. Validation check: must have earnings or adjustments, and meet minPayoutCents
    if (claimedBookings.length === 0 && claimedAdjustments.length === 0) {
      // Rollback
      await Payout.findByIdAndDelete(payout._id);
      throw Object.assign(
        new Error('No eligible completed bookings or adjustments found for this technician'),
        { statusCode: 400, code: 'NO_ELIGIBLE_EARNINGS' }
      );
    }

    if (netCents < minPayoutCents) {
      // Rollback claimed bookings
      await Booking.updateMany(
        { _id: { $in: claimedBookings.map((b) => b._id) } },
        { $unset: { payout: 1 } }
      );
      // Rollback claimed adjustments
      await PayoutAdjustment.updateMany(
        { _id: { $in: claimedAdjustments.map((a) => a._id) } },
        { $unset: { settledInPayoutId: 1 } }
      );
      await Payout.findByIdAndDelete(payout._id);

      throw Object.assign(
        new Error(`Payout amount ($${(netCents / 100).toFixed(2)}) is below the configured minimum ($${(minPayoutCents / 100).toFixed(2)})`),
        { statusCode: 400, code: 'BELOW_MINIMUM_PAYOUT' }
      );
    }

    // Update payout with calculated values
    payout.bookingIds = claimedBookings.map((b) => b._id);
    payout.grossCents = grossCents;
    payout.adjustmentsCents = adjustmentsCents;
    payout.netCents = netCents;
    await payout.save();

    logger.info(
      {
        payoutId: payout._id,
        technicianUserId: techUser._id,
        grossCents,
        adjustmentsCents,
        netCents,
        bookingCount: claimedBookings.length,
      },
      'Draft payout created'
    );

    return payout;
  }

  /**
   * Marks a draft payout as paid.
   */
  static async markPaid(
    payoutId: string,
    adminUserId: string,
    params: MarkPaidParams
  ): Promise<IPayout> {
    const payout = await Payout.findById(payoutId);
    if (!payout) {
      throw Object.assign(new Error('Payout not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }

    if (payout.status !== 'draft') {
      throw Object.assign(
        new Error(`Cannot mark payout as paid: current status is '${payout.status}' (expected 'draft')`),
        { statusCode: 400, code: 'INVALID_PAYOUT_STATUS' }
      );
    }

    const paidAtDate = params.paidAt ? new Date(params.paidAt) : new Date();

    payout.status = 'paid';
    payout.reference = params.reference;
    payout.method = params.method;
    payout.paidAt = paidAtDate;
    payout.paidBy = new mongoose.Types.ObjectId(adminUserId);
    payout.history.push({
      action: 'marked_paid',
      by: adminUserId,
      at: new Date(),
      note: `Method: ${params.method}, Reference: ${params.reference}`,
    });

    await payout.save();

    logger.info(
      {
        payoutId: payout._id,
        adminUserId,
        method: params.method,
        reference: params.reference,
        netCents: payout.netCents,
      },
      'Payout marked as paid'
    );

    return payout;
  }

  /**
   * Voids a draft payout and releases all claimed bookings and adjustments.
   */
  static async voidPayout(payoutId: string, adminUserId: string): Promise<IPayout> {
    const payout = await Payout.findById(payoutId);
    if (!payout) {
      throw Object.assign(new Error('Payout not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }

    if (payout.status !== 'draft') {
      throw Object.assign(
        new Error(`Cannot void payout: current status is '${payout.status}' (expected 'draft')`),
        { statusCode: 400, code: 'INVALID_PAYOUT_STATUS' }
      );
    }

    payout.status = 'void';
    payout.history.push({
      action: 'voided',
      by: adminUserId,
      at: new Date(),
      note: 'Draft payout voided by admin; bookings and adjustments released',
    });
    await payout.save();

    // Release bookings
    if (payout.bookingIds.length > 0) {
      await Booking.updateMany(
        { _id: { $in: payout.bookingIds } },
        { $unset: { payout: 1 } }
      );
    }

    // Release adjustments
    await PayoutAdjustment.updateMany(
      { settledInPayoutId: payout._id },
      { $unset: { settledInPayoutId: 1 } }
    );

    logger.info({ payoutId: payout._id, adminUserId }, 'Draft payout voided');
    return payout;
  }

  /**
   * Lists payouts with optional filtering and pagination.
   */
  static async listPayouts(query: {
    technicianUserId?: string;
    status?: string;
    page?: string;
    limit?: string;
  }): Promise<{
    items: IPayout[];
    total: number;
    page: number;
    pages: number;
  }> {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (query.technicianUserId) {
      filter.technicianUserId = new mongoose.Types.ObjectId(query.technicianUserId);
    }
    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }

    const [payouts, total] = await Promise.all([
      Payout.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('technicianUserId', 'fullName email')
        .populate('paidBy', 'fullName email')
        .populate('createdBy', 'fullName email')
        .lean(),
      Payout.countDocuments(filter),
    ]);

    return {
      items: payouts,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Retrieves a payout statement with populated bookings and adjustments.
   */
  static async getPayoutById(payoutId: string): Promise<{
    payout: IPayout;
    bookings: IBooking[];
    adjustments: IPayoutAdjustment[];
  }> {
    const payout = await Payout.findById(payoutId)
      .populate('technicianUserId', 'fullName email')
      .populate('paidBy', 'fullName email')
      .populate('createdBy', 'fullName email');

    if (!payout) {
      throw Object.assign(new Error('Payout not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }

    const bookings = await Booking.find({ _id: { $in: payout.bookingIds } })
      .select('bookingNumber serviceSnapshot completedAt pricing paymentStatus')
      .lean();

    const adjustments = await PayoutAdjustment.find({ settledInPayoutId: payout._id }).lean();

    return {
      payout,
      bookings,
      adjustments,
    };
  }

  /**
   * Generates CSV statement for a payout, with CSV injection protection.
   * Prefix cells starting with = + - @ or tab with a single quote.
   */
  static async exportCsv(payoutId: string): Promise<string> {
    const { payout, bookings, adjustments } = await this.getPayoutById(payoutId);

    function sanitizeCell(val: unknown): string {
      if (val === null || val === undefined) return '""';
      let str = String(val).trim();
      // CSV injection protection: prefix with single quote if starts with dangerous chars
      if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
      }
      // Escape double quotes
      str = str.replace(/"/g, '""');
      return `"${str}"`;
    }

    const lines: string[] = [];
    lines.push(`"PAYOUT STATEMENT #${payout._id}"`);
    lines.push(`"Technician",${sanitizeCell((payout.technicianUserId as { fullName?: string })?.fullName || 'Technician')}`);
    lines.push(`"Email",${sanitizeCell((payout.technicianUserId as { email?: string })?.email || '')}`);
    lines.push(`"Status",${sanitizeCell(payout.status.toUpperCase())}`);
    lines.push(`"Created Date",${sanitizeCell(payout.createdAt ? payout.createdAt.toISOString() : '')}`);
    if (payout.paidAt || payout.reference) {
      if (payout.paidAt) lines.push(`"Paid Date",${sanitizeCell(payout.paidAt.toISOString())}`);
      lines.push(`"Payment Method",${sanitizeCell(payout.method || 'bank')}`);
      lines.push(`"Reference",${sanitizeCell(payout.reference || '')}`);
    }
    lines.push('');
    lines.push('"BOOKINGS STATEMENT"');
    lines.push('"Booking Number","Service","Completed Date","Provider Payout ($)"');

    for (const b of bookings) {
      const payoutDollars = ((b.pricing?.providerPayoutCents || 0) / 100).toFixed(2);
      lines.push([
        sanitizeCell(b.bookingNumber),
        sanitizeCell(b.serviceSnapshot?.name || 'Service'),
        sanitizeCell(b.completedAt ? new Date(b.completedAt).toLocaleDateString() : ''),
        sanitizeCell(payoutDollars),
      ].join(','));
    }

    if (adjustments.length > 0) {
      lines.push('');
      lines.push('"ADJUSTMENTS"');
      lines.push('"Booking ID","Reason","Adjustment ($)"');
      for (const a of adjustments) {
        const adjDollars = (a.amountCents / 100).toFixed(2);
        lines.push([
          sanitizeCell(a.bookingId?.toString() || ''),
          sanitizeCell(a.reason),
          sanitizeCell(adjDollars),
        ].join(','));
      }
    }

    lines.push('');
    lines.push('"SUMMARY"');
    lines.push(`"Gross Earnings ($)",${sanitizeCell((payout.grossCents / 100).toFixed(2))}`);
    lines.push(`"Adjustments ($)",${sanitizeCell((payout.adjustmentsCents / 100).toFixed(2))}`);
    lines.push(`"Net Payout ($)",${sanitizeCell((payout.netCents / 100).toFixed(2))}`);

    return lines.join('\n');
  }
}
