import { Booking } from '../../models/Booking';
import { TechnicianProfile } from '../../models/TechnicianProfile';
import { Contact } from '../../models/Contact';
import { Feedback } from '../../models/Feedback';
import { User } from '../../models/User';
import { localToUtc, utcToLocal } from '../bookings/availability';

export interface AdminCountsResponse {
  pendingBookings: number;
  pendingTechnicians: number;
  newContacts: number;
  pendingFeedback: number;
  unassignedBookings: number;
}

export interface AdminOverviewResponse {
  kpis: {
    bookingsToday: number;
    upcomingBookings: number;
    pendingBookings: number;
    pendingTechnicians: number;
    newContacts: number;
    pendingFeedback: number;
    unassignedBookings?: number;
    newCustomers: number;
    bookedValueCents?: number;
    paidValueCents?: number;
  };
  bookingsByStatus: { status: string; count: number }[];
  dailyTrend: {
    date: string;
    bookings: number;
    bookedValueCents?: number;
  }[];
  topServices: { name: string; count: number }[];
  recent: {
    bookings: {
      _id: string;
      bookingNumber: string;
      guest: { fullName: string };
      scheduledAt: Date;
      scheduledLocal?: { date: string; slot: string };
      status: string;
      bookedValueCents?: number;
    }[];
    technicianApplications: {
      _id: string;
      displayName: string;
      verificationStatus: string;
      createdAt: Date;
    }[];
    contacts: {
      _id: string;
      name: string;
      subject: string;
      createdAt: Date;
    }[];
  };
}

export class AdminService {
  /**
   * Fast, lightweight endpoint for badge counts.
   */
  static async getCounts(): Promise<AdminCountsResponse> {
    const [pendingBookings, pendingTechnicians, newContacts, pendingFeedback, unassignedBookings] =
      await Promise.all([
        Booking.countDocuments({ status: 'pending', isDeleted: { $ne: true }, deletedAt: null }),
        TechnicianProfile.countDocuments({ verificationStatus: 'pending_review' }),
        Contact.countDocuments({ status: { $regex: /^new$/i } }),
        Feedback.countDocuments({ status: 'pending' }),
        Booking.countDocuments({
          status: 'confirmed',
          $or: [
            { technicianId: null },
            { 'assignment.technicianUserId': null },
            { 'assignment.technicianUserId': { $exists: false } },
          ],
          deletedAt: null,
          isDeleted: { $ne: true },
        }),
      ]);

    return {
      pendingBookings,
      pendingTechnicians,
      newContacts,
      pendingFeedback,
      unassignedBookings,
    };
  }

