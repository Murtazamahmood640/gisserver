import { z } from 'zod';

export const notificationPreferencesSchema = z.object({
  email: z.boolean().optional(),
  push: z.boolean().optional(),
  sms: z.boolean().optional(),
});

export const updateCustomerProfileSchema = z.object({
  notificationPreferences: notificationPreferencesSchema.optional(),
});

export const addressSchema = z.object({
  label: z.string().optional().default('Home'),
  line1: z.string().min(1, 'Street address line 1 is required'),
  line2: z.string().optional().default(''),
  city: z.string().min(1, 'City is required'),
  state: z.string().min(1, 'State is required'),
  zip: z.string().min(1, 'ZIP code is required'),
  country: z.string().optional().default('USA'),
  propertyType: z.enum(['house', 'apartment', 'business', 'other']).optional().default('house'),
  gateCode: z.string().optional().default(''),
  parkingInstructions: z.string().optional().default(''),
  hasWaterHookup: z.boolean().optional().default(false),
  hasPowerHookup: z.boolean().optional().default(false),
  location: z
    .object({
      type: z.literal('Point').default('Point'),
      coordinates: z.tuple([z.number(), z.number()]), // [lng, lat]
    })
    .optional(),
  isDefault: z.boolean().optional().default(false),
});

export const updateAddressSchema = addressSchema.partial();
