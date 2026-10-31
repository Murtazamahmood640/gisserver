
import nodemailer from 'nodemailer';
import logger from '../config/logger';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Initialize Stackmail transporter
const transporter = nodemailer.createTransport({
  host: process.env.STACKMAIL_HOST,
  port: parseInt(process.env.STACKMAIL_PORT || '587'),
  secure: process.env.STACKMAIL_SECURE === 'true',
  auth: {
    user: process.env.STACKMAIL_USER,
    pass: process.env.STACKMAIL_PASS,
  },
});

// Verify connection
transporter.verify((error) => {
  if (error) {
    logger.error({ err: error }, 'Stackmail configuration error');
  } else {
    logger.info('Stackmail ready to send emails');
  }
});

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: EmailOptions) {
  try {
    const mailOptions = {
      from: `"Global Integrated Support" <${process.env.STACKMAIL_USER}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || options.html.replace(/<[^>]*>/g, ''),
    };

    const result = await transporter.sendMail(mailOptions);
    logger.info({ messageId: result.messageId }, 'Email sent');
    return result;
  } catch (error) {
    logger.error({ err: error }, 'Error sending email');
    throw error;
  }
}

export function getBookingConfirmationEmail(booking: {
  fullName: string;
  email: string;
  phone: string;
  address?: string;

  vehicleName: string;
  make?: string;
  vehicleModel?: string;
  year?: string;
  vehicleCategory?: string;

  serviceType: string;
  date: string;
  timeSlot: string;

  totalPrice: number;
  basePrice?: number;
  discount?: number;
  coupons?: string;

  addons?: { name: string; price: number }[];
  guestAccessLink?: string;
}): string {
  const addonsHtml =
    booking.addons && booking.addons.length > 0
      ? `<p><strong>Addons:</strong> ${booking.addons
          .map((a) => `${a.name} ($${a.price.toFixed(2)})`)
          .join(', ')}</p>`
      : '';

  return `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2>Booking Confirmation</h2>

      <p>Dear ${booking.fullName},</p>

      <p>
        Thank you for booking with Global Integrated Support.
        Your appointment has been confirmed.
      </p>

      <div style="background-color:#f5f5f5;padding:20px;border-radius:5px;margin:20px 0;">

        <h3>Customer Information</h3>

        <p><strong>Name:</strong> ${booking.fullName}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Phone:</strong> ${booking.phone}</p>

        ${
          booking.address
            ? `<p><strong>Address:</strong> ${booking.address}</p>`
            : ''
        }

        <h3 style="margin-top:20px;">Vehicle Details</h3>

        <p><strong>Vehicle:</strong> ${booking.vehicleName}</p>

        ${
          booking.make
            ? `<p><strong>Make:</strong> ${booking.make}</p>`
            : ''
        }

        ${
          booking.vehicleModel
            ? `<p><strong>Model:</strong> ${booking.vehicleModel}</p>`
            : ''
        }

        ${
          booking.year
            ? `<p><strong>Year:</strong> ${booking.year}</p>`
            : ''
        }

        ${
          booking.vehicleCategory
            ? `<p><strong>Category:</strong> ${booking.vehicleCategory}</p>`
            : ''
        }

        <h3 style="margin-top:20px;">Appointment Details</h3>

        <p><strong>Service:</strong> ${booking.serviceType}</p>
        <p><strong>Date:</strong> ${booking.date}</p>
        <p><strong>Time:</strong> ${booking.timeSlot}</p>

        ${addonsHtml}

        ${
          booking.basePrice
            ? `<p><strong>Base Price:</strong> $${booking.basePrice.toFixed(
                2
              )}</p>`
            : ''
        }

        ${
          booking.discount
            ? `<p><strong>Discount:</strong> -$${booking.discount.toFixed(
                2
              )}</p>`
            : ''
        }

        ${
          booking.coupons
            ? `<p><strong>Applied Coupons:</strong> ${booking.coupons}</p>`
            : ''
        }

        <p style="font-size:18px;">
          <strong>Final Price:</strong> $${booking.totalPrice.toFixed(2)}
        </p>

        ${
          booking.guestAccessLink
            ? `<p style="margin-top:15px;padding-top:15px;border-top:1px solid #ddd;">
                <strong>Manage Booking:</strong> <a href="${booking.guestAccessLink}" style="color:#0284c7;font-weight:bold;">View, Reschedule, or Cancel</a>
               </p>`
            : ''
        }

      </div>

      <p>We look forward to serving you!</p>

      <p style="margin-top:30px;color:#666;font-size:12px;">
        Global Integrated Support<br>
        Email: support@globalintegratedsupport.com
      </p>
    </div>
  `;
}

export function getContactAcknowledgmentEmail(contact: {
  fullName: string;
}): string {
  return `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2>We Received Your Message</h2>

      <p>Dear ${contact.fullName},</p>

      <p>
        Thank you for contacting Global Integrated Support.
        We have received your message and will get back to you as soon as possible.
      </p>

      <p style="margin-top:30px;color:#666;font-size:12px;">
        Best regards,<br>
        Global Integrated Support Team<br>
        Email: support@globalintegratedsupport.com
      </p>
    </div>
  `;
}

export function getAdminNotificationEmail(booking: {
  fullName: string;
  phone: string;
  email: string;
  address?: string;

  vehicleName: string;
  make?: string;
  vehicleModel?: string;
  year?: string;
  vehicleCategory?: string;

  serviceType: string;
  date: string;
  timeSlot: string;

  totalPrice: number;

  addons?: {
    name: string;
    price: number;
  }[];
}): string {
  const addonsHtml =
    booking.addons && booking.addons.length > 0
      ? `<p><strong>Addons:</strong> ${booking.addons
          .map((a) => `${a.name} ($${a.price.toFixed(2)})`)
          .join(', ')}</p>`
      : '';

  return `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2>New Booking Received</h2>

      <div style="background-color:#f5f5f5;padding:20px;border-radius:5px;margin:20px 0;">

        <h3>Customer Details</h3>

        <p><strong>Name:</strong> ${booking.fullName}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Phone:</strong> ${booking.phone}</p>

        ${
          booking.address
            ? `<p><strong>Address:</strong> ${booking.address}</p>`
            : ''
        }

        <h3 style="margin-top:20px;">Vehicle Details</h3>

        <p><strong>Vehicle:</strong> ${booking.vehicleName}</p>

        ${
          booking.make
            ? `<p><strong>Make:</strong> ${booking.make}</p>`
            : ''
        }

        ${
          booking.vehicleModel
            ? `<p><strong>Model:</strong> ${booking.vehicleModel}</p>`
            : ''
        }

        ${
          booking.year
            ? `<p><strong>Year:</strong> ${booking.year}</p>`
            : ''
        }

        ${
          booking.vehicleCategory
            ? `<p><strong>Category:</strong> ${booking.vehicleCategory}</p>`
            : ''
        }

        <h3 style="margin-top:20px;">Booking Details</h3>

        <p><strong>Service:</strong> ${booking.serviceType}</p>
        <p><strong>Date:</strong> ${booking.date}</p>
        <p><strong>Time:</strong> ${booking.timeSlot}</p>

        ${addonsHtml}

        <p><strong>Total Price:</strong> $${booking.totalPrice.toFixed(2)}</p>

      </div>
    </div>
  `;
}

export function getPasswordResetEmail(options: { fullName: string; resetUrl: string }): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.6;">
      <h2 style="color: #1a1a1a;">Password Reset Request</h2>
      <p>Hello ${options.fullName},</p>
      <p>We received a request to reset your password on Global Integrated Support.</p>
      <p>Click the button below to set a new password. This link is valid for <strong>1 hour</strong>.</p>
      <div style="margin: 25px 0;">
        <a href="${options.resetUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Reset Password</a>
      </div>
      <p>If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #2563eb;">${options.resetUrl}</p>
      <hr style="border: none; border-top: 1px solid #eaeaea; margin: 20px 0;" />
      <p style="font-size: 12px; color: #666;">If you did not request this password reset, please ignore this email. Your account remains secure.</p>
    </div>
  `;
}

export function getEmailVerificationEmail(options: { fullName: string; verifyUrl: string }): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.6;">
      <h2 style="color: #1a1a1a;">Verify Your Email Address</h2>
      <p>Hello ${options.fullName},</p>
      <p>Thank you for registering with Global Integrated Support. Please verify your email address to activate all features of your account.</p>
      <p>Click the button below to verify your email. This link is valid for <strong>24 hours</strong>.</p>
      <div style="margin: 25px 0;">
        <a href="${options.verifyUrl}" style="background-color: #16a34a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Verify Email</a>
      </div>
      <p>If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #16a34a;">${options.verifyUrl}</p>
      <hr style="border: none; border-top: 1px solid #eaeaea; margin: 20px 0;" />
      <p style="font-size: 12px; color: #666;">If you did not create an account, you can safely ignore this email.</p>
    </div>
  `;
}

export function getWelcomeEmail(options: { fullName: string }): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.6;">
      <h2 style="color: #1a1a1a;">Welcome to Global Integrated Support!</h2>
      <p>Hello ${options.fullName},</p>
      <p>Your email has been verified and your account is ready to use.</p>
      <p>You can now book automotive detailing and repair services, manage appointments, and track real-time progress.</p>
      <p style="margin-top:30px;color:#666;font-size:12px;">
        Global Integrated Support<br>
        Email: support@globalintegratedsupport.com
      </p>
    </div>
  `;
}

export function getAccountLockedEmail(options: { fullName: string; lockDurationMinutes: number }): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.6;">
      <h2 style="color: #dc2626;">Security Alert: Account Temporarily Locked</h2>
      <p>Hello ${options.fullName},</p>
      <p>Your Global Integrated Support account has been temporarily locked for <strong>${options.lockDurationMinutes} minutes</strong> due to 10 consecutive failed login attempts.</p>
      <p>If this was you, you can attempt to log in again once the lockout window expires, or reset your password immediately using the link below.</p>
      <p style="color: #666; font-size: 13px;">If you did not attempt these logins, someone may be attempting to access your account. We strongly recommend resetting your password once access is restored.</p>
      <p style="margin-top:30px;color:#666;font-size:12px;">
        Global Integrated Support Security Team<br>
        Email: support@globalintegratedsupport.com
      </p>
    </div>
  `;
}

export function getStatusUpdateEmail(options: {
  fullName: string;
  bookingNumber: string;
  serviceName: string;
  status: string;
  scheduledLocal?: { date: string; slot: string };
  note?: string;
}): string {
  const statusDisplay = options.status.replace(/_/g, ' ').toUpperCase();
  const statusColors: Record<string, string> = {
    CONFIRMED: '#16a34a',
    CANCELLED: '#dc2626',
    COMPLETED: '#2563eb',
  };
  const color = statusColors[statusDisplay] || '#4b5563';

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.6;">
      <h2 style="color: #1a1a1a;">Booking Status Update</h2>
      <p>Hello ${options.fullName},</p>
      <p>The status of your booking <strong>#${options.bookingNumber}</strong> (${options.serviceName}) has been updated to:</p>
      <div style="margin: 20px 0; padding: 12px 20px; background-color: #f3f4f6; border-left: 4px solid ${color}; border-radius: 4px;">
        <span style="font-size: 18px; font-weight: bold; color: ${color};">${statusDisplay}</span>
      </div>
      ${
        options.scheduledLocal
          ? `<p><strong>Scheduled Date:</strong> ${options.scheduledLocal.date} at ${options.scheduledLocal.slot}</p>`
          : ''
      }
      ${options.note ? `<p><strong>Note:</strong> ${options.note}</p>` : ''}
      <hr style="border: none; border-top: 1px solid #eaeaea; margin: 20px 0;" />
      <p style="font-size: 12px; color: #666;">
        Global Integrated Support<br>
        Email: support@globalintegratedsupport.com
      </p>
    </div>
  `;
}





