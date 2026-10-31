import { z } from 'zod';

export const registerSupplierSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    fullName: z.string().min(2).max(100),
    phone: z.string().optional(),
    companyName: z.string().min(2).max(150),
    tradingName: z.string().max(150).optional(),
    businessType: z.enum([
      'manufacturer',
      'distributor',
      'wholesaler',
      'retailer',
      'salvage',
      'other',
    ]),
    taxId: z.string().max(50).optional(),
    businessRegistrationNumber: z.string().max(50).optional(),
    website: z.string().url().or(z.literal('')).optional(),
    description: z.string().max(2000).optional(),
    businessPhone: z.string().optional(),
    supportEmail: z.string().email().optional(),
    businessAddress: z
      .object({
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zipCode: z.string().optional(),
        country: z.string().optional(),
      })
      .optional(),
    dispatchWarehouseAddress: z
      .object({
        street: z.string().optional(),
        suiteOrDock: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zipCode: z.string().optional(),
        country: z.string().optional(),
      })
      .optional(),
    categories: z.array(z.string().min(1)).optional(),
    brandsSpecialized: z.array(z.string()).optional(),
    estimatedSkuCount: z.string().optional(),
    catalogMethod: z.enum(['manual', 'csv', 'api']).optional(),
    willCallPickupAllowed: z.boolean().optional(),
    fulfillmentLeadTimeHours: z.number().optional(),
    warrantyPeriod: z.string().optional(),
    returnWindowDays: z.number().optional(),
    restockingFeePercent: z.number().optional(),
  })
  .strict();

export const applySupplierSchema = z
  .object({
    companyName: z.string().min(2).max(150),
    businessType: z.enum([
      'manufacturer',
      'distributor',
      'wholesaler',
      'retailer',
      'salvage',
      'other',
    ]),
    taxId: z.string().max(50).optional(),
    website: z.string().url().or(z.literal('')).optional(),
    description: z.string().max(2000).optional(),
    businessPhone: z.string().optional(),
    supportEmail: z.string().email().optional(),
    businessAddress: z
      .object({
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zipCode: z.string().optional(),
        country: z.string().optional(),
      })
      .optional(),
    categories: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const updateSupplierProfileSchema = z
  .object({
    companyName: z.string().min(2).max(150).optional(),
    tradingName: z.string().max(150).optional(),
    businessType: z
      .enum(['manufacturer', 'distributor', 'wholesaler', 'retailer', 'salvage', 'other'])
      .optional(),
    taxId: z.string().max(50).optional(),
    businessRegistrationNumber: z.string().max(50).optional(),
    website: z.string().url().or(z.literal('')).optional(),
    description: z.string().max(2000).optional(),
    categories: z.array(z.string().min(1)).optional(),
    brandsSpecialized: z.array(z.string()).optional(),
    estimatedSkuCount: z.string().optional(),
    catalogMethod: z.enum(['manual', 'csv', 'api']).optional(),
    willCallPickupAllowed: z.boolean().optional(),
    fulfillmentLeadTimeHours: z.number().optional(),
    warrantyPeriod: z.string().optional(),
    returnWindowDays: z.number().optional(),
    restockingFeePercent: z.number().optional(),
    payoutDetails: z
      .object({
        bankName: z.string().optional(),
        routingNumber: z.string().optional(),
        accountNumberLast4: z.string().optional(),
      })
      .optional(),
    contactPerson: z
      .object({
        name: z.string().optional(),
        title: z.string().optional(),
        email: z.string().email().or(z.literal('')).optional(),
        phone: z.string().optional(),
      })
      .optional(),
    businessPhone: z.string().optional(),
    supportEmail: z.string().email().or(z.literal('')).optional(),
    businessAddress: z
      .object({
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zipCode: z.string().optional(),
        country: z.string().optional(),
      })
      .optional(),
    dispatchWarehouseAddress: z
      .object({
        street: z.string().optional(),
        suiteOrDock: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zipCode: z.string().optional(),
        country: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export const adminRejectSupplierSchema = z
  .object({
    reason: z.string().min(1, 'Rejection reason is required'),
  })
  .strict();

export const adminSuspendSupplierSchema = z
  .object({
    reason: z.string().min(1, 'Suspension reason is required'),
  })
  .strict();

export const adminReviewDocumentSchema = z
  .object({
    note: z.string().optional(),
  })
  .strict();

export const adminRejectDocumentSchema = z
  .object({
    note: z.string().min(1, 'Rejection note is required'),
  })
  .strict();
