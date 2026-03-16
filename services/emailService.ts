import nodemailer from 'nodemailer';

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
transporter.verify((error, success) => {
  if (error) {
    console.error('Stackmail configuration error:', error);
  } else {
    console.log('Stackmail ready to send emails');
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
      from: `"Luxe Detail Booker" <${process.env.STACKMAIL_USER}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || options.html.replace(/<[^>]*>/g, ''),
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('Email sent:', result.messageId);
    return result;
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

export function getBookingConfirmationEmail(booking: {
  fullName: string;
  serviceType: string;
  date: string;
  timeSlot: string;
  totalPrice: number;
  basePrice?: number;
  discount?: number;
  coupons?: string;
}): string {
  return `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2>Booking Confirmation</h2>
      <p>Dear ${booking.fullName},</p>
      <p>Thank you for booking with Global Integrated support! Your appointment has been confirmed.</p>
      
      <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
        <h3>Booking Details</h3>
        <p><strong>Service:</strong> ${booking.serviceType}</p>
        <p><strong>Date:</strong> ${booking.date}</p>
        <p><strong>Time:</strong> ${booking.timeSlot}</p>
        ${booking.basePrice ? `<p><strong>Base Price:</strong> $${booking.basePrice.toFixed(2)}</p>` : ''}
        ${booking.discount ? `<p><strong>Discount:</strong> -$${booking.discount.toFixed(2)}</p>` : ''}
        ${booking.coupons ? `<p><strong>Applied Coupons:</strong> ${booking.coupons}</p>` : ''}
        <p><strong>Final Price:</strong> $${booking.totalPrice.toFixed(2)}</p>
      </div>
      
      <p>We look forward to serving you!</p>
      <p style="margin-top: 30px; color: #666; font-size: 12px;">
        Luxe Detail Booker<br>
        Email: info@vornoxlab.com
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
      <p>Thank you for contacting Luxe Detail Booker. We have received your message and will get back to you as soon as possible.</p>
      
      <p style="margin-top: 30px; color: #666; font-size: 12px;">
        Best regards,<br>
        Luxe Detail Booker Team<br>
        Email: info@vornoxlab.com
      </p>
    </div>
  `;
}

export function getAdminNotificationEmail(booking: {
  fullName: string;
  phone: string;
  email: string;
  serviceType: string;
  date: string;
  timeSlot: string;
  vehicleName: string;
  totalPrice: number;
}): string {
  return `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2>New Booking Received</h2>
      
      <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
        <h3>Customer Details</h3>
        <p><strong>Name:</strong> ${booking.fullName}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Phone:</strong> ${booking.phone}</p>
        
        <h3 style="margin-top: 20px;">Booking Details</h3>
        <p><strong>Vehicle:</strong> ${booking.vehicleName}</p>
        <p><strong>Service:</strong> ${booking.serviceType}</p>
        <p><strong>Date:</strong> ${booking.date}</p>
        <p><strong>Time:</strong> ${booking.timeSlot}</p>
        <p><strong>Total Price:</strong> $${booking.totalPrice.toFixed(2)}</p>
      </div>
    </div>
  `;
}
