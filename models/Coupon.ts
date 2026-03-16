import mongoose from 'mongoose';

export interface ICoupon extends mongoose.Document {
  code: string;
  discountPercentage: number;
  expiryDate: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new mongoose.Schema<ICoupon>(
  {
    code: {
      type: String,
      required: [true, 'Coupon code is required'],
      unique: true,
      uppercase: true,
      match: [/^[A-Z0-9]{3,20}$/, 'Code must be alphanumeric and 3-20 characters'],
    },
    discountPercentage: {
      type: Number,
      required: [true, 'Discount percentage is required'],
      min: [1, 'Discount must be at least 1%'],
      max: [100, 'Discount cannot exceed 100%'],
    },
    expiryDate: {
      type: Date,
      required: [true, 'Expiry date is required'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Index for efficient querying
couponSchema.index({ code: 1 });
couponSchema.index({ isActive: 1 });

export const Coupon =
  mongoose.models.Coupon || mongoose.model<ICoupon>('Coupon', couponSchema);
