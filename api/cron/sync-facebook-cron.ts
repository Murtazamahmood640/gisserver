import logger from '../../config/logger';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectDB } from '../../config/database';
import { syncFacebookReviews } from '../../services/facebookSync';

/**
 * Cron job for automatic Facebook review syncing
 * 
 * This should be configured in vercel.json:
 * {
 *   "crons": [
 *     {
 *       "path": "/api/cron/sync-facebook-cron",
 *       "schedule": "0 * * * *"  // Every hour
 *     }
 *   ]
 * }
 * 
 * Or use GitHub Actions/external cron services to POST to this endpoint
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Only allow GET and POST
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            message: 'Method not allowed'
        });
    }

    // Verify cron secret (optional but recommended)
    const cronSecret = req.headers['x-cron-secret'];
    if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized cron request'
        });
    }

    try {
        await connectDB();

        logger.info('Starting scheduled Facebook review sync');
        const startTime = Date.now();

        const result = await syncFacebookReviews();

        const duration = Date.now() - startTime;
        console.log(`[v0] Facebook sync completed in ${duration}ms`);

        return res.status(200).json({
            success: true,
            message: 'Facebook reviews synced successfully',
            data: {
                inserted: result.inserted,
                skipped: result.skipped,
                total: result.inserted + result.skipped,
                timestamp: new Date().toISOString(),
                duration: `${duration}ms`,
            },
        });

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';

        logger.error({ msg: errorMsg }, 'Scheduled sync failed');

        return res.status(500).json({
            success: false,
            message: 'Scheduled Facebook sync failed',
            error: errorMsg,
            timestamp: new Date().toISOString(),
        });
    }
}