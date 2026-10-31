import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().email('Valid email address is required'),
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Valid email address is required'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters long'),
});

export const appointmentSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required'),
  phone: z.string().trim().min(1, 'Phone number is required'),
  email: z.string().trim().email('Valid email address is required'),
  address: z.string().trim().min(1, 'Address is required'),
  streetAddress: z.string().trim().optional(),
  aptUnit: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  zipCode: z.string().trim().optional(),
  serviceType: z.string().trim().min(1, 'Service type is required'),
  vehicleCategory: z.string().trim().optional(),
  vehicleName: z.string().trim().optional(),
  make: z.string().trim().optional(),
  vehicleModel: z.string().trim().optional(),
  year: z.union([z.string(), z.number()]).transform((val) => String(val)).optional(),
  date: z.string().trim().min(1, 'Appointment date is required'),
  timeSlot: z.string().trim().min(1, 'Time slot is required'),
  promoCode: z.string().trim().optional(),
  coupons: z
    .array(
      z.object({
        code: z.string().optional(),
        discountPercentage: z.number().optional(),
        discountAmount: z.number().optional(),
      })
    )
    .optional(),
  addons: z
    .array(
      z.object({
        name: z.string().optional(),
        price: z.number().optional(),
      })
    )
    .optional(),
  basePrice: z.coerce.number().positive('Base price must be a positive number'),
  totalDiscount: z.coerce.number().optional().default(0),
  discountApplied: z.boolean().optional().default(false),
  totalPrice: z.coerce.number().nonnegative('Total price must be non-negative'),
  status: z.enum(['Pending', 'Confirmed', 'Completed', 'Cancelled']).optional(),
});

export const contactSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required'),
  email: z.string().trim().email('Valid email address is required'),
  phone: z.string().trim().min(1, 'Phone number is required'),
  subject: z.string().trim().min(1, 'Subject is required'),
  message: z.string().trim().min(1, 'Message is required'),
});

export const feedbackSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email: z.string().trim().email('Valid email address is required').optional().or(z.literal('')),
  rating: z.coerce
    .number()
    .min(1, 'Rating must be at least 1')
    .max(5, 'Rating cannot exceed 5'),
  title: z.string().trim().optional().default(''),
  feedback: z.string().trim().min(1, 'Feedback message is required'),
  status: z.enum(['pending', 'draft', 'publish']).optional(),
  source: z.enum(['manual', 'facebook']).optional(),
});
