import mongoose, { Document, Schema } from 'mongoose';

export interface IStripeEvent extends Document {
  eventId: string;
  type: string;
  processedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const StripeEventSchema = new Schema<IStripeEvent>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
    },
    processedAt: {
      type: Date,
      default: Date.now,
      required: true,
      index: { expires: 7776000 }, // 90 days TTL
    },
  },
  { timestamps: true }
);

export const StripeEvent =
  (mongoose.models.StripeEvent as mongoose.Model<IStripeEvent>) ||
  mongoose.model<IStripeEvent>('StripeEvent', StripeEventSchema);
