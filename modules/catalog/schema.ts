import { z } from 'zod';

export const createCategorySchema = z.object({
  slug: z.string().trim().min(2, 'Slug must be at least 2 characters').regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().trim().min(2, 'Name must be at least 2 characters'),
  description: z.string().trim().optional().default(''),
  icon: z.string().trim().optional().default('Wrench'),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.coerce.number().optional().default(0),
  requiresLocation: z.boolean().optional().default(true),
  allowsScheduling: z.boolean().optional().default(true),
});

export const updateCategorySchema = createCategorySchema.partial();

export const createServiceSchema = z.object({
  categoryId: z.string().min(1, 'Category ID is required'),
  slug: z.string().trim().min(2, 'Slug must be at least 2 characters').regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().trim().min(2, 'Name must be at least 2 characters'),
  description: z.string().trim().optional().default(''),
  durationMinutes: z.coerce.number().min(0).optional().default(60),
  images: z.array(z.string().url('Image must be a valid URL')).optional().default([]),
  isActive: z.boolean().optional().default(true),
  pricingModel: z.enum(['fixed', 'by-vehicle-category', 'quote', 'distance']).optional().default('by-vehicle-category'),
});

export const updateServiceSchema = createServiceSchema.partial();

export const createAddonSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters'),
  price: z.coerce
    .number()
    .int('Price must be an integer (in cents)')
    .positive('Price must be a positive integer in cents'),
  serviceIds: z.array(z.string()).optional().default([]),
  categoryId: z.string().optional(),
  isActive: z.boolean().optional().default(true),
});

export const updateAddonSchema = createAddonSchema.partial();

export const validateCouponSchema = z.object({
  code: z.string().trim().min(1, 'Coupon code is required'),
  subtotalCents: z.coerce
    .number()
    .int('Subtotal must be an integer in cents')
    .nonnegative('Subtotal cannot be negative'),
});
