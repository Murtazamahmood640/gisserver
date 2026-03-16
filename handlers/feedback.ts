import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectDB } from '../config/database.ts';
import { Feedback } from '../models/Feedback.ts';
import { sendEmail, getContactAcknowledgmentEmail } from '../services/emailService.ts';
import { verifyToken, type JwtPayload } from '../utils/jwt.ts';

async function getTokenFromRequest(req: VercelRequest): Promise<JwtPayload | null> {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return null;
  return verifyToken(token);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  await connectDB();

  try {
    if (req.method === 'POST') {
      const feedbackData = req.body;

      if (!feedbackData.name || !feedbackData.email || !feedbackData.rating || !feedbackData.title || !feedbackData.feedback) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields (name, email, rating, title, feedback)',
        });
      }

      if (feedbackData.rating < 1 || feedbackData.rating > 5) {
        return res.status(400).json({
          success: false,
          message: 'Rating must be between 1 and 5',
        });
      }

      const feedback = new Feedback({
        ...feedbackData,
        status: 'pending',
      });
      await feedback.save();

      try {
        await sendEmail({
          to: feedbackData.email,
          subject: 'Thank you for your feedback - Global Integrated Support',
          html: `
            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
              <h2>Thank you for your feedback!</h2>
              <p>Hi ${feedbackData.name},</p>
              <p>We've received your feedback and truly appreciate you taking the time to share your experience with us. Your review helps us improve and serve you better.</p>
              <p><strong>Your Feedback:</strong></p>
              <blockquote style="padding-left: 20px; border-left: 4px solid #ccc; margin: 20px 0;">
                <p><strong>${feedbackData.title}</strong></p>
                <p>${feedbackData.feedback}</p>
              </blockquote>
              <p style="margin-top: 30px; color: #666;">
                Thank you for choosing us!<br>
                Best regards,<br>
                Global Integrated Support Team
              </p>
            </div>
          `,
        });

        await sendEmail({
          to: process.env.ADMIN_EMAIL || 'info@vornoxlab.com',
          subject: `New Customer Feedback - ${feedbackData.rating}/5 Stars`,
          html: `
            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
              <h2>New Customer Feedback Received</h2>
              <p><strong>Name:</strong> ${feedbackData.name}</p>
              <p><strong>Email:</strong> ${feedbackData.email}</p>
              <p><strong>Rating:</strong> ${'⭐'.repeat(feedbackData.rating)} (${feedbackData.rating}/5)</p>
              <p><strong>Title:</strong> ${feedbackData.title}</p>
              <h3>Feedback:</h3>
              <p>${feedbackData.feedback}</p>
              <p style="margin-top: 30px; color: #666;">
                Review this feedback in the admin dashboard.
              </p>
            </div>
          `,
        });
      } catch (emailError) {
        console.error('Email sending error:', emailError);
      }

      return res.status(201).json({
        success: true,
        message: 'Feedback submitted successfully',
        data: feedback,
      });
    }

    if (req.method === 'GET' && req.query.published === 'true') {
      const publishedFeedback = await Feedback.find({ status: 'publish' }).sort({ createdAt: -1 });
      return res.status(200).json({
        success: true,
        data: publishedFeedback,
      });
    }

    const user = await getTokenFromRequest(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      });
    }

    if (req.method === 'GET') {
      const feedbackList = await Feedback.find().sort({ createdAt: -1 });
      return res.status(200).json({
        success: true,
        data: feedbackList,
      });
    } else if (req.method === 'PUT') {
      const { id } = req.query;
      const { status } = req.body;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'Feedback ID is required',
        });
      }

      if (!status || !['pending', 'draft', 'publish'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Valid status is required (pending, draft, publish)',
        });
      }

      const feedback = await Feedback.findByIdAndUpdate(
        id,
        { status },
        { new: true }
      );

      if (!feedback) {
        return res.status(404).json({
          success: false,
          message: 'Feedback not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Feedback updated successfully',
        data: feedback,
      });
    } else if (req.method === 'DELETE') {
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'Feedback ID is required',
        });
      }

      const feedback = await Feedback.findByIdAndDelete(id);

      if (!feedback) {
        return res.status(404).json({
          success: false,
          message: 'Feedback not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Feedback deleted successfully',
      });
    } else {
      return res.status(405).json({
        success: false,
        message: 'Method not allowed',
      });
    }
  } catch (error) {
    console.error('Feedback error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