// ---------------------------------------------------------------------------
// Technician Email Templates
// ---------------------------------------------------------------------------

function wrapTechEmail(title: string, contentHtml: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; color: #333333; line-height: 1.6;">
      <div style="background-color: #1a1a2e; padding: 24px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px;">Global Integrated Support</h1>
        <p style="color: #94a3b8; margin: 6px 0 0 0; font-size: 13px;">Technician Operations</p>
      </div>
      <div style="padding: 28px 24px;">
        <h2 style="color: #1a1a2e; margin-top: 0; font-size: 18px;">${title}</h2>
        ${contentHtml}
        <hr style="border: none; border-top: 1px solid #eaeaea; margin: 24px 0;" />
        <p style="font-size: 12px; color: #64748b; margin: 0;">
          Global Integrated Support Technician Operations<br>
          Email: support@globalintegratedsupport.com
        </p>
      </div>
    </div>
  `;
}

export function getTechApplicationReceivedEmail(data: { fullName: string }): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>Thank you for submitting your application to join Global Integrated Support as a service technician!</p>
    <p>We have successfully received your profile and documents. Our administration and verification team will review your application shortly.</p>
    <p>You can check your application status at any time by logging into the Technician Portal.</p>
  `;
  return wrapTechEmail('Application Received', content);
}

