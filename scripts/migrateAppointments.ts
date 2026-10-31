import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDB } from '../config/database';
import logger from '../config/logger';
import { assertApplyConfirmation, getDbName } from './_scriptGuard';
import { Appointment, IAppointment } from '../models/Appointment';
import { Booking, IBooking, BookingStatus } from '../models/Booking';
import { Service } from '../models/Service';
import { ServiceCategory } from '../models/ServiceCategory';
import { User } from '../models/User';
import { BookingSettings } from '../models/BookingSettings';
import {
  AvailabilityService,
  localToUtc,
  normalizeSlotTo24h,
} from '../modules/bookings/availability';
import { normalizeVehicleCategory } from '../modules/bookings/pricing';

export interface MigrationOptions {
  apply?: boolean;
  dryRun?: boolean;
  limit?: number;
  confirmHost?: string;
}

export interface UnmappableRecord {
  appointmentId: string;
  reason: string;
}

export interface MigrationReport {
  timestamp: string;
  mode: 'dry-run' | 'apply';
  businessTimezone: string;
  totalAppointments: number;
  migrated: number;
  skipped: number;
  unmappable: number;
  futureSlotsReserved: number;
  capacityExceededCount: number;
  unmappableRecords: UnmappableRecord[];
}

export async function migrateAppointments(options: MigrationOptions = {}): Promise<MigrationReport> {
  const businessTimezone = process.env.BUSINESS_TIMEZONE;
  if (!businessTimezone || !businessTimezone.trim()) {
    throw new Error(
      'BUSINESS_TIMEZONE environment variable must be set to run the appointments migration script.'
    );
  }

  // Default is strictly dry-run unless --apply is explicitly specified
  const isCli = process.argv.includes('--apply');
  const apply = options.apply ?? isCli;
  const dryRun = options.dryRun !== undefined ? options.dryRun : !apply;
  const mode: 'dry-run' | 'apply' = dryRun ? 'dry-run' : 'apply';

  if (isCli || options.confirmHost) {
    const rawUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    const confirmHostArg =
      options.confirmHost ||
      process.argv
        .find((arg) => arg.startsWith('--confirm-host='))
        ?.split('=')[1];
    const { dbName } = assertApplyConfirmation(rawUri, confirmHostArg);
    console.log(`[migrateAppointments] Target database: ${dbName}`);
  }

  // Support --limit N
  const limitArgIndex = process.argv.indexOf('--limit');
  const cliLimit =
    limitArgIndex !== -1 && process.argv[limitArgIndex + 1]
      ? parseInt(process.argv[limitArgIndex + 1], 10)
      : undefined;
  const limit = options.limit ?? cliLimit;

  logger.info({ mode, businessTimezone, limit: limit ?? 'none' }, 'Starting appointments migration...');

  await connectDB();

  // Load appointments (with optional limit)
  let appointments = await Appointment.find().lean();
  if (typeof limit === 'number' && limit > 0) {
    appointments = appointments.slice(0, limit);
  }

  // Pre-load active services and categories
  const services = await Service.find({ isActive: true }).lean();
  const serviceCategories = await ServiceCategory.find().lean();
  const catMap = new Map<string, any>();
  for (const c of serviceCategories) {
    catMap.set(c._id.toString(), c);
  }

  // Pre-load verified users
  const verifiedUsers = await User.find({ emailVerified: true }).lean();
  const userByEmail = new Map<string, any>();
  for (const u of verifiedUsers) {
    userByEmail.set(u.email.toLowerCase(), u);
  }

  const report: MigrationReport = {
    timestamp: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'apply',
    businessTimezone,
    totalAppointments: appointments.length,
    migrated: 0,
    skipped: 0,
    unmappable: 0,
    futureSlotsReserved: 0,
    capacityExceededCount: 0,
    unmappableRecords: [],
  };

  const now = new Date();

  for (const appt of appointments) {
    const apptId = (appt._id as any).toString();

    // 1. Idempotency check: skip already migrated
    const existing = await Booking.findOne({ legacyAppointmentId: appt._id });
    if (existing) {
      report.skipped++;
      logger.info({ appointmentId: apptId }, 'Skipping: already migrated');
      continue;
    }

    // 2. Service mapping
    const rawServiceType = (appt.serviceType || '').trim();
    const service = services.find(
      (s) =>
        s.name.toLowerCase() === rawServiceType.toLowerCase() ||
        s.slug.toLowerCase() === rawServiceType.toLowerCase()
    );

    if (!service) {
      report.unmappable++;
      report.unmappableRecords.push({
        appointmentId: apptId,
        reason: `Unknown or inactive service: '${rawServiceType}'`,
      });
      continue;
    }

    // 3. Vehicle category mapping
    const rawCategory = (appt.vehicleCategory || '').trim();
    let vehicleCatSlug = '';
    try {
      vehicleCatSlug = normalizeVehicleCategory(rawCategory);
      if (!['sedan', 'crossover', 'suv', 'truck', 'rv-boat-semi'].includes(vehicleCatSlug)) {
        throw new Error('Unsupported slug');
      }
    } catch {
      report.unmappable++;
      report.unmappableRecords.push({
        appointmentId: apptId,
        reason: `Unknown vehicle category: '${rawCategory}'`,
      });
      continue;
    }

    // 4. Date and timeSlot parsing
    const dateStr = (appt.date || '').trim();
    const timeSlotStr = (appt.timeSlot || '').trim();
    if (!dateStr || !timeSlotStr) {
      report.unmappable++;
      report.unmappableRecords.push({
        appointmentId: apptId,
        reason: 'Missing date or timeSlot',
      });
      continue;
    }

    const slot24 = normalizeSlotTo24h(timeSlotStr);
    let scheduledAt: Date;
    try {
      scheduledAt = localToUtc(dateStr, slot24, businessTimezone);
      if (isNaN(scheduledAt.getTime())) throw new Error('Invalid Date');
    } catch {
      report.unmappable++;
      report.unmappableRecords.push({
        appointmentId: apptId,
        reason: `Unparseable date/time: '${dateStr} ${timeSlotStr}'`,
      });
      continue;
    }

    // 5. Status mapping
    const rawStatus = (appt.status || 'Pending').toLowerCase();
    const status: BookingStatus =
      rawStatus === 'confirmed'
        ? 'confirmed'
        : rawStatus === 'completed'
        ? 'completed'
        : rawStatus === 'cancelled'
        ? 'cancelled'
        : 'pending';

    // 6. Verified user customer linking
    const customer = appt.email ? userByEmail.get(appt.email.toLowerCase()) : null;
    const customerId = customer ? customer._id : null;

    // 7. Dollars to cents conversions
    const baseCents = Math.round((appt.basePrice || 0) * 100);
    const discountCents = Math.round((appt.totalDiscount || 0) * 100);
    const totalCents = Math.round((appt.totalPrice || 0) * 100);

    const bookingNumber = `GIS-MIG-${apptId.slice(-6).toUpperCase()}`;

    const isFutureActive =
      scheduledAt > now && (status === 'pending' || status === 'confirmed');

    if (isFutureActive) {
      if (!dryRun) {
        try {
          await AvailabilityService.reserveSlotAtomic(
            dateStr,
            slot24,
            service.categoryId as mongoose.Types.ObjectId
          );
          report.futureSlotsReserved++;
        } catch (slotErr) {
          report.capacityExceededCount++;
          logger.warn(
            { appointmentId: apptId, date: dateStr, slot: slot24 },
            'Migrated future booking exceeds current slot capacity'
          );
        }
      } else {
        report.futureSlotsReserved++;
      }
    }

    if (!dryRun) {
      await Booking.create({
        bookingNumber,
        customerId,
        guest: {
          fullName: appt.fullName || 'Legacy Customer',
          email: appt.email ? appt.email.toLowerCase() : '',
          phone: appt.phone || '',
        },
        vehicleSnapshot: {
          category: vehicleCatSlug,
          make: appt.make || 'Unknown',
          model: appt.vehicleModel || 'Unknown',
          year: Number(appt.year) || new Date().getFullYear(),
        },
        categoryId: service.categoryId,
        serviceId: service._id,
        serviceSnapshot: {
          name: service.name,
          slug: service.slug,
        },
        addons: (appt.addons || []).map((a: any) => ({
          name: a.name,
          priceCents: Math.round((a.price || 0) * 100),
        })),
        address: {
          freeText: appt.address || '',
          country: 'USA',
        },
        scheduledAt,
        scheduledLocal: {
          date: dateStr,
          slot: slot24,
        },
        timezone: businessTimezone,
        isAsap: false,
        status,
        statusHistory: [
          {
            status,
            by: 'legacy-migration',
            at: appt.createdAt || new Date(),
            note: 'Migrated from legacy appointments collection',
          },
        ],
        pricing: {
          baseCents,
          addonsCents: Math.max(0, totalCents + discountCents - baseCents),
          discountCents,
          couponCode: appt.promoCode || (appt.coupons?.[0]?.code ?? null),
          couponPercent: appt.coupons?.[0]?.discountPercentage || 0,
          taxCents: 0,
          totalCents,
          commissionPercent: 15,
          processingPercent: 3,
          commissionCents: Math.round((totalCents * 15) / 100),
          processingCents: Math.round((totalCents * 3) / 100),
          providerPayoutCents: Math.max(0, totalCents - Math.round((totalCents * 18) / 100)),
        },
        paymentStatus: 'unpaid',
        source: 'legacy-migration',
        legacyAppointmentId: appt._id,
        deletedAt: null,
      });
    }

    report.migrated++;
  }

  // Write migration report JSON
  const outDir = path.resolve(__dirname, 'out');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const reportPath = path.join(outDir, 'migration-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  logger.info({ reportPath, report }, 'Migration completed and report saved');

  console.log('\n--- Appointments Migration Summary ---');
  console.table([
    { Metric: 'Execution Mode', Value: report.mode },
    { Metric: 'Business Timezone', Value: report.businessTimezone },
    { Metric: 'Total Appointments Evaluated', Value: report.totalAppointments },
    { Metric: 'Successfully Migrated', Value: report.migrated },
    { Metric: 'Skipped (Already Migrated)', Value: report.skipped },
    { Metric: 'Unmappable Records', Value: report.unmappable },
    { Metric: 'Future Slots Reserved', Value: report.futureSlotsReserved },
    { Metric: 'Capacity Exceeded Warnings', Value: report.capacityExceededCount },
  ]);

  if (report.unmappableRecords.length > 0) {
    console.log('\n--- Unmappable Records ---');
    console.table(
      report.unmappableRecords.map((r) => ({
        'Appointment ID': r.appointmentId,
        Reason: r.reason,
      }))
    );
  }

  return report;
}

if (require.main === module) {
  migrateAppointments()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
