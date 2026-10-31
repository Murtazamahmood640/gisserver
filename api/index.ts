import app from "../app";
import logger from '../config/logger';
import { connectDB } from "../config/database";

// Ensure Vercel serverless runtime does not consume or pre-parse request body,
// allowing express.raw middleware in webhookRouter to receive raw body intact.
export const config = {
  api: {
    bodyParser: false,
  },
};

let connected = false;

export default async function handler(req: any, res: any) {
  // Set CORS headers for all responses
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    if (!connected) {
      await connectDB();
      connected = true;
    }
    // Directly use the express app as the handler
    return app(req, res);
  } catch (error) {
    // Reset connected flag so next request retries the DB connection
    connected = false;
    logger.error({ err: error }, "Vercel handler error");
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        message: "Internal Server Error during initialization",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}