export function getTechNewApplicationAdminEmail(data: { techName: string; techEmail: string; adminUrl: string }): string {
  const content = `
    <p>A new technician application has been submitted and is waiting for review.</p>
    <div style="background-color: #f8fafc; border-left: 4px solid #2563eb; padding: 14px 18px; margin: 18px 0; border-radius: 4px;">
      <p style="margin: 0 0 6px 0;"><strong>Technician Name:</strong> ${data.techName}</p>
      <p style="margin: 0;"><strong>Email:</strong> ${data.techEmail}</p>
    </div>
    <div style="margin: 24px 0;">
      <a href="${data.adminUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Review Application</a>
    </div>
    <p style="font-size: 12px; color: #64748b;">Direct link: ${data.adminUrl}</p>
  `;
  return wrapTechEmail('New Technician Application Submitted', content);
}

export function getTechApprovedEmail(data: { fullName: string; portalUrl: string }): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>Congratulations! Your technician application with Global Integrated Support has been <strong>approved</strong>.</p>
    <p>Your account is now active. You can now access your technician dashboard to set your availability, toggle your online dispatch status, and receive job assignments.</p>
    <div style="margin: 24px 0;">
      <a href="${data.portalUrl}" style="background-color: #16a34a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Go to Technician Portal</a>
    </div>
    <p style="font-size: 12px; color: #64748b;">Direct link: ${data.portalUrl}</p>
  `;
  return wrapTechEmail('Technician Application Approved', content);
}

export function getTechRejectedEmail(data: { fullName: string; reason: string; portalUrl: string }): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>Thank you for your interest in working with Global Integrated Support. After reviewing your application, we were unable to approve it at this time.</p>
    <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 14px 18px; margin: 18px 0; border-radius: 4px;">
      <p style="margin: 0; color: #991b1b;"><strong>Reason:</strong> ${data.reason}</p>
    </div>
    <p>You may update your profile, upload required credentials, and resubmit your application for re-review:</p>
    <div style="margin: 24px 0;">
      <a href="${data.portalUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Update & Resubmit</a>
    </div>
  `;
  return wrapTechEmail('Technician Application Update', content);
}

