import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { User } from './models/User';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const MONGODB_URI = process.env.MONGODB_URI as string;

async function checkUsers() {
  try {
    await mongoose.connect(MONGODB_URI, { dbName: 'luxe-detail' });
    console.log('Connected to MongoDB');

    const users = await User.find({});
    console.log('Users found:', users.length);
    users.forEach(u => {
      console.log(`- ${u.email} (${u.role})`);
    });

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkUsers();
