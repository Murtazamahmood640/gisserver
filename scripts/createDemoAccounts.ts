import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDB } from '../config/database';
import { User } from '../models/User';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { SupplierProfile } from '../models/SupplierProfile';

async function seedDemoAccounts() {
  console.log('--- Connecting to database ---');
  await connectDB();

  try {
    const plainPassword = 'Password123!';

    // ──────────────────────────────────────────────────────────────────────────
    // 1. Customer Demo Account
    // ──────────────────────────────────────────────────────────────────────────
    const customerEmail = 'customer@gis.com';
    let customerUser = await User.findOne({ email: customerEmail });
    if (customerUser) {
      customerUser.password = plainPassword;
      customerUser.fullName = 'Demo Customer';
      customerUser.role = 'customer';
      customerUser.status = 'active';
      customerUser.isActive = true;
      customerUser.emailVerified = true;
      customerUser.phoneVerified = true;
      await customerUser.save();
      console.log(`Updated customer account: ${customerEmail}`);
    } else {
      customerUser = await User.create({
        email: customerEmail,
        password: plainPassword,
        fullName: 'Demo Customer',
        phone: '+15551234567',
        role: 'customer',
        status: 'active',
        isActive: true,
        emailVerified: true,
        phoneVerified: true,
      });
      console.log(`Created customer account: ${customerEmail}`);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 2. Technician Demo Account
    // ──────────────────────────────────────────────────────────────────────────
    const techEmail = 'technician@gis.com';
    let techUser = await User.findOne({ email: techEmail });
    if (techUser) {
      techUser.password = plainPassword;
      techUser.fullName = 'Demo Technician';
      techUser.role = 'technician';
      techUser.status = 'active';
      techUser.isActive = true;
      techUser.emailVerified = true;
      techUser.phoneVerified = true;
      await techUser.save();
      console.log(`Updated technician user: ${techEmail}`);
    } else {
      techUser = await User.create({
        email: techEmail,
        password: plainPassword,
        fullName: 'Demo Technician',
        phone: '+15559876543',
        role: 'technician',
        status: 'active',
        isActive: true,
        emailVerified: true,
        phoneVerified: true,
      });
      console.log(`Created technician user: ${techEmail}`);
    }

    const techProfile = await TechnicianProfile.findOne({ userId: techUser._id });
    if (!techProfile) {
      await TechnicianProfile.create({
        userId: techUser._id,
        displayName: 'Demo Master Technician',
        phone: '+15559876543',
        bio: 'ASE Certified automotive specialist with 10+ years experience across diagnostics and repairs.',
        skills: { categoryIds: [], serviceIds: [] },
        serviceArea: {
          zipCodes: ['10001', '10002', '10003'],
          city: 'New York',
          state: 'NY',
          radiusKm: 30,
        },
        vehicleInfo: {
          type: 'Van',
          plate: 'TECH-DEMO-1',
          capacity: '750kg',
        },
        verificationStatus: 'approved',
        availability: {
          isOnline: true,
          weeklySchedule: [
            { day: 'mon', from: '08:00', to: '18:00' },
            { day: 'tue', from: '08:00', to: '18:00' },
            { day: 'wed', from: '08:00', to: '18:00' },
            { day: 'thu', from: '08:00', to: '18:00' },
            { day: 'fri', from: '08:00', to: '18:00' },
            { day: 'sat', from: '09:00', to: '16:00' },
          ],
          timeOff: [],
        },
        statusHistory: [
          {
            status: 'approved',
            by: 'system',
            at: new Date(),
            note: 'Approved demo technician profile',
          },
        ],
      });
      console.log('Created approved TechnicianProfile');
    } else {
      techProfile.verificationStatus = 'approved';
      if (techProfile.availability) {
        techProfile.availability.isOnline = true;
      }
      await techProfile.save();
      console.log('Updated TechnicianProfile to approved');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 3. Supplier Demo Account
    // ──────────────────────────────────────────────────────────────────────────
    const supplierEmail = 'supplier@gis.com';
    let supplierUser = await User.findOne({ email: supplierEmail });
    if (supplierUser) {
      supplierUser.password = plainPassword;
      supplierUser.fullName = 'Demo Supplier Rep';
      supplierUser.role = 'supplier';
      supplierUser.status = 'active';
      supplierUser.isActive = true;
      supplierUser.emailVerified = true;
      supplierUser.phoneVerified = true;
      await supplierUser.save();
      console.log(`Updated supplier user: ${supplierEmail}`);
    } else {
      supplierUser = await User.create({
        email: supplierEmail,
        password: plainPassword,
        fullName: 'Demo Supplier Rep',
        phone: '+15554567890',
        role: 'supplier',
        status: 'active',
        isActive: true,
        emailVerified: true,
        phoneVerified: true,
      });
      console.log(`Created supplier user: ${supplierEmail}`);
    }

    const supplierProfile = await SupplierProfile.findOne({ userId: supplierUser._id });
    if (!supplierProfile) {
      await SupplierProfile.create({
        userId: supplierUser._id,
        companyName: 'Apex OEM Auto Supply',
        businessType: 'distributor',
        taxId: 'US-EIN-987654321',
        website: 'https://apexautosupply.example.com',
        description: 'Authorized OEM and Tier 1 aftermarket distributor offering brake kits, suspension components, and filters.',
        categories: ['brakes', 'suspension', 'engine', 'electrical', 'filters'],
        contactPerson: {
          name: 'Demo Supplier Rep',
          title: 'Wholesale Accounts Lead',
          email: supplierEmail,
          phone: '+15554567890',
        },
        businessPhone: '+15554567890',
        supportEmail: 'orders@apexautosupply.example.com',
        businessAddress: {
          street: '450 Industrial Parkway, Suite 12',
          city: 'Detroit',
          state: 'MI',
          zipCode: '48201',
          country: 'United States',
        },
        documents: [],
        verificationStatus: 'approved',
        statusHistory: [
          {
            status: 'approved',
            by: 'system',
            at: new Date(),
            note: 'Approved demo supplier profile',
          },
        ],
      });
      console.log('Created approved SupplierProfile');
    } else {
      supplierProfile.verificationStatus = 'approved';
      await supplierProfile.save();
      console.log('Updated SupplierProfile to approved');
    }

    console.log('\n======================================================');
    console.log('DEMO ACCOUNTS READY');
    console.log('======================================================');
    console.log('Password for all accounts: Password123!');
    console.log('------------------------------------------------------');
    console.log('1. Customer:   customer@gis.com   -> Portal: /app');
    console.log('2. Technician: technician@gis.com -> Portal: /tech');
    console.log('3. Supplier:   supplier@gis.com   -> Portal: /supplier');
    console.log('======================================================\n');
  } catch (err) {
    console.error('Error seeding demo accounts:', err);
  } finally {
    await mongoose.disconnect();
    console.log('--- Database connection closed ---');
  }
}

seedDemoAccounts();
