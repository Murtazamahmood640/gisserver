import mongoose, { Document, Schema } from 'mongoose';

export type PricingModel = 'fixed' | 'by-vehicle-category' | 'quote' | 'distance';

export interface IService extends Document {
  categoryId: mongoose.Types.ObjectId;
  slug: string;
  name: string;
  description?: string;
  durationMinutes: number;
  images: string[];
  isActive: boolean;
  pricingModel: PricingModel;
  createdAt: Date;
  updatedAt: Date;
}

const ServiceSchema = new Schema<IService>(
  {
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCategory',
      required: [true, 'Category ID is required'],
      index: true,
    },
    slug: {
      type: String,
      required: [true, 'Slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Service name is required'],
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    durationMinutes: {
      type: Number,
      default: 60,
      min: 0,
    },
    images: {
      type: [String],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    pricingModel: {
      type: String,
      enum: ['fixed', 'by-vehicle-category', 'quote', 'distance'],
      default: 'by-vehicle-category',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

export const Service =
  mongoose.models.Service ||
  mongoose.model<IService>('Service', ServiceSchema, 'services');
