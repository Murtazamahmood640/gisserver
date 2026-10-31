import logger from '../../config/logger';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectDB } from '../../config/database';
import { syncFacebookReviews } from '../../services/facebookSync';
import { verifyToken } from '../../utils/jwt';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    try {
        // 1. Establish Database Connection
        await connectDB();

        // 2. 🔐 Validate Authorization Token
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Missing authorization token',
            });
        }

        // 3. Verify Admin Privileges
        const user = verifyToken(token);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Admin access required',
            });
        }

        // 4. Validate Environment Configuration
        if (!process.env.FB_PAGE_ID || !process.env.FB_ACCESS_TOKEN) {
            return res.status(400).json({
                success: false,
                message: 'Facebook credentials not configured. Please set FB_PAGE_ID and FB_ACCESS_TOKEN in environment variables.',
            });
        }

        // 5. Handle the Sync Request
        if (req.method === 'POST') {
            // Calls the service that now fetches both Feed Comments and Recommendations
            const result = await syncFacebookReviews();

            return res.status(200).json({
                success: true,
                message: `Sync complete: ${result.inserted} new items added, ${result.skipped} existing items skipped.`,
                data: {
                    newItems: result.inserted,
                    skippedItems: result.skipped,
                    timestamp: new Date().toISOString()
                },
            });
        }

        // 6. Handle Unsupported Methods
        return res.status(405).json({
            success: false,
            message: 'Method not allowed. Use POST to sync reviews.'
        });

    } catch (error) {
        logger.error({ err: error }, "[v0] Facebook sync error");

        // Extracts specific Facebook API error messages if available from the service
        const errorMessage = error instanceof Error
            ? error.message
            : 'Failed to sync Facebook reviews. Please check your credentials and try again.';

        return res.status(500).json({
            success: false,
            message: errorMessage,
        });
    }
}