export function getTechSuspendedEmail(data: { fullName: string; reason: string }): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>Please be advised that your technician account with Global Integrated Support has been <strong>suspended</strong>.</p>
    <div style="background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 14px 18px; margin: 18px 0; border-radius: 4px;">
      <p style="margin: 0; color: #991b1b;"><strong>Reason for Suspension:</strong> ${data.reason}</p>
    </div>
    <p>While suspended, you will not receive new service dispatches or have access to active technician jobs.</p>
    <p>If you have any questions or wish to appeal this decision, please reach out to our team at support@globalintegratedsupport.com.</p>
  `;
  return wrapTechEmail('Technician Account Suspended', content);
}

export function getTechReinstatedEmail(data: { fullName: string; portalUrl: string }): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>We are pleased to inform you that your technician account with Global Integrated Support has been <strong>reinstated</strong>.</p>
    <p>You can now log in to the Technician Portal, configure your schedule, and begin receiving job assignments again.</p>
    <div style="margin: 24px 0;">
      <a href="${data.portalUrl}" style="background-color: #16a34a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Access Technician Portal</a>
    </div>
  `;
  return wrapTechEmail('Technician Account Reinstated', content);
}

export function getTechDocumentRejectedEmail(data: { fullName: string; docType: string; note: string }): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>One of your uploaded documents (<strong>${data.docType.toUpperCase()}</strong>) was reviewed and could not be approved.</p>
    <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; padding: 14px 18px; margin: 18px 0; border-radius: 4px;">
      <p style="margin: 0; color: #92400e;"><strong>Reviewer Feedback:</strong> ${data.note}</p>
    </div>
    <p>Please sign in to your Technician Portal to upload a replacement document as soon as possible.</p>
  `;
  return wrapTechEmail('Document Requires Attention', content);
}

export function getTechDocumentExpiringEmail(data: { fullName: string; docType: string; daysLeft: number }): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>This is an automated reminder that your <strong>${data.docType.toUpperCase()}</strong> document on file will expire in <strong>${data.daysLeft} day${data.daysLeft === 1 ? '' : 's'}</strong>.</p>
    <p>To avoid any disruption to your active dispatch status and account verification, please upload your renewed document before the expiration date.</p>
  `;
  return wrapTechEmail('Document Expiration Notice', content);
}

