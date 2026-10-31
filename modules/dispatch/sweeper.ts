import cron from 'node-cron';
import { DispatchService } from './service';
import logger from '../../config/logger';

let isSweeperRunning = false;
let sweeperTask: ReturnType<typeof cron.schedule> | null = null;

export async function runDispatchSweep(): Promise<{ expiredOffersCount: number; advancedBookings: number }> {
  if (isSweeperRunning) {
    logger.debug('[DispatchSweeper] Sweep already in progress, skipping overlap');
    return { expiredOffersCount: 0, advancedBookings: 0 };
  }
  isSweeperRunning = true;
  try {
    const result = await DispatchService.runDispatchSweep();
    if (result.expiredOffersCount > 0 || result.advancedBookings > 0) {
      logger.info(result, '[DispatchSweeper] Sweep completed');
    }
    try {
      await DispatchService.reconcileTechnicianSchedules();
    } catch (recErr: unknown) {
      logger.error({ err: recErr }, '[DispatchSweeper] Reconcile error');
    }
    return result;
  } catch (err: unknown) {
    logger.error({ err }, '[DispatchSweeper] Error during dispatch sweep');
    return { expiredOffersCount: 0, advancedBookings: 0 };
  } finally {
    isSweeperRunning = false;
  }
}

/**
 * Initializes dispatch sweeper if ENABLE_CRON is true.
 * Runs every 15 seconds: `* /15 * * * * *`
 */
export function initDispatchSweeper(): void {
  if (process.env.ENABLE_CRON === 'true') {
    logger.info('[DispatchSweeper] Initializing 15-second cron schedule');
    // Run every 15 seconds (node-cron supports 6-field cron expressions with seconds)
    sweeperTask = cron.schedule('*/15 * * * * *', async () => {
      await runDispatchSweep();
    });
  }
}

export function stopDispatchSweeper(): void {
  if (sweeperTask) {
    sweeperTask.stop();
    sweeperTask = null;
    logger.info('[DispatchSweeper] Sweeper stopped');
  }
}
