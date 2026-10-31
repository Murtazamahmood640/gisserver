import http from 'http';
import app from './app';
import logger from './config/logger';
import { connectDB } from './config/database';
import dotenv from 'dotenv';
import path from 'path';
import cron from 'node-cron';
import mongoose from 'mongoose';
import { TechnicianService } from './modules/technicians/service';
import { TrackingService } from './modules/tracking/service';
import { initRealtimeServer, closeRealtimeServer } from './realtime';
import { initDispatchSweeper, stopDispatchSweeper } from './modules/dispatch/sweeper';
import { seedPartCategories } from './modules/parts/service';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const PORT = process.env.PORT || 3000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let docExpiryTask: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let trackingCleanupTask: any = null;
let httpServer: http.Server | null = null;

if (process.env.ENABLE_CRON === 'true') {
  docExpiryTask = cron.schedule('0 8 * * *', async () => {
    logger.info('Running document expiry check');
    try {
      await TechnicianService.runDocumentExpiryCheck();
    } catch (cronErr) {
      logger.error({ err: cronErr }, 'Error running document expiry check cron');
    }
  });

  // Hourly tracking cleanup (pings > 24h after completion/cancellation)
  trackingCleanupTask = cron.schedule('0 * * * *', async () => {
    logger.info('Running tracking cleanup cron');
    try {
      await TrackingService.runTrackingCleanup();
    } catch (cleanErr) {
      logger.error({ err: cleanErr }, 'Error running tracking cleanup cron');
    }
  });

  // Initialize 15-second dispatch sweeper
  initDispatchSweeper();
}

async function gracefulShutdown(signal: string) {
  logger.info(`[Server] Received ${signal}, initiating graceful shutdown...`);
  stopDispatchSweeper();
  if (docExpiryTask) {
    docExpiryTask.stop();
    docExpiryTask = null;
  }
  if (trackingCleanupTask) {
    trackingCleanupTask.stop();
    trackingCleanupTask = null;
  }
  await closeRealtimeServer();
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  }
  await mongoose.disconnect();
  logger.info('[Server] Graceful shutdown completed cleanly');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function startServer() {
  try {
    await connectDB();
    await seedPartCategories();
    httpServer = http.createServer(app);
    initRealtimeServer(httpServer);
    httpServer.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

startServer();
