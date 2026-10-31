import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';

// Load environment variables from backend/.env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDB } from '../config/database';
import { User } from '../models/User';

async function listUsers() {
  console.log('--- Connecting to database ---');
  await connectDB();

  try {
    console.log("--- Fetching users with role 'user' (read-only) ---\n");

    const users = await User.find({ role: 'user' })
      .select('_id email fullName role isActive createdAt')
      .sort({ createdAt: -1 })
      .lean();

    if (users.length === 0) {
      console.log("No users found with role 'user'.");
    } else {
      console.log(`Found ${users.length} user(s) with role 'user':\n`);
      const tableData = users.map((u: any) => ({
        ID: u._id.toString(),
        Email: u.email,
        'Full Name': u.fullName || '(none)',
        Role: u.role,
        Active: u.isActive ? 'YES' : 'NO',
        'Created At': u.createdAt ? new Date(u.createdAt).toISOString() : '(none)',
      }));

      console.table(tableData);
    }
  } catch (error) {
    console.error('Error fetching users:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n--- Database connection closed ---');
  }
}

listUsers();
