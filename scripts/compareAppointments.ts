import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDB } from '../config/database';
import logger from '../config/logger';
import { Appointment } from '../models/Appointment';
import { Booking } from '../models/Booking';

export interface ComparisonReport {
  timestamp: string;
  totalAppointments: number;
  totalMigratedBookings: number;
  unmigratedCount: number;
  totals: {
    oldSumCents: number;
    newSumCents: number;
    differenceCents: number;
  };
  statusBreakdown: {
    status: string;
    appointmentsCount: number;
    bookingsCount: number;
    match: boolean;
  }[];
  unmigratedIds: string[];
}

export async function compareAppointments(): Promise<ComparisonReport> {
  await connectDB();
  logger.info('Comparing legacy appointments vs migrated bookings...');

  const appointments = await Appointment.find().lean();
  const bookings = await Booking.find({ legacyAppointmentId: { $ne: null } }).lean();

  const migratedMap = new Map<string, any>();
  for (const b of bookings) {
    if (b.legacyAppointmentId) {
      migratedMap.set(b.legacyAppointmentId.toString(), b);
    }
  }

  // 1. Sum calculations
  let oldSumCents = 0;
  for (const a of appointments) {
    oldSumCents += Math.round((a.totalPrice || 0) * 100);
  }

  let newSumCents = 0;
  for (const b of bookings) {
    newSumCents += b.pricing?.totalCents || 0;
  }

  // 2. Status counts
  const apptStatusCounts: Record<string, number> = {
    pending: 0,
    confirmed: 0,
    completed: 0,
    cancelled: 0,
  };

  const unmigratedIds: string[] = [];

  for (const a of appointments) {
    const s = (a.status || 'Pending').toLowerCase();
    apptStatusCounts[s] = (apptStatusCounts[s] || 0) + 1;
    const aId = (a._id as any).toString();
    if (!migratedMap.has(aId)) {
      unmigratedIds.push(aId);
    }
  }

  const bookingStatusCounts: Record<string, number> = {
    pending: 0,
    confirmed: 0,
    completed: 0,
    cancelled: 0,
  };

  for (const b of bookings) {
    const s = (b.status || 'pending').toLowerCase();
    bookingStatusCounts[s] = (bookingStatusCounts[s] || 0) + 1;
  }

  const statusBreakdown = ['pending', 'confirmed', 'completed', 'cancelled'].map((status) => {
    const apptCount = apptStatusCounts[status] || 0;
    const bookCount = bookingStatusCounts[status] || 0;
    return {
      status,
      appointmentsCount: apptCount,
      bookingsCount: bookCount,
      match: apptCount === bookCount,
    };
  });

  const report: ComparisonReport = {
    timestamp: new Date().toISOString(),
    totalAppointments: appointments.length,
    totalMigratedBookings: bookings.length,
    unmigratedCount: unmigratedIds.length,
    totals: {
      oldSumCents,
      newSumCents,
      differenceCents: newSumCents - oldSumCents,
    },
    statusBreakdown,
    unmigratedIds,
  };

  console.log('\n======================================================');
  console.log(' APPOINTMENTS VS MIGRATED BOOKINGS COMPARISON REPORT ');
  console.log('======================================================');

  console.table([
    {
      Metric: 'Total Records',
      Appointments: report.totalAppointments,
      Bookings: report.totalMigratedBookings,
      Difference: report.totalAppointments - report.totalMigratedBookings,
    },
    {
      Metric: 'Total Sum (USD $)',
      Appointments: `$${(report.totals.oldSumCents / 100).toFixed(2)}`,
      Bookings: `$${(report.totals.newSumCents / 100).toFixed(2)}`,
      Difference: `$${(report.totals.differenceCents / 100).toFixed(2)}`,
    },
  ]);

  console.log('\nStatus Breakdown:');
  console.table(
    statusBreakdown.map((s) => ({
      Status: s.status,
      'Old Appointments': s.appointmentsCount,
      'Migrated Bookings': s.bookingsCount,
      Match: s.match ? 'YES' : 'DIFF',
    }))
  );

  if (unmigratedIds.length > 0) {
    console.warn(`\nWarning: ${unmigratedIds.length} appointments have not been migrated yet.`);
  } else {
    console.log('\nAll appointments have been successfully migrated.');
  }

  return report;
}

if (require.main === module) {
  compareAppointments()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Comparison script failed:', err);
      process.exit(1);
    });
}
