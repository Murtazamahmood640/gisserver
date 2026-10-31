import mongoose, { Document, Schema } from 'mongoose';

export interface IPayoutAdjustment extends Document {
  technicianUserId: mongoose.Types.ObjectId;
  bookingId: mongoose.Types.ObjectId;
  amountCents: number; // negative
  reason: 'refund_after_payout';
  settledInPayoutId?: mongoose.Types.ObjectId; // sparse, never null
  createdAt: Date;
  updatedAt: Date;
}

const PayoutAdjustmentSchema = new Schema<IPayoutAdjustment>(
  {
    technicianUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      index: true,
    },
    amountCents: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      enum: ['refund_after_payout'],
      default: 'refund_after_payout',
      required: true,
    },
    settledInPayoutId: {
      type: Schema.Types.ObjectId,
      ref: 'Payout',
      sparse: true,
      index: true,
    },
  },
  { timestamps: true }
);

PayoutAdjustmentSchema.index({ technicianUserId: 1, settledInPayoutId: 1 }, { sparse: true });

export const PayoutAdjustment =
  (mongoose.models.PayoutAdjustment as mongoose.Model<IPayoutAdjustment>) ||
  mongoose.model<IPayoutAdjustment>('PayoutAdjustment', PayoutAdjustmentSchema, 'payoutAdjustments');