  /**
   * Comprehensive overview analytics with role-based revenue filtering.
   */
  static async getOverview(
    rangeStr: '7d' | '30d' | '90d',
    isAdmin: boolean
  ): Promise<AdminOverviewResponse> {
    const timezone = process.env.BUSINESS_TIMEZONE || 'America/New_York';
    const now = new Date();
    const todayLocal = utcToLocal(now, timezone).date; // "YYYY-MM-DD"
    const startOfTodayUtc = localToUtc(todayLocal, '00:00', timezone);
    const startOfTomorrowUtc = new Date(startOfTodayUtc.getTime() + 24 * 60 * 60 * 1000);

    const rangeDays = rangeStr === '90d' ? 90 : rangeStr === '30d' ? 30 : 7;
    const startOfRangeUtc = new Date(
      startOfTodayUtc.getTime() - (rangeDays - 1) * 24 * 60 * 60 * 1000
    );

    // Concurrently fetch counts and KPIs
    const [
      counts,
      bookingsToday,
      upcomingBookings,
      newCustomers,
      bookingsInRange,
      topServicesAgg,
      recentBookingsDocs,
      recentTechDocs,
      recentContactDocs,
    ] = await Promise.all([
      this.getCounts(),

      // Bookings today
      Booking.countDocuments({
        scheduledAt: { $gte: startOfTodayUtc, $lt: startOfTomorrowUtc },
        isDeleted: { $ne: true },
      }),

      // Upcoming active bookings
      Booking.countDocuments({
        scheduledAt: { $gte: now },
        status: { $in: ['pending', 'confirmed'] },
        isDeleted: { $ne: true },
      }),

      // New customers in range
      User.countDocuments({
        role: 'customer',
        createdAt: { $gte: startOfRangeUtc },
      }),

      // Bookings in range (for status breakdown, daily trend, and revenue)
      Booking.find({
        scheduledAt: { $gte: startOfRangeUtc, $lt: startOfTomorrowUtc },
        isDeleted: { $ne: true },
      })
        .select('status scheduledAt scheduledLocal pricing.totalCents')
        .lean(),

      // Top services in range
      Booking.aggregate([
        {
          $match: {
            scheduledAt: { $gte: startOfRangeUtc, $lt: startOfTomorrowUtc },
            isDeleted: { $ne: true },
            status: { $nin: ['cancelled'] },
          },
        },
        {
          $group: {
            _id: '$serviceSnapshot.name',
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 5 },
        { $project: { _id: 0, name: '$_id', count: 1 } },
      ]),

      // Recent 5 bookings
      Booking.find({ isDeleted: { $ne: true } })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('_id bookingNumber guest.fullName scheduledAt scheduledLocal status pricing.totalCents')
        .lean(),

      // Recent 5 tech applications
      TechnicianProfile.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select('_id displayName verificationStatus createdAt')
        .lean(),

      // Recent 5 contacts
      Contact.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select('_id fullName subject createdAt')
        .lean(),
    ]);

    // Calculate booked and paid value in range (excluding cancelled and soft-deleted)
    let bookedValueCentsTotal = 0;
    let paidValueCentsTotal = 0;
    const statusCountsMap: Record<string, number> = {};
    const dailyMap: Record<string, { bookings: number; bookedValueCents: number }> = {};

    // Initialize daily buckets in business timezone
    for (let i = rangeDays - 1; i >= 0; i--) {
      const dayDate = new Date(startOfTodayUtc.getTime() - i * 24 * 60 * 60 * 1000);
      const localDayStr = utcToLocal(dayDate, timezone).date;
      dailyMap[localDayStr] = { bookings: 0, bookedValueCents: 0 };
    }

    for (const b of bookingsInRange) {
      // Status breakdown
      const status = b.status || 'pending';
      statusCountsMap[status] = (statusCountsMap[status] || 0) + 1;

      // Daily trend bucket
      const bDateStr = b.scheduledLocal?.date || (b.scheduledAt ? utcToLocal(new Date(b.scheduledAt), timezone).date : null);
      if (bDateStr && dailyMap[bDateStr]) {
        dailyMap[bDateStr].bookings += 1;
        if (b.status !== 'cancelled' && b.status !== 'no_show') {
          const cents = b.pricing?.totalCents || 0;
          dailyMap[bDateStr].bookedValueCents += cents;
        }
      }

      // Total booked value
      if (b.status !== 'cancelled' && b.status !== 'no_show') {
        bookedValueCentsTotal += b.pricing?.totalCents || 0;
      }

      // Total paid value
      if (b.paymentStatus === 'paid') {
        paidValueCentsTotal += b.pricing?.totalCents || 0;
      }
    }

    const bookingsByStatus = Object.entries(statusCountsMap).map(([status, count]) => ({
      status,
      count,
    }));

    const dailyTrend = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, val]) => {
        const item: { date: string; bookings: number; bookedValueCents?: number } = {
          date,
          bookings: val.bookings,
        };
        if (isAdmin) {
          item.bookedValueCents = val.bookedValueCents;
        }
        return item;
      });

    const kpis: AdminOverviewResponse['kpis'] = {
      bookingsToday,
      upcomingBookings,
      pendingBookings: counts.pendingBookings,
      pendingTechnicians: counts.pendingTechnicians,
      newContacts: counts.newContacts,
      pendingFeedback: counts.pendingFeedback,
      unassignedBookings: counts.unassignedBookings,
      newCustomers,
    };

    if (isAdmin) {
      kpis.bookedValueCents = bookedValueCentsTotal;
      kpis.paidValueCents = paidValueCentsTotal;
    }

    const recentBookings = recentBookingsDocs.map((b) => {
      const item: {
        _id: string;
        bookingNumber: string;
        guest: { fullName: string };
        scheduledAt: Date;
        scheduledLocal?: { date: string; slot: string };
        status: string;
        bookedValueCents?: number;
      } = {
        _id: b._id.toString(),
        bookingNumber: b.bookingNumber,
        guest: { fullName: b.guest?.fullName || 'Guest' },
        scheduledAt: b.scheduledAt,
        scheduledLocal: b.scheduledLocal,
        status: b.status,
      };
      if (isAdmin) {
        item.bookedValueCents = b.pricing?.totalCents || 0;
      }
      return item;
    });

    const recentTechnicians = recentTechDocs.map((t) => ({
      _id: t._id.toString(),
      displayName: t.displayName || 'Technician',
      verificationStatus: t.verificationStatus,
      createdAt: t.createdAt,
    }));

    const recentContacts = recentContactDocs.map((c) => ({
      _id: c._id.toString(),
      name: c.fullName || 'Anonymous',
      subject: c.subject,
      createdAt: c.createdAt,
    }));

    return {
      kpis,
      bookingsByStatus,
      dailyTrend,
      topServices: topServicesAgg.map((s: { name?: string; count: number }) => ({
        name: s.name || 'General Service',
        count: s.count,
      })),
      recent: {
        bookings: recentBookings,
        technicianApplications: recentTechnicians,
        contacts: recentContacts,
      },
    };
  }
}
