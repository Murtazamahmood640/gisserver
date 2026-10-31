import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Load environment variables from backend/.env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Dev only — refuses to run in production
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run in production');
  process.exit(1);
}

import { assertScriptSafety, getMaskedHost } from './_scriptGuard';

const rawUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const allowRemote = process.argv.includes('--allow-remote');
try {
  assertScriptSafety(rawUri, allowRemote, 'createTestTechnician');
} catch (err: unknown) {
  console.error((err as Error).message);
  process.exit(1);
}

console.log(`[createTestTechnician] Target Host: ${getMaskedHost(rawUri)}`);

import { connectDB } from '../config/database';
import { User } from '../models/User';
import { TechnicianProfile } from '../models/TechnicianProfile';

async function createTestTechnician() {
  console.log('--- Connecting to database ---');
  await connectDB();

  try {
    const email = 'tech.test@example.com';
    const password = 'TestTechnician123!';
    const fullName = 'Test Technician';
    const phone = '555-019-2834';

    let user = await User.findOne({ email });
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    if (user) {
      console.log(`Updating existing test technician: ${email}`);
      user.password = hashedPassword;
      user.role = 'technician';
      user.status = 'active';
      user.isActive = true;
      user.emailVerified = true;
      await user.save();
    } else {
      console.log(`Creating new test technician: ${email}`);
      user = await User.create({
        email,
        password: hashedPassword,
        fullName,
        phone,
        role: 'technician',
        status: 'active',
        isActive: true,
        emailVerified: true,
      });
    }

    let profile = await TechnicianProfile.findOne({ userId: user._id });
    if (!profile) {
      profile = await TechnicianProfile.create({
        userId: user._id,
        displayName: fullName,
        phone,
        bio: 'Certified master technician with 10+ years experience in auto detailing and ceramic coating.',
        skills: { categoryIds: [], serviceIds: [] },
        serviceArea: {
          zipCodes: ['10001', '10002', '10003'],
          city: 'New York',
          state: 'NY',
          radiusKm: 25,
        },
        vehicleInfo: {
          type: 'Van',
          plate: 'TECH-101',
          capacity: '500kg',
        },
        verificationStatus: 'approved',
        availability: {
          isOnline: true,
          weeklySchedule: [
            { day: 'mon', from: '08:00', to: '17:00' },
            { day: 'tue', from: '08:00', to: '17:00' },
            { day: 'wed', from: '08:00', to: '17:00' },
            { day: 'thu', from: '08:00', to: '17:00' },
            { day: 'fri', from: '08:00', to: '17:00' },
          ],
          timeOff: [],
        },
        statusHistory: [
          {
            status: 'approved',
            by: user._id.toString(),
            at: new Date(),
            note: 'Test technician account seeded',
          },
        ],
      });
      console.log('Created TechnicianProfile with approved status');
    } else {
      profile.verificationStatus = 'approved';
      profile.availability.isOnline = true;
      await profile.save();
      console.log('Updated existing TechnicianProfile to approved status');
    }

    console.log('\n========================================');
    console.log('Test Technician Created / Verified:');
    console.log(`Email:    ${email}`);
    console.log(`Password: ${password}`);
    console.log(`User ID:  ${user._id.toString()}`);
    console.log(`Status:   ${profile.verificationStatus}`);
    console.log('========================================\n');
  } catch (error) {
    console.error('Error creating test technician:', error);
  } finally {
    await mongoose.disconnect();
    console.log('--- Database connection closed ---');
  }
}

createTestTechnician();
