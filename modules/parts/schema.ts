import { z } from 'zod';

export const vehicleCompatibilitySchema = z.object({
  make: z.string().trim().min(1, 'Vehicle make is required'),
  model: z.string().trim().min(1, 'Vehicle model is required'),
  yearStart: z.number().int().min(1900).max(2100).optional(),
  yearEnd: z.number().int().min(1900).max(2100).optional(),
  engine: z.string().trim().optional(),
  trim: z.string().trim().optional(),
  notes: z.string().trim().max(500).optional(),
}).refine(
  (data) => {
    if (data.yearStart && data.yearEnd) {
      return data.yearStart <= data.yearEnd;
    }
    return true;
  },
  {
    message: 'yearStart must be less than or equal to yearEnd',
    path: ['yearEnd'],
  }
);

export const productImageSchema = z.object({
  url: z.string().url('Invalid image URL'),
  alt: z.string().trim().max(200).optional().default(''),
  isPrimary: z.boolean().optional().default(false),
});

export const createProductSchema = z.object({
  name: z.string().trim().min(2, 'Product name must be at least 2 characters').max(200),
  sku: z.string().trim().min(2, 'SKU must be at least 2 characters').max(50),
  brand: z.string().trim().min(1, 'Brand is required').max(100),
  manufacturer: z.string().trim().max(100).optional(),
  description: z.string().trim().min(5, 'Description must be at least 5 characters').max(5000),
  category: z.string().trim().min(1, 'Category is required'),
  subcategory: z.string().trim().max(100).optional(),
  priceCents: z.number().int('Price must be an integer (cents)').min(0, 'Price must be positive or zero'),
  currency: z.string().trim().length(3).default('USD'),
  stockQuantity: z.number().int('Stock must be an integer').min(0, 'Stock cannot be negative').default(0),
  lowStockThreshold: z.number().int().min(0).default(5),
  condition: z.enum(['new', 'used', 'refurbished']).default('new'),
  compatibility: z.array(vehicleCompatibilitySchema).optional().default([]),
  images: z.array(productImageSchema).optional().default([]),
  status: z.enum(['draft', 'pending_review', 'active']).optional().default('draft'),
});

export const updateProductSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  sku: z.string().trim().min(2).max(50).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  manufacturer: z.string().trim().max(100).optional(),
  description: z.string().trim().min(5).max(5000).optional(),
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().max(100).optional(),
  priceCents: z.number().int().min(0).optional(),
  currency: z.string().trim().length(3).optional(),
  stockQuantity: z.number().int().min(0).optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  condition: z.enum(['new', 'used', 'refurbished']).optional(),
  compatibility: z.array(vehicleCompatibilitySchema).optional(),
  images: z.array(productImageSchema).optional(),
  status: z.enum(['draft', 'pending_review', 'active', 'archived']).optional(),
});

export const adjustStockSchema = z.object({
  change: z.number().int('Stock change must be an integer').optional(),
  newQuantity: z.number().int('New quantity must be an integer').min(0, 'New quantity cannot be negative').optional(),
  reason: z.enum([
    'initial_stock',
    'restock',
    'manual_adjustment',
    'damaged',
    'audit',
    'correction',
  ]),
  notes: z.string().trim().max(500).optional(),
}).refine(
  (data) => data.change !== undefined || data.newQuantity !== undefined,
  {
    message: 'Either change or newQuantity must be provided',
  }
);

export const uploadProductImageSchema = z.object({
  image: z.string().min(1, 'Image data (base64 or URL) is required').optional(),
  alt: z.string().trim().max(200).optional().default(''),
  isPrimary: z.boolean().optional().default(false),
});

export const adminRejectProductSchema = z.object({
  reason: z.string().trim().min(3, 'Rejection reason must be at least 3 characters').max(500),
});

export const adminArchiveProductSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const createPartCategorySchema = z.object({
  slug: z.string().trim().min(2).max(50).toLowerCase(),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional().default(''),
  icon: z.string().trim().max(50).optional().default('Package'),
  subcategories: z.array(z.string().trim()).optional().default([]),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional().default(0),
});

export const updatePartCategorySchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  icon: z.string().trim().max(50).optional(),
  subcategories: z.array(z.string().trim()).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const createPartOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().trim().min(1, 'productId is required'),
        quantity: z.number().int().min(1, 'Quantity must be at least 1'),
      })
    )
    .min(1, 'At least one item is required in an order'),
  shippingAddress: z.object({
    fullName: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    line1: z.string().trim().min(1, 'Street address is required'),
    line2: z.string().trim().optional(),
    city: z.string().trim().min(1, 'City is required'),
    state: z.string().trim().min(1, 'State is required'),
    zip: z.string().trim().min(1, 'Zip code is required'),
    country: z.string().trim().optional().default('USA'),
  }),
  notes: z.string().trim().max(500).optional(),
});

export const updatePartOrderStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'], {
    message: 'Invalid order status',
  }),
  note: z.string().trim().max(500).optional(),
});