export function getTechDocumentExpiredEmail(data: { fullName: string; docType: string }): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p><strong style="color: #dc2626;">Urgent Notice:</strong> Your <strong>${data.docType.toUpperCase()}</strong> document on file has expired.</p>
    <p>Please log in immediately to your Technician Portal and upload a valid, up-to-date document to prevent your account from being paused or suspended.</p>
  `;
  return wrapTechEmail('Document Expired Notice', content);
}

export function getTechnicianNewOfferEmail(data: {
  fullName: string;
  bookingNumber: string;
  serviceName: string;
  scheduledTime: string;
  portalUrl: string;
}): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>You have received a new service job offer!</p>
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Booking:</strong> #${data.bookingNumber}</p>
      <p style="margin: 0 0 8px 0;"><strong>Service:</strong> ${data.serviceName}</p>
      <p style="margin: 0;"><strong>Scheduled:</strong> ${data.scheduledTime}</p>
    </div>
    <p>Please review and accept or decline this offer promptly before it expires.</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="${data.portalUrl}" style="background-color: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View & Respond to Offer</a>
    </div>
  `;
  return wrapTechEmail('New Job Offer Available', content);
}

export function getCustomerTechnicianAssignedEmail(data: {
  fullName: string;
  bookingNumber: string;
  serviceName: string;
  technicianName: string;
  scheduledTime: string;
}): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>Great news! A certified technician has been assigned to your booking <strong>#${data.bookingNumber}</strong>.</p>
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Assigned Technician:</strong> ${data.technicianName}</p>
      <p style="margin: 0 0 8px 0;"><strong>Service:</strong> ${data.serviceName}</p>
      <p style="margin: 0;"><strong>Scheduled Time:</strong> ${data.scheduledTime}</p>
    </div>
    <p>You will receive further updates once your technician is en route to your vehicle.</p>
  `;
  return wrapTechEmail('Technician Assigned to Your Service', content);
}

export function getCustomerTechnicianEnRouteEmail(data: {
  fullName: string;
  bookingNumber: string;
  technicianName: string;
  trackingUrl?: string;
}): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>Your technician, <strong>${data.technicianName}</strong>, is on the way for booking <strong>#${data.bookingNumber}</strong>!</p>
    <p>Please ensure your vehicle is accessible and any gates or keys are ready.</p>
    ${
      data.trackingUrl
        ? `<div style="text-align: center; margin: 24px 0;"><a href="${data.trackingUrl}" style="background-color: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Track Technician Live</a></div>`
        : ''
    }
  `;
  return wrapTechEmail('Your Technician is On The Way', content);
}

export function getCustomerTechnicianArrivedEmail(data: {
  fullName: string;
  bookingNumber: string;
  technicianName: string;
}): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>Your technician, <strong>${data.technicianName}</strong>, has arrived at the location for booking <strong>#${data.bookingNumber}</strong>.</p>
    <p>Service preparation is now underway.</p>
  `;
  return wrapTechEmail('Technician Has Arrived', content);
}

