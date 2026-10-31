import mongoose, { Document, Schema } from 'mongoose';

export interface IAddon extends Document {
  name: string;
  price: number; // Integer cents
  serviceIds: mongoose.Types.ObjectId[];
  categoryId?: mongoose.Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AddonSchema = new Schema<IAddon>(
  {
    name: {
      type: String,
      required: [true, 'Addon name is required'],
      trim: true,
    },
    price: {
      type: Number,
      required: [true, 'Price in cents is required'],
      min: [1, 'Price must be a positive integer in cents'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} is not an integer. Store money as integer cents.',
      },
    },
    serviceIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Service',
      },
    ],
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCategory',
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

export const Addon =
  mongoose.models.Addon ||
  mongoose.model<IAddon>('Addon', AddonSchema, 'addons');
