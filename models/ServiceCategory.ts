import mongoose, { Document, Schema } from 'mongoose';

export interface IServiceCategory extends Document {
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  isActive: boolean;
  sortOrder: number;
  requiresLocation: boolean;
  allowsScheduling: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ServiceCategorySchema = new Schema<IServiceCategory>(
  {
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
      required: [true, 'Category name is required'],
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    icon: {
      type: String,
      default: 'Wrench',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },
    requiresLocation: {
      type: Boolean,
      default: true,
    },
    allowsScheduling: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

export const ServiceCategory =
  mongoose.models.ServiceCategory ||
  mongoose.model<IServiceCategory>('ServiceCategory', ServiceCategorySchema, 'serviceCategories');
