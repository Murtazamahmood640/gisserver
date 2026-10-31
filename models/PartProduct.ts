import mongoose, { Document, Schema } from 'mongoose';

export type PartProductCondition = 'new' | 'used' | 'refurbished';
export type PartProductStatus = 'draft' | 'pending_review' | 'active' | 'rejected' | 'archived';

export interface IProductVehicleCompatibility {
  make: string;
  model: string;
  yearStart?: number;
  yearEnd?: number;
  engine?: string;
  trim?: string;
  notes?: string;
}

export interface IProductImage {
  url: string;
  alt?: string;
  isPrimary?: boolean;
}

export interface IPartProductStatusHistory {
  status: PartProductStatus;
  by: string;
  at: Date;
  note?: string;
}

export interface IPartProduct extends Document {
  supplierId: mongoose.Types.ObjectId;
  name: string;
  sku: string;
  brand: string;
  manufacturer?: string;
  description: string;
  category: string; // e.g. 'brakes'
  subcategory?: string;
  images: IProductImage[];
  priceCents: number;
  currency: string;
  stockQuantity: number;
  lowStockThreshold: number;
  condition: PartProductCondition;
  compatibility: IProductVehicleCompatibility[];
  status: PartProductStatus;
  rejectionReason?: string;
  adminNotes?: string;
  statusHistory: IPartProductStatusHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const VehicleCompatibilitySchema = new Schema<IProductVehicleCompatibility>(
  {
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    yearStart: { type: Number },
    yearEnd: { type: Number },
    engine: { type: String, trim: true },
    trim: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const ProductImageSchema = new Schema<IProductImage>(
  {
    url: { type: String, required: true, trim: true },
    alt: { type: String, trim: true, default: '' },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false }
);

const ProductStatusHistorySchema = new Schema<IPartProductStatusHistory>(
  {
    status: { type: String, required: true },
    by: { type: String, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const PartProductSchema = new Schema<IPartProduct>(
  {
    supplierId: {
      type: Schema.Types.ObjectId,
      ref: 'SupplierProfile',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    sku: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    brand: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    manufacturer: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    subcategory: {
      type: String,
      trim: true,
    },
    images: {
      type: [ProductImageSchema],
      default: [],
    },
    priceCents: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'USD',
      trim: true,
      uppercase: true,
    },
    stockQuantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    lowStockThreshold: {
      type: Number,
      default: 5,
      min: 0,
    },
    condition: {
      type: String,
      enum: ['new', 'used', 'refurbished'],
      default: 'new',
    },
    compatibility: {
      type: [VehicleCompatibilitySchema],
      default: [],
    },
    status: {
      type: String,
      enum: ['draft', 'pending_review', 'active', 'rejected', 'archived'],
      default: 'draft',
      index: true,
    },
    rejectionReason: {
      type: String,
      trim: true,
    },
    adminNotes: {
      type: String,
      trim: true,
    },
    statusHistory: {
      type: [ProductStatusHistorySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// SKU uniqueness per supplier
PartProductSchema.index({ supplierId: 1, sku: 1 }, { unique: true });

// Filter indexes
PartProductSchema.index({ status: 1, category: 1 });
PartProductSchema.index({ status: 1, brand: 1 });
PartProductSchema.index({ supplierId: 1, status: 1 });
PartProductSchema.index({ 'compatibility.make': 1, 'compatibility.model': 1 });

// Full text search
PartProductSchema.index({ name: 'text', brand: 'text', sku: 'text', description: 'text' });

export const PartProduct =
  mongoose.models.PartProduct ||
  mongoose.model<IPartProduct>('PartProduct', PartProductSchema, 'partProducts');
