/**
 * seedDemoData.ts
 * ---------------
 * Populates the GIS development database with realistic, fully cross-referenced
 * demo records for all four portals (customer, technician, supplier, admin).
 *
 * IDEMPOTENT: Safe to run multiple times — uses upsert/findOneAndUpdate patterns.
 * SAFETY:     Requires --allow-remote flag to run against a remote MongoDB host.
 * DEMO ONLY:  Never run against production. All orders remain paymentStatus:'unpaid'.
 *
 * Usage:
 *   npm --prefix backend run seed:demo -- --allow-remote
 */

import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDB } from '../config/database';
import { assertScriptSafety } from './_scriptGuard';
import { User } from '../models/User';
import { CustomerProfile } from '../models/CustomerProfile';
import { Vehicle } from '../models/Vehicle';
import { Booking } from '../models/Booking';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { SupplierProfile } from '../models/SupplierProfile';
import { PartProduct } from '../models/PartProduct';
import { PartOrder } from '../models/PartOrder';
import { Payout } from '../models/Payout';

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const allowRemote = args.includes('--allow-remote');
const dryRun = args.includes('--dry-run');

// ─── Known demo account IDs (from DB) ────────────────────────────────────────
const CUSTOMER_USER_ID = new mongoose.Types.ObjectId('6ae6223a2f30276f95ad58c3');
const TECHNICIAN_USER_ID = new mongoose.Types.ObjectId('6ae6223b2f30276f95ad58c4');
const SUPPLIER_USER_ID = new mongoose.Types.ObjectId('6ae6223b2f30276f95ad58c6');
const TECH_PROFILE_ID = new mongoose.Types.ObjectId('6ae6223b2f30276f95ad58c5');
const SUPPLIER_PROFILE_ID = new mongoose.Types.ObjectId('6ae6223c2f30276f95ad58c7');

// ─── Admin ID to use as "createdBy" for payouts ───────────────────────────────
// Use existing support admin
const ADMIN_USER_ID = new mongoose.Types.ObjectId('69ef1f451f48a701481e7c29');

// ─── Service category and service IDs (we will upsert these) ─────────────────
const SERVICE_CAT_ID = new mongoose.Types.ObjectId('7000000000000000000000a1');
const SERVICE_ID_OIL = new mongoose.Types.ObjectId('7000000000000000000000b1');
const SERVICE_ID_TYRES = new mongoose.Types.ObjectId('7000000000000000000000b2');
const SERVICE_ID_BRAKES = new mongoose.Types.ObjectId('7000000000000000000000b3');
const SERVICE_ID_BATTERY = new mongoose.Types.ObjectId('7000000000000000000000b4');

// ─── Booking IDs ──────────────────────────────────────────────────────────────
const BOOKING_COMPLETED_1 = new mongoose.Types.ObjectId('7100000000000000000000c1');
const BOOKING_COMPLETED_2 = new mongoose.Types.ObjectId('7100000000000000000000c2');
const BOOKING_CONFIRMED = new mongoose.Types.ObjectId('7100000000000000000000c3');
const BOOKING_PENDING = new mongoose.Types.ObjectId('7100000000000000000000c4');
const BOOKING_CANCELLED = new mongoose.Types.ObjectId('7100000000000000000000c5');

// ─── Vehicle IDs ──────────────────────────────────────────────────────────────
const VEHICLE_1_ID = new mongoose.Types.ObjectId('7200000000000000000000d1');
const VEHICLE_2_ID = new mongoose.Types.ObjectId('7200000000000000000000d2');
const VEHICLE_3_ID = new mongoose.Types.ObjectId('7200000000000000000000d3');

