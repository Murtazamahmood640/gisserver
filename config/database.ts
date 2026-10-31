import mongoose from 'mongoose';
import logger from './logger';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI as string; // ✅ fix here

if (!MONGODB_URI) {
  throw new Error('Please define the MONGODB_URI environment variable');
}

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var mongoose: MongooseCache;
}

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

export async function connectDB() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
      dbName: 'luxe-detail',
    };

    cached.promise = mongoose
      .connect(MONGODB_URI, opts)
      .then((mongoose) => {
        logger.info('MongoDB connected');
        return mongoose;
      })
      .catch((err) => {
        // Clear the cached promise so next request retries connection
        cached.promise = null;
        cached.conn = null;
        logger.error({ err }, 'MongoDB connection error');
        throw err;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}