export function getCustomerJobCompletedEmail(data: {
  fullName: string;
  bookingNumber: string;
  serviceName: string;
}): string {
  const content = `
    <p>Hello ${data.fullName},</p>
    <p>Your service for booking <strong>#${data.bookingNumber}</strong> (${data.serviceName}) has been completed successfully!</p>
    <p>Thank you for choosing Global Integrated Support. We hope your vehicle looks amazing!</p>
  `;
  return wrapTechEmail('Service Completed Successfully', content);
}

export function getAdminDispatchExhaustedEmail(data: {
  bookingNumber: string;
  bookingId: string;
  attempts: number;
  adminBoardUrl: string;
}): string {
  const content = `
    <p><strong style="color: #dc2626;">Attention Dispatch Team:</strong></p>
    <p>Automated dispatch offers have been exhausted for Booking <strong>#${data.bookingNumber}</strong> after <strong>${data.attempts} offer attempt(s)</strong>.</p>
    <p>No remaining eligible candidates accepted the offer. The booking has been moved to the unassigned manual queue.</p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="${data.adminBoardUrl}" style="background-color: #dc2626; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Open Dispatch Board</a>
    </div>
  `;
  return wrapTechEmail('Dispatch Exhausted - Manual Assignment Needed', content);
}

// ---------------------------------------------------------------------------
// Supplier Email Templates
// ---------------------------------------------------------------------------
function wrapSupplierEmail(title: string, contentHtml: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; color: #333333; line-height: 1.6;">
      <div style="background-color: #0f172a; padding: 24px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px;">Global Integrated Support</h1>
        <p style="color: #38bdf8; margin: 6px 0 0 0; font-size: 13px;">Supplier & Parts Marketplace</p>
      </div>
      <div style="padding: 32px 24px;">
        <h2 style="color: #1e293b; margin-top: 0; font-size: 18px; border-bottom: 2px solid #f1f5f9; padding-bottom: 12px;">${title}</h2>
        ${contentHtml}
      </div>
      <div style="background-color: #f8fafc; padding: 16px 24px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
        <p style="margin: 0;">Global Integrated Support (GIS) &bull; Supplier Network</p>
        <p style="margin: 4px 0 0 0;">Need assistance? Contact our supplier desk at support@globalintegratedsupport.com</p>
      </div>
    </div>
  `;
}

export function getSupplierApplicationReceivedEmail(data: { companyName: string }): string {
  const content = `
    <p>Hello ${data.companyName},</p>
    <p>Thank you for registering with Global Integrated Support as a parts and automotive supplier!</p>
    <p>We have received your application. Once your profile and documents are submitted, our administration team will review your business credentials.</p>
    <p>You can manage your supplier profile and upload required documents in the Supplier Portal.</p>
  `;
  return wrapSupplierEmail('Supplier Application Received', content);
}

export function getSupplierNewApplicationAdminEmail(data: { companyName: string; supplierEmail: string; adminUrl: string }): string {
  const content = `
    <p>A new supplier application has been submitted and is awaiting administrative review.</p>
    <div style="background-color: #f1f5f9; padding: 16px; border-radius: 6px; margin: 16px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Company:</strong> ${data.companyName}</p>
      <p style="margin: 0;"><strong>Email:</strong> ${data.supplierEmail}</p>
    </div>
    <div style="margin: 24px 0;">
      <a href="${data.adminUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Review Supplier Application</a>
    </div>
    <p style="font-size: 12px; color: #64748b;">Direct link: ${data.adminUrl}</p>
  `;
  return wrapSupplierEmail('New Supplier Application Submitted', content);
}

export function getSupplierApprovedEmail(data: { companyName: string; portalUrl: string }): string {
  const content = `
    <p>Congratulations ${data.companyName}!</p>
    <p>Your supplier application for Global Integrated Support has been <strong>approved</strong>.</p>
    <p>You can now log in to the Supplier Portal to manage your business profile, inventory, and parts marketplace listings.</p>
    <div style="margin: 24px 0;">
      <a href="${data.portalUrl}" style="background-color: #16a34a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Open Supplier Portal</a>
    </div>
    <p style="font-size: 12px; color: #64748b;">Direct link: ${data.portalUrl}</p>
  `;
  return wrapSupplierEmail('Supplier Application Approved', content);
}

export function getSupplierRejectedEmail(data: { companyName: string; reason: string; portalUrl: string }): string {
  const content = `
    <p>Hello ${data.companyName},</p>
    <p>Thank you for your interest in partnering with Global Integrated Support.</p>
    <p>After reviewing your application, we were unable to approve your supplier profile at this time.</p>
    <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 16px 0; color: #991b1b;">
      <strong>Reason for decision:</strong> ${data.reason}
    </div>
    <p>You may update your business details, provide required documentation, and resubmit your application:</p>
    <div style="margin: 24px 0;">
      <a href="${data.portalUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Update Profile & Documents</a>
    </div>
  `;
  return wrapSupplierEmail('Supplier Application Status Update', content);
}

export function getSupplierSuspendedEmail(data: { companyName: string; reason: string }): string {
  const content = `
    <p>Hello ${data.companyName},</p>
    <p>This notice is to inform you that your Global Integrated Support supplier account has been <strong>suspended</strong>.</p>
    <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 16px 0; color: #991b1b;">
      <strong>Reason:</strong> ${data.reason}
    </div>
    <p>While suspended, your marketplace listings and supplier operations are temporarily paused. If you believe this is in error, please contact supplier support.</p>
  `;
  return wrapSupplierEmail('Supplier Account Suspended', content);
}

export function getSupplierReinstatedEmail(data: { companyName: string; portalUrl: string }): string {
  const content = `
    <p>Hello ${data.companyName},</p>
    <p>Your Global Integrated Support supplier account has been <strong>reinstated</strong>.</p>
    <p>You may resume regular supplier operations immediately.</p>
    <div style="margin: 24px 0;">
      <a href="${data.portalUrl}" style="background-color: #16a34a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Access Supplier Portal</a>
    </div>
  `;
  return wrapSupplierEmail('Supplier Account Reinstated', content);
}

export function getSupplierDocumentRejectedEmail(data: { companyName: string; docType: string; note: string }): string {
  const content = `
    <p>Hello ${data.companyName},</p>
    <p>A document submitted for your supplier verification was rejected during review.</p>
    <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 16px 0; color: #991b1b;">
      <p style="margin: 0 0 4px 0;"><strong>Document:</strong> ${data.docType}</p>
      <p style="margin: 0;"><strong>Feedback:</strong> ${data.note}</p>
    </div>
    <p>Please upload a valid replacement document in the Supplier Portal.</p>
  `;
  return wrapSupplierEmail('Supplier Document Rejected', content);
}