// ─── Part order IDs ───────────────────────────────────────────────────────────
const PART_ORDER_1 = new mongoose.Types.ObjectId('7300000000000000000000e1');
const PART_ORDER_2 = new mongoose.Types.ObjectId('7300000000000000000000e2');
const PART_ORDER_3 = new mongoose.Types.ObjectId('7300000000000000000000e3');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function dateToLocalSlot(d: Date): { date: string; slot: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    slot: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function nextBookingNumber(prefix: string): string {
  const rand = Math.floor(Math.random() * 900000) + 100000;
  return `${prefix}-${rand}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const uri = process.env.MONGODB_URI as string;
  if (!uri) throw new Error('MONGODB_URI is not set in environment.');

  const { maskedUri } = assertScriptSafety(uri, allowRemote, 'seedDemoData');
  console.log(`\n[seedDemoData] Connecting to: ${maskedUri}`);
  console.log(`[seedDemoData] Dry-run: ${dryRun}`);

  await connectDB();
  console.log('[seedDemoData] Connected.\n');

  // ─── Step 1: Fix customer@gis.com role ──────────────────────────────────────
  console.log('→ Step 1: Fix customer@gis.com role ...');
  if (!dryRun) {
    const customerFix = await User.findByIdAndUpdate(
      CUSTOMER_USER_ID,
      {
        $set: {
          role: 'customer',
          status: 'active',
          isActive: true,
          emailVerified: true,
          phoneVerified: true,
        },
      },
      { returnDocument: 'after' }
    );
    if (!customerFix) {
      console.error('  ✗ customer@gis.com not found! Check ID.');
    } else {
      console.log(`  ✓ customer@gis.com role=${customerFix.role} status=${customerFix.status}`);
    }

    // Remove the stray technician profile created when customer applied
    await (TechnicianProfile as any).deleteOne({
      userId: CUSTOMER_USER_ID,
      _id: { $ne: TECH_PROFILE_ID },
    });
    console.log('  ✓ Removed stray technician profile for customer (if any)');
  } else {
    console.log('  [dry-run] Would fix customer@gis.com role to customer/active');
  }

  // ─── Step 2: Create admin@gis.com & admin2@gis.com demo accounts ───────────
  console.log('\n→ Step 2: Upsert admin demo accounts ...');
  if (!dryRun) {
    const adminPassword = await bcrypt.hash('Admin123!', 10);
    const adminUser = await (User as any).findOneAndUpdate(
      { email: 'admin@gis.com' },
      {
        $setOnInsert: {
          email: 'admin@gis.com',
          password: adminPassword,
          fullName: 'Demo Admin',
          role: 'admin',
          status: 'active',
          isActive: true,
          emailVerified: true,
          phoneVerified: false,
          phone: '+1-555-000-0001',
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    console.log(`  ✓ admin@gis.com: _id=${adminUser._id} role=${adminUser.role}`);

    const adminUser2 = await (User as any).findOneAndUpdate(
      { email: 'admin2@gis.com' },
      {
        $setOnInsert: {
          email: 'admin2@gis.com',
          password: adminPassword,
          fullName: 'GIS Operations Admin',
          role: 'admin',
          status: 'active',
          isActive: true,
          emailVerified: true,
          phoneVerified: true,
          phone: '+1-555-000-0002',
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    console.log(`  ✓ admin2@gis.com: _id=${adminUser2._id} role=${adminUser2.role}`);
  } else {
    console.log('  [dry-run] Would upsert admin accounts');
  }

  // ─── Step 3: Seed service categories and services ───────────────────────────
  console.log('\n→ Step 3: Seed service categories + services ...');
  if (!dryRun) {
    const ServiceCategory = mongoose.model(
      'ServiceCategory',
      new mongoose.Schema(
        {
          name: String,
          slug: String,
          description: String,
          icon: String,
          isActive: { type: Boolean, default: true },
        },
        { timestamps: true, collection: 'serviceCategories' }
      )
    );

    await (ServiceCategory as any).findByIdAndUpdate(
      SERVICE_CAT_ID,
      {
        $setOnInsert: {
          _id: SERVICE_CAT_ID,
          name: 'Mobile Automotive Services',
          slug: 'mobile-auto',
          description: 'On-site vehicle servicing by certified technicians',
          icon: 'wrench',
          isActive: true,
        },
      },
      { upsert: true }
    );
    console.log('  ✓ ServiceCategory: Mobile Automotive Services');

    // Use a simpler Service model inline
    const Service = mongoose.models.Service || mongoose.model(
      'Service',
      new mongoose.Schema(
        {
          name: String,
          slug: String,
          description: String,
          categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCategory' },
          priceCents: { type: Number, default: 0 },
          durationMinutes: { type: Number, default: 60 },
          isActive: { type: Boolean, default: true },
        },
        { timestamps: true, collection: 'services' }
      )
    );

    const servicesData = [
      { _id: SERVICE_ID_OIL, name: 'Oil Change & Filter', slug: 'oil-change', priceCents: 8900, durationMinutes: 45 },
      { _id: SERVICE_ID_TYRES, name: 'Tyre Rotation & Balance', slug: 'tyre-rotation', priceCents: 6900, durationMinutes: 60 },
      { _id: SERVICE_ID_BRAKES, name: 'Brake Inspection & Service', slug: 'brake-service', priceCents: 14900, durationMinutes: 90 },
      { _id: SERVICE_ID_BATTERY, name: 'Battery Test & Replacement', slug: 'battery-service', priceCents: 11900, durationMinutes: 30 },
    ];

    for (const svc of servicesData) {
      await (Service as any).findByIdAndUpdate(
        svc._id,
        {
          $setOnInsert: {
            _id: svc._id,
            name: svc.name,
            slug: svc.slug,
            description: `Professional mobile ${svc.name.toLowerCase()} at your location.`,
            categoryId: SERVICE_CAT_ID,
            priceCents: svc.priceCents,
            durationMinutes: svc.durationMinutes,
            isActive: true,
          },
        },
        { upsert: true }
      );
      console.log(`  ✓ Service: ${svc.name}`);
    }
  } else {
    console.log('  [dry-run] Would seed 1 service category and 4 services');
  }

  // ─── Step 4: Customer profile and saved addresses ────────────────────────────
  console.log('\n→ Step 4: Upsert customer profile (addresses) ...');
  if (!dryRun) {
    await (CustomerProfile as any).findOneAndUpdate(
      { userId: CUSTOMER_USER_ID },
      {
        $setOnInsert: { userId: CUSTOMER_USER_ID },
        $set: {
          savedAddresses: [
            {
              label: 'Home',
              line1: '142 Maple Grove Drive',
              line2: '',
              city: 'Austin',
              state: 'TX',
              zip: '78701',
              country: 'USA',
              isDefault: true,
            },
            {
              label: 'Work',
              line1: '500 Congress Avenue',
              line2: 'Suite 1200',
              city: 'Austin',
              state: 'TX',
              zip: '78701',
              country: 'USA',
              isDefault: false,
            },
          ],
          notificationPreferences: { email: true, push: true, sms: true },
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    console.log('  ✓ CustomerProfile upserted with 2 saved addresses');
  } else {
    console.log('  [dry-run] Would upsert CustomerProfile');
  }

  // ─── Step 5: Vehicles ────────────────────────────────────────────────────────
  console.log('\n→ Step 5: Upsert customer vehicles ...');
  if (!dryRun) {
    const vehiclesData = [
      {
        _id: VEHICLE_1_ID,
        category: 'sedan' as const,
        make: 'Toyota',
        vehicleModel: 'Camry',
        year: 2021,
        color: 'Silver',
        plate: 'TX-ABC123',
        vin: '4T1B11HK0JU100001',
        isDefault: true,
      },
      {
        _id: VEHICLE_2_ID,
        category: 'suv' as const,
        make: 'Ford',
        vehicleModel: 'Explorer',
        year: 2019,
        color: 'Black',
        plate: 'TX-DEF456',
        vin: '1FM5K8D82KGB00002',
        isDefault: false,
      },
      {
        _id: VEHICLE_3_ID,
        category: 'truck' as const,
        make: 'Chevrolet',
        vehicleModel: 'Silverado 1500',
        year: 2022,
        color: 'White',
        plate: 'TX-GHI789',
        vin: '3GCUYDED4NG100003',
        isDefault: false,
      },
    ];

    for (const v of vehiclesData) {
      await (Vehicle as any).findByIdAndUpdate(
        v._id,
        {
          $setOnInsert: { _id: v._id, ownerUserId: CUSTOMER_USER_ID },
          $set: {
            category: v.category,
            make: v.make,
            vehicleModel: v.vehicleModel,
            year: v.year,
            color: v.color,
            plate: v.plate,
            vin: v.vin,
            isDefault: v.isDefault,
            deletedAt: null,
          },
        },
        { upsert: true }
      );
      console.log(`  ✓ Vehicle: ${v.year} ${v.make} ${v.vehicleModel}`);
    }
  } else {
    console.log('  [dry-run] Would upsert 3 vehicles');
  }

  // ─── Step 6: Bookings ────────────────────────────────────────────────────────
  console.log('\n→ Step 6: Upsert bookings ...');

  if (!dryRun) {
    const completedAt1 = daysAgo(30);
    const completedAt2 = daysAgo(14);
    const confirmedAt = daysFromNow(5);
    const pendingAt = daysFromNow(12);
    const cancelledAt = daysAgo(60);

    const bookingsData = [
      {
        _id: BOOKING_COMPLETED_1,
        bookingNumber: 'GIS-100001',
        status: 'completed' as const,
        serviceId: SERVICE_ID_OIL,
        serviceName: 'Oil Change & Filter',
        serviceSlug: 'oil-change',
        vehicleId: VEHICLE_1_ID,
        vehicleMake: 'Toyota',
        vehicleModel: 'Camry',
        vehicleYear: 2021,
        vehicleCategory: 'sedan' as const,
        scheduledAt: completedAt1,
        baseCents: 8900,
        totalCents: 8900,
        payoutCents: 7565,
        technicianId: TECHNICIAN_USER_ID,
        completedAt: completedAt1,
        notes: 'Synthetic oil used. Filter replaced. Customer very satisfied.',
      },
      {
        _id: BOOKING_COMPLETED_2,
        bookingNumber: 'GIS-100002',
        status: 'completed' as const,
        serviceId: SERVICE_ID_BRAKES,
        serviceName: 'Brake Inspection & Service',
        serviceSlug: 'brake-service',
        vehicleId: VEHICLE_2_ID,
        vehicleMake: 'Ford',
        vehicleModel: 'Explorer',
        vehicleYear: 2019,
        vehicleCategory: 'suv' as const,
        scheduledAt: completedAt2,
        baseCents: 14900,
        totalCents: 14900,
        payoutCents: 12665,
        technicianId: TECHNICIAN_USER_ID,
        completedAt: completedAt2,
        notes: 'Front brake pads replaced. Rotors resurfaced.',
      },
      {
        _id: BOOKING_CONFIRMED,
        bookingNumber: 'GIS-100003',
        // 'assigned' so the demo technician can see it in the Upcoming tab
        status: 'assigned' as const,
        serviceId: SERVICE_ID_TYRES,
        serviceName: 'Tyre Rotation & Balance',
        serviceSlug: 'tyre-rotation',
        vehicleId: VEHICLE_1_ID,
        vehicleMake: 'Toyota',
        vehicleModel: 'Camry',
        vehicleYear: 2021,
        vehicleCategory: 'sedan' as const,
        scheduledAt: confirmedAt,
        baseCents: 6900,
        totalCents: 6900,
        payoutCents: 5865,
        technicianId: TECHNICIAN_USER_ID,
        completedAt: null,
        notes: '',
      },
      {
        _id: BOOKING_PENDING,
        bookingNumber: 'GIS-100004',
        status: 'pending' as const,
        serviceId: SERVICE_ID_BATTERY,
        serviceName: 'Battery Test & Replacement',
        serviceSlug: 'battery-service',
        vehicleId: VEHICLE_3_ID,
        vehicleMake: 'Chevrolet',
        vehicleModel: 'Silverado 1500',
        vehicleYear: 2022,
        vehicleCategory: 'truck' as const,
        scheduledAt: pendingAt,
        baseCents: 11900,
        totalCents: 11900,
        payoutCents: 10115,
        technicianId: null,
        completedAt: null,
        notes: 'Battery cranking weak in cold weather.',
      },
      {
        _id: BOOKING_CANCELLED,
        bookingNumber: 'GIS-100005',
        status: 'cancelled' as const,
        serviceId: SERVICE_ID_OIL,
        serviceName: 'Oil Change & Filter',
        serviceSlug: 'oil-change',
        vehicleId: VEHICLE_2_ID,
        vehicleMake: 'Ford',
        vehicleModel: 'Explorer',
        vehicleYear: 2019,
        vehicleCategory: 'suv' as const,
        scheduledAt: cancelledAt,
        baseCents: 8900,
        totalCents: 8900,
        payoutCents: 0,
        technicianId: null,
        completedAt: null,
        notes: 'Customer cancelled — rescheduled.',
      },
    ];

    for (const b of bookingsData) {
      const localSlot = dateToLocalSlot(b.scheduledAt);
      const commissionCents = Math.round(b.baseCents * 0.15);
      const processingCents = Math.round(b.baseCents * 0.03);
      const providerPayoutCents = b.baseCents - commissionCents - processingCents;

      const statusHistory: Array<{ status: string; by: string; at: Date; note?: string }> = [
        { status: 'pending', by: 'customer', at: daysAgo(b.status === 'cancelled' ? 65 : 35) },
      ];
      if (b.status !== 'pending' && b.status !== 'cancelled') {
        const targetStatus: string = b.status;
        statusHistory.push({ status: 'confirmed', by: 'admin', at: daysAgo(targetStatus === 'assigned' ? 4 : targetStatus === 'confirmed' ? 3 : 34) });
      }
      if (b.status === 'assigned') {
        statusHistory.push({ status: 'assigned', by: 'admin', at: daysAgo(3) });
      }
      if (b.status === 'completed') {
        statusHistory.push(
          { status: 'assigned', by: 'admin', at: daysAgo(28) },
          { status: 'technician_en_route', by: 'technician', at: b.scheduledAt },
          { status: 'arrived', by: 'technician', at: new Date(b.scheduledAt.getTime() + 10 * 60000) },
          { status: 'in_progress', by: 'technician', at: new Date(b.scheduledAt.getTime() + 15 * 60000) },
          { status: 'completed', by: 'technician', at: b.completedAt! }
        );
      }
      if (b.status === 'cancelled') {
        statusHistory.push({ status: 'cancelled', by: 'customer', at: daysAgo(58), note: 'Customer request' });
      }

      // Use raw collection to bypass Mongoose schema defaults that would
      // set location.coordinates=[] and break the 2dsphere sparse index.
      const bookingsColl = mongoose.connection.db!.collection('bookings');

      // Build the assignment object
      const assignmentObj = b.technicianId
        ? {
            technicianUserId: b.technicianId,
            assignedAt: daysAgo(28),
            assignedBy: 'admin',
            acceptedAt: daysAgo(27),
          }
        : null;

      await bookingsColl.updateOne(
        { _id: b._id as any },
        {
          $setOnInsert: { _id: b._id },
          $set: {
            bookingNumber: b.bookingNumber,
            customerId: CUSTOMER_USER_ID,
            vehicleId: b.vehicleId,
            vehicleSnapshot: {
              category: b.vehicleCategory,
              make: b.vehicleMake,
              model: b.vehicleModel,
              year: b.vehicleYear,
            },
            categoryId: SERVICE_CAT_ID,
            serviceId: b.serviceId,
            serviceSnapshot: { name: b.serviceName, slug: b.serviceSlug },
            addons: [],
            address: {
              line1: '142 Maple Grove Drive',
              city: 'Austin',
              state: 'TX',
              zip: '78701',
              country: 'USA',
            },
            scheduledAt: b.scheduledAt,
            scheduledLocal: localSlot,
            timezone: 'America/Chicago',
            isAsap: false,
            status: b.status,
            statusHistory,
            pricing: {
              baseCents: b.baseCents,
              addonsCents: 0,
              discountCents: 0,
              couponCode: null,
              couponPercent: 0,
              taxCents: 0,
              totalCents: b.totalCents,
              commissionPercent: 15,
              processingPercent: 3,
              commissionCents,
              processingCents,
              providerPayoutCents,
            },
            paymentStatus: 'unpaid',
            technicianId: b.technicianId,
            assignment: assignmentObj,
            dispatch: { status: 'none', attempts: 0 },
            ...(b.completedAt ? { completedAt: b.completedAt } : {}),
            ...(b.status === 'completed'
              ? {
                  completion: {
                    notes: b.notes,
                    checklist: [
                      { label: 'Job completed as specified', done: true },
                      { label: 'Customer sign-off obtained', done: true },
                    ],
                  },
                }
              : {}),
            notes: b.notes,
            source: 'web',
            deletedAt: null,
            createdAt: b.scheduledAt,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
      console.log(`  ✓ Booking ${b.bookingNumber} [${b.status}]`);
    }
  } else {
    console.log('  [dry-run] Would upsert 5 bookings');
  }

  // ─── Step 7: Update TechnicianProfile ────────────────────────────────────────
  console.log('\n→ Step 7: Update technician profile with skills, area, schedule, stats ...');
  if (!dryRun) {
    await (TechnicianProfile as any).findByIdAndUpdate(
      TECH_PROFILE_ID,
      {
        $set: {
          displayName: 'Marcus Rivera',
          bio: 'ASE-certified mobile technician with 8 years of experience. Specialising in oil changes, brake services, battery replacements and general maintenance. Fast, reliable and always on time.',
          phone: '+1-512-555-0101',
          photoUrl: 'https://randomuser.me/api/portraits/men/32.jpg',
          skills: {
            categoryIds: [SERVICE_CAT_ID],
            serviceIds: [SERVICE_ID_OIL, SERVICE_ID_TYRES, SERVICE_ID_BRAKES, SERVICE_ID_BATTERY],
          },
          serviceArea: {
            zipCodes: ['78701', '78702', '78703', '78704', '78705', '78711', '78712', '78713'],
            center: { type: 'Point', coordinates: [-97.7431, 30.2672] },
            radiusKm: 30,
            city: 'Austin',
            state: 'TX',
          },
          vehicleInfo: { type: 'Van', plate: 'TX-TECH01', capacity: '400kg' },
          verificationStatus: 'approved',
          availability: {
            isOnline: true,
            weeklySchedule: [
              { day: 'mon', from: '08:00', to: '18:00' },
              { day: 'tue', from: '08:00', to: '18:00' },
              { day: 'wed', from: '08:00', to: '18:00' },
              { day: 'thu', from: '08:00', to: '18:00' },
              { day: 'fri', from: '08:00', to: '17:00' },
              { day: 'sat', from: '09:00', to: '14:00' },
            ],
            timeOff: [],
          },
          rating: { avg: 4.9, count: 47 },
          stats: { jobsCompleted: 47, acceptanceRate: 96 },
          activeSchedule: [
            {
              bookingId: BOOKING_CONFIRMED,
              start: daysFromNow(5),
              end: new Date(daysFromNow(5).getTime() + 60 * 60000),
            },
          ],
          payoutDetails: { method: 'bank', bankName: 'Chase Bank', lastFour: '4242' },
          statusHistory: [
            { status: 'draft', by: 'system', at: daysAgo(180) },
            { status: 'pending_review', by: 'technician@gis.com', at: daysAgo(170) },
            { status: 'approved', by: 'admin', at: daysAgo(160) },
          ],
        },
      },
      { returnDocument: 'after' }
    );
    console.log('  ✓ TechnicianProfile updated (Marcus Rivera, approved, 8 skills)');
  } else {
    console.log('  [dry-run] Would update TechnicianProfile');
  }

  // ─── Step 8: Technician payout record ────────────────────────────────────────
  console.log('\n→ Step 8: Upsert technician payout record ...');
  if (!dryRun) {
    const PAYOUT_ID = new mongoose.Types.ObjectId('7400000000000000000000f1');
    const gross = 7565 + 12665; // two completed bookings providerPayout
    await (Payout as any).findByIdAndUpdate(
      PAYOUT_ID,
      {
        $setOnInsert: {
          _id: PAYOUT_ID,
          technicianUserId: TECHNICIAN_USER_ID,
          status: 'draft',
          bookingIds: [BOOKING_COMPLETED_1, BOOKING_COMPLETED_2],
          grossCents: gross,
          adjustmentsCents: 0,
          netCents: gross,
          createdBy: ADMIN_USER_ID,
          notes: 'Demo payout covering first two completed jobs.',
          history: [
            { action: 'created', by: 'admin', at: daysAgo(7) },
          ],
        },
      },
      { upsert: true }
    );
    console.log(`  ✓ Payout draft for technician: \$${(gross / 100).toFixed(2)}`);
  } else {
    console.log('  [dry-run] Would upsert payout record');
  }

  // ─── Step 9: Supplier profile enrichment ─────────────────────────────────────
  console.log('\n→ Step 9: Enrich supplier profile ...');
  if (!dryRun) {
    await (SupplierProfile as any).findByIdAndUpdate(
      SUPPLIER_PROFILE_ID,
      {
        $set: {
          companyName: 'Apex OEM Auto Supply',
          businessType: 'distributor',
          taxId: '47-1234567',
          website: 'https://apexauto.example.com',
          description:
            'Apex OEM Auto Supply is a trusted distributor of original-equipment and aftermarket automotive parts. We supply brakes, engines, batteries, tyres and more to workshops and direct consumers across the US.',
          categories: ['brakes', 'engine', 'batteries', 'tyres', 'suspension', 'electrical', 'filters', 'cooling', 'body'],
          contactPerson: {
            name: 'James Thornton',
            title: 'Sales Director',
            email: 'james.thornton@apexauto.example.com',
            phone: '+1-469-555-0202',
          },
          businessPhone: '+1-469-555-0200',
          supportEmail: 'support@apexauto.example.com',
          businessAddress: {
            street: '3801 Commerce Street',
            city: 'Dallas',
            state: 'TX',
            zipCode: '75226',
            country: 'US',
          },
          verificationStatus: 'approved',
          statusHistory: [
            { status: 'draft', by: 'system', at: daysAgo(120) },
            { status: 'pending_review', by: 'supplier@gis.com', at: daysAgo(110) },
            { status: 'approved', by: 'admin', at: daysAgo(100) },
          ],
        },
      },
      { returnDocument: 'after' }
    );
    console.log('  ✓ SupplierProfile enriched (Apex OEM Auto Supply, approved)');
  } else {
    console.log('  [dry-run] Would enrich SupplierProfile');
  }

  // ─── Step 10: Create part orders referencing real products ───────────────────
  console.log('\n→ Step 10: Upsert demo part orders ...');
  if (!dryRun) {
    // Get some real product IDs from DB
    const products = await (PartProduct as any)
      .find({ status: 'active' }, { _id: 1, name: 1, priceCents: 1, sku: 1 })
      .limit(6)
      .lean();

    if (products.length < 2) {
      console.warn('  ⚠ Not enough active products found — run seed:parts first.');
    } else {
      const p1 = products[0];
      const p2 = products[1];
      const p3 = products[2] || products[0];
      const p4 = products[3] || products[1];

      const makeItem = (p: any, qty: number) => ({
        productId: p._id,
        supplierId: SUPPLIER_PROFILE_ID,
        name: p.name,
        sku: p.sku,
        brand: p.brand || 'OEM',
        priceCents: p.priceCents,
        quantity: qty,
        totalCents: p.priceCents * qty,
        imageUrl: p.images?.[0]?.url,
        condition: p.condition || 'new',
      });

      const ordersData = [
        {
          _id: PART_ORDER_1,
          orderNumber: 'PO-200001',
          status: 'delivered' as const,
          items: [makeItem(p1, 1), makeItem(p2, 2)],
          createdAt: daysAgo(45),
          statusHistory: [
            { status: 'pending', by: 'customer', at: daysAgo(45) },
            { status: 'confirmed', by: 'supplier', at: daysAgo(44) },
            { status: 'processing', by: 'supplier', at: daysAgo(43) },
            { status: 'shipped', by: 'supplier', at: daysAgo(41) },
            { status: 'delivered', by: 'system', at: daysAgo(38) },
          ],
        },
        {
          _id: PART_ORDER_2,
          orderNumber: 'PO-200002',
          status: 'processing' as const,
          items: [makeItem(p3, 1)],
          createdAt: daysAgo(5),
          statusHistory: [
            { status: 'pending', by: 'customer', at: daysAgo(5) },
            { status: 'confirmed', by: 'supplier', at: daysAgo(4) },
            { status: 'processing', by: 'supplier', at: daysAgo(3) },
          ],
        },
        {
          _id: PART_ORDER_3,
          orderNumber: 'PO-200003',
          status: 'pending' as const,
          items: [makeItem(p4, 3)],
          createdAt: daysAgo(1),
          statusHistory: [
            { status: 'pending', by: 'customer', at: daysAgo(1) },
          ],
        },
      ];

      for (const order of ordersData) {
        const subtotal = order.items.reduce((sum: number, i: any) => sum + i.totalCents, 0);

        await (PartOrder as any).findByIdAndUpdate(
          order._id,
          {
            $setOnInsert: {
              _id: order._id,
              orderNumber: order.orderNumber,
              customerId: CUSTOMER_USER_ID,
              items: order.items,
              shippingAddress: {
                fullName: 'Alex Johnson',
                line1: '142 Maple Grove Drive',
                city: 'Austin',
                state: 'TX',
                zip: '78701',
                country: 'USA',
                phone: '+1-512-555-0100',
              },
              subtotalCents: subtotal,
              shippingCents: 0,
              taxCents: 0,
              totalCents: subtotal,
              currency: 'USD',
              status: order.status,
              paymentStatus: 'unpaid',
              statusHistory: order.statusHistory,
              notes: '[DEMO] Sample order for demonstration purposes.',
              createdAt: order.createdAt,
            },
          },
          { upsert: true }
        );
        console.log(`  ✓ PartOrder ${order.orderNumber} [${order.status}] — \$${(subtotal / 100).toFixed(2)}`);
      }
    }
  } else {
    console.log('  [dry-run] Would upsert 3 part orders');
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  seedDemoData complete!');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Demo accounts:');
  console.log('    customer@gis.com    / Password123!  → /app');
  console.log('    technician@gis.com  / Password123!  → /tech');
  console.log('    supplier@gis.com    / Password123!  → /supplier');
  console.log('    admin@gis.com       / Admin123!     → /admin/login');
  console.log('');
  console.log('  Seeded:');
  console.log('    ✓ 1 service category + 4 services');
  console.log('    ✓ 2 saved addresses for customer');
  console.log('    ✓ 3 customer vehicles');
  console.log('    ✓ 5 bookings (2 completed, 1 confirmed, 1 pending, 1 cancelled)');
  console.log('    ✓ Technician profile enriched (Marcus Rivera)');
  console.log('    ✓ 1 payout draft for technician');
  console.log('    ✓ Supplier profile enriched (Apex OEM Auto Supply)');
  console.log('    ✓ 3 part orders (delivered, processing, pending)');
  console.log('═══════════════════════════════════════════════════════\n');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n[seedDemoData] FATAL:', err.message || err);
  process.exit(1);
});
