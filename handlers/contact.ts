import type { VercelRequest, VercelResponse } from '@vercel/node';
import { connectDB } from '../config/database.ts';
import { Contact } from '../models/Contact.ts';
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
      const contactData = req.body;

      if (!contactData.fullName || !contactData.email || !contactData.message) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields (fullName, email, message)',
        });
      }

      const contact = new Contact(contactData);
      await contact.save();

      try {
        await sendEmail({
          to: contactData.email,
          subject: 'Thank you for contacting Luxe Detail Booker',
          html: getContactAcknowledgmentEmail({
            fullName: contactData.fullName,
          }),
        });

        await sendEmail({
          to: process.env.ADMIN_EMAIL || 'info@vornoxlab.com',
          subject: `New Contact Form Submission - ${contactData.subject}`,
          html: `
            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
              <h2>New Contact Form Submission</h2>
              <p><strong>Name:</strong> ${contactData.fullName}</p>
              <p><strong>Email:</strong> ${contactData.email}</p>
              <p><strong>Phone:</strong> ${contactData.phone}</p>
              <p><strong>Subject:</strong> ${contactData.subject}</p>
              <h3>Message:</h3>
              <p>${contactData.message}</p>
            </div>
          `,
        });
      } catch (emailError) {
        console.error('Email sending error:', emailError);
      }

      return res.status(201).json({
        success: true,
        message: 'Contact submission received successfully',
        data: contact,
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
      const contacts = await Contact.find().sort({ createdAt: -1 });
      return res.status(200).json({
        success: true,
        data: contacts,
      });
    } else if (req.method === 'PUT') {
      const { id } = req.query;
      const { status } = req.body;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'Contact ID is required',
        });
      }

      if (!status || !['New', 'Reviewed', 'Responded', 'Resolved'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Valid status is required (New, Reviewed, Responded, Resolved)',
        });
      }

      const contact = await Contact.findByIdAndUpdate(
        id,
        { status },
        { new: true }
      );

      if (!contact) {
        return res.status(404).json({
          success: false,
          message: 'Contact not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Contact updated successfully',
        data: contact,
      });
    } else if (req.method === 'DELETE') {
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'Contact ID is required',
        });
      }

      const contact = await Contact.findByIdAndDelete(id);

      if (!contact) {
        return res.status(404).json({
          success: false,
          message: 'Contact not found',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Contact deleted successfully',
      });
    } else {
      return res.status(405).json({
        success: false,
        message: 'Method not allowed',
      });
    }
  } catch (error) {
    console.error('Contact error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
