import { z } from 'zod';

export const vehicleCategoriesEnum = z.enum([
  'sedan',
  'crossover',
  'suv',
  'truck',
  'rv-boat-semi',
]);

export const priceLookupSchema = z.object({
  serviceId: z.string().optional(),
  serviceSlug: z.string().optional(),
  vehicleCategory: z.preprocess(
    (val) => (typeof val === 'string' ? val.toLowerCase().replace(/[\s/_]+/g, '-').replace('rv-boat-semi', 'rv-boat-semi') : val),
    vehicleCategoriesEnum
  ),
});

export const createPriceSchema = z.object({
  serviceId: z.string().min(1, 'Service ID is required'),
  vehicleCategory: vehicleCategoriesEnum,
  price: z.coerce
    .number()
    .int('Price must be an integer (in cents)')
    .positive('Price must be a positive integer in cents'),
});

export const updatePriceSchema = z.object({
  price: z.coerce
    .number()
    .int('Price must be an integer (in cents)')
    .positive('Price must be a positive integer in cents'),
});

export const createCommissionRuleSchema = z
  .object({
    scope: z.enum(['global', 'category', 'service']).default('global'),
    scopeId: z.string().nullable().optional(),
    commissionPercent: z.coerce
      .number()
      .min(0, 'Commission percent cannot be negative')
      .max(100, 'Commission percent cannot exceed 100'),
    processingPercent: z.coerce
      .number()
      .min(0, 'Processing percent cannot be negative')
      .max(100, 'Processing percent cannot exceed 100'),
    isActive: z.boolean().optional().default(true),
  })
  .refine(
    (data) => data.commissionPercent + data.processingPercent <= 100,
    {
      message: 'Sum of commissionPercent and processingPercent cannot exceed 100%',
      path: ['commissionPercent'],
    }
  );

export const updateCommissionRuleSchema = z
  .object({
    scope: z.enum(['global', 'category', 'service']).optional(),
    scopeId: z.string().nullable().optional(),
    commissionPercent: z.coerce
      .number()
      .min(0, 'Commission percent cannot be negative')
      .max(100, 'Commission percent cannot exceed 100')
      .optional(),
    processingPercent: z.coerce
      .number()
      .min(0, 'Processing percent cannot be negative')
      .max(100, 'Processing percent cannot exceed 100')
      .optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (data.commissionPercent !== undefined && data.processingPercent !== undefined) {
        return data.commissionPercent + data.processingPercent <= 100;
      }
      return true;
    },
    {
      message: 'Sum of commissionPercent and processingPercent cannot exceed 100%',
      path: ['commissionPercent'],
    }
  );
