/**
 * backend/scripts/dispatchDemo.ts
 *
 * Dev-only end-to-end demo of the full dispatch lifecycle.
 * Calls real services against a local MongoDB — no mocks.
 *
 * SAFETY: This script refuses to run when NODE_ENV=production.
 * It prints [PASS]/[FAIL] per step with NO coordinates, tokens, or PII.
 *
 * Usage:
 *   npx tsx backend/scripts/dispatchDemo.ts
 *   MONGODB_URI=mongodb://localhost:27017 npx tsx backend/scripts/dispatchDemo.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { assertScriptSafety, getMaskedHost } from './_scriptGuard';
import * as emailService from '../services/emailService';
import { pushService } from '../services/pushService';

// ─── Safety guard ──────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('[DEMO] ERROR: This script must not run in production.');
  process.exit(1);
}

const rawUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const allowRemote = process.argv.includes('--allow-remote');
try {
  assertScriptSafety(rawUri, allowRemote, 'dispatchDemo');
} catch (err: unknown) {
  console.error((err as Error).message);
  process.exit(1);
}

// Print masked host before doing anything (never credentials)
console.log(`[DEMO] Target Host: ${getMaskedHost(rawUri)}`);

// Stub email & push services to prevent real emails/notifications during demo
(emailService as unknown as Record<string, unknown>).sendEmail = async () => ({ messageId: 'demo-stub' });
(pushService as unknown as Record<string, unknown>).sendToUser = async () => ({ success: true });

// ─── Models ────────────────────────────────────────────────────────────────────
import { User } from '../models/User';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { Booking } from '../models/Booking';
import { DispatchOffer } from '../models/DispatchOffer';
import { DispatchSettings } from '../models/DispatchSettings';
import { Service } from '../models/Service';
import { ServiceCategory } from '../models/ServiceCategory';

// ─── Services ──────────────────────────────────────────────────────────────────
import { DispatchService } from '../modules/dispatch/service';
import { JobsService } from '../modules/jobs/service';
import { TrackingService } from '../modules/tracking/service';

// ─── Helpers ───────────────────────────────────────────────────────────────────

let stepsPassed = 0;
let stepsFailed = 0;

function pass(label: string): void {
  console.log(`  [PASS] ${label}`);
  stepsPassed++;
}

function fail(label: string, reason?: string): void {
  const detail = reason ? ` — ${reason}` : '';
  console.log(`  [FAIL] ${label}${detail}`);
  stepsFailed++;
}

async function step(
  label: string,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
    pass(label);
  } catch (err: any) {
    fail(label, err?.message ?? String(err));
  }
}

// ─── Demo state ────────────────────────────────────────────────────────────────

let techUserId: mongoose.Types.ObjectId;
let bookingId: mongoose.Types.ObjectId;
let offerId: string;

const DEMO_EMAIL_TECH = `demo-tech-${Date.now()}@demo.local`;
const DEMO_EMAIL_CUSTOMER = `demo-customer-${Date.now()}@demo.local`;

// ─── Cleanup helper ────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  if (techUserId) {
    await User.deleteOne({ _id: techUserId }).catch(() => {});
    await TechnicianProfile.deleteOne({ userId: techUserId }).catch(() => {});
  }
  if (bookingId) {
    await Booking.deleteOne({ _id: bookingId }).catch(() => {});
    await DispatchOffer.deleteMany({ bookingId }).catch(() => {});
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  console.log('\n══════════════════════════════════════════════');
  console.log('  Dispatch Demo — DEV environment only');
  console.log('══════════════════════════════════════════════\n');

  // Connect
  await step('Connect to local MongoDB', async () => {
    await mongoose.connect(uri, { dbName: 'luxe-detail-demo', serverSelectionTimeoutMS: 5000 });
  });

  // ── STEP 1: Create approved online technician ──────────────────────────────
  await step('Create approved, online technician user', async () => {
    const techUser = await User.create({
      email: DEMO_EMAIL_TECH,
      password: 'DemoPass1!',
      role: 'technician',
      status: 'active',
    });
    techUserId = techUser._id as mongoose.Types.ObjectId;

    // Ensure a category exists to attach to profile
    let category = await ServiceCategory.findOne({});
    if (!category) {
      category = await ServiceCategory.create({ name: 'Demo Service', slug: 'demo-service' });
    }

    await TechnicianProfile.create({
      userId: techUserId,
      displayName: 'Demo Tech',
      verificationStatus: 'approved',
      skills: { categoryIds: [category._id], serviceIds: [] },
      serviceArea: {
        zipCodes: ['10001'],
        center: { type: 'Point', coordinates: [-74.006, 40.7128] },
        radiusKm: 50,
        city: 'New York',
        state: 'NY',
      },
      availability: {
        isOnline: true,
        weeklySchedule: [
          { day: 'mon', from: '08:00', to: '18:00' },
          { day: 'tue', from: '08:00', to: '18:00' },
          { day: 'wed', from: '08:00', to: '18:00' },
          { day: 'thu', from: '08:00', to: '18:00' },
          { day: 'fri', from: '08:00', to: '18:00' },
          { day: 'sat', from: '08:00', to: '18:00' },
          { day: 'sun', from: '08:00', to: '18:00' },
        ],
        timeOff: [],
      },
      rating: { avg: 4.8, count: 10 },
      stats: { jobsCompleted: 5, acceptanceRate: 0.9 },
      activeSchedule: [],
      documents: [],
      payoutDetails: {},
      statusHistory: [],
    });
  });

  // ── STEP 2: Create confirmed ASAP booking ────────────────────────────────────
  await step('Create confirmed ASAP booking', async () => {
    // Ensure a service exists
    let service = await Service.findOne({});
    if (!service) {
      const category = await ServiceCategory.findOne({});
      service = await Service.create({
        name: 'Demo Wash',
        slug: 'demo-wash',
        categoryId: category!._id,
        basePriceCents: 5000,
        durationMinutes: 60,
        isActive: true,
      });
    }

    const bkNum = `DEMO-${Date.now()}`;
    const booking = await Booking.create({
      bookingNumber: bkNum,
      guest: {
        fullName: 'Demo Customer',
        email: DEMO_EMAIL_CUSTOMER,
        phone: '555-0100',
      },
      vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2022 },
      categoryId: service.categoryId,
      serviceId: service._id,
      serviceSnapshot: { name: service.name, slug: (service as any).slug },
      address: {
        line1: '123 Demo St',
        city: 'New York',
        state: 'NY',
        zip: '10001',
      },
      location: { type: 'Point', coordinates: [-74.006, 40.7128] },
      scheduledAt: new Date(), // ASAP — right now
      scheduledLocal: {
        date: new Date().toISOString().split('T')[0],
        slot: new Date().toTimeString().slice(0, 5),
      },
      timezone: 'America/New_York',
      isAsap: true,
      status: 'confirmed',
      statusHistory: [{ status: 'confirmed', by: 'demo-script', at: new Date() }],
      pricing: {
        baseCents: 5000,
        addonsCents: 0,
        discountCents: 0,
        couponPercent: 0,
        taxCents: 400,
        totalCents: 5400,
        commissionPercent: 0.15,
        processingPercent: 0.03,
        commissionCents: 750,
        processingCents: 162,
        providerPayoutCents: 4488,
      },
      paymentStatus: 'paid',
      source: 'admin',
      dispatch: { status: 'none', attempts: 0 },
      addons: [],
    });

    bookingId = booking._id as mongoose.Types.ObjectId;
  });

  // ── STEP 3: Dispatch — startDispatch ────────────────────────────────────────
  let dispatchResult: { status: string; offersCreated?: number } | null = null;
  await step('startDispatch creates at least one offer', async () => {
    dispatchResult = await DispatchService.startDispatch(bookingId.toString(), 'demo-script');
    if (!dispatchResult || dispatchResult.offersCreated === 0) {
      throw new Error(
        `Dispatch returned status=${dispatchResult?.status}, offersCreated=${dispatchResult?.offersCreated}. ` +
        'Ensure the demo technician passes matching (check serviceArea zip, isOnline, verificationStatus).'
      );
    }
  });

  // ── STEP 4: Find the created offer ──────────────────────────────────────────
  await step('DispatchOffer exists for technician', async () => {
    const offer = await DispatchOffer.findOne({
      bookingId,
      technicianUserId: techUserId,
      status: 'sent',
    });
    if (!offer) throw new Error('No sent offer found for demo technician');
    offerId = offer._id.toString();
  });

  // ── STEP 5: Accept offer ─────────────────────────────────────────────────────
  await step('acceptOffer — technician accepts the offer', async () => {
    if (!offerId) throw new Error('offerId not set (previous step failed)');
    const result = await DispatchService.acceptOffer(offerId, techUserId.toString());
    if (!result.success) throw new Error('acceptOffer returned success=false');
    if (result.booking.status !== 'assigned') {
      throw new Error(`Expected booking status=assigned, got ${result.booking.status}`);
    }
  });

  // ── STEP 6: En route ─────────────────────────────────────────────────────────
  await step('enRoute — technician marks en route', async () => {
    const booking = await JobsService.enRoute(bookingId.toString(), techUserId.toString());
    if (booking.status !== 'technician_en_route') {
      throw new Error(`Expected technician_en_route, got ${booking.status}`);
    }
  });

  // ── STEP 7: Location ping (during active job) ─────────────────────────────
  await step('Location ping recorded during active job (no coordinates in output)', async () => {
    // Use a well-known NYC location — we do NOT print it
    const result = await TrackingService.updateLocation(techUserId.toString(), {
      lat: 40.7128,
      lng: -74.006,
      heading: 90,
      speed: 30,
      accuracy: 5,
    });
    if (!result.success) throw new Error('updateLocation returned success=false');
    if (!result.activeBookingId) throw new Error('No activeBookingId in location result');
  });

  // ── STEP 8: Arrived ──────────────────────────────────────────────────────────
  await step('arrived — technician marks arrived', async () => {
    const booking = await JobsService.arrived(bookingId.toString(), techUserId.toString());
    if (booking.status !== 'arrived') {
      throw new Error(`Expected arrived, got ${booking.status}`);
    }
  });

  // ── STEP 9: Start (in_progress) ──────────────────────────────────────────────
  await step('start — technician starts service', async () => {
    const booking = await JobsService.start(bookingId.toString(), techUserId.toString());
    if (booking.status !== 'in_progress') {
      throw new Error(`Expected in_progress, got ${booking.status}`);
    }
  });

  // ── STEP 10: Complete ────────────────────────────────────────────────────────
  await step('complete — technician marks job complete', async () => {
    const booking = await JobsService.complete(
      bookingId.toString(),
      techUserId.toString(),
      {
        notes: 'Demo run completed successfully',
        checklist: [
          { label: 'Exterior wash', done: true },
          { label: 'Interior vacuum', done: true },
        ],
      }
    );
    if (booking.status !== 'completed') {
      throw new Error(`Expected completed, got ${booking.status}`);
    }
  });

  // ── STEP 11: Phone privacy post-completion ───────────────────────────────────
  await step('Phone visible immediately after completion (within 24 h)', async () => {
    const detail = await JobsService.getJobDetail(bookingId.toString(), techUserId.toString());
    if (!(detail as any).customer?.phone) {
      throw new Error('Phone should be visible within 24h of completion');
    }
    // Confirm email is absent
    if ((detail as any).customer?.email) {
      throw new Error('Customer email must never be exposed');
    }
  });

  // ── STEP 12: activeSchedule cleared after completion ─────────────────────────
  await step('TechnicianProfile.activeSchedule cleared after completion', async () => {
    const profile = await TechnicianProfile.findOne({ userId: techUserId });
    const slot = profile?.activeSchedule?.find(
      (s: { bookingId: mongoose.Types.ObjectId; start: Date; end: Date }) =>
        s.bookingId.toString() === bookingId.toString()
    );
    if (slot) throw new Error('Schedule slot was not removed after completion');
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  await step('Cleanup demo data', cleanup);

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log(`  Passed: ${stepsPassed}  Failed: ${stepsFailed}`);
  console.log('══════════════════════════════════════════════\n');

  await mongoose.disconnect();
  process.exit(stepsFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[DEMO] Fatal error:', err?.message ?? err);
  mongoose.disconnect().finally(() => process.exit(1));
});
