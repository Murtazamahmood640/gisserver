import mongoose, { Document, Schema } from 'mongoose';

export type PaymentStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'expired'
  | 'partially_refunded'
  | 'refunded';

export type PaymentSource = 'stripe' | 'offline';

export interface IPaymentHistoryEntry {
  action: string;
  amountCents: number;
  by: string;
  at: Date;
  note?: string;
}

export interface IPayment extends Document {
  bookingId: mongoose.Types.ObjectId;
  customerId?: mongoose.Types.ObjectId;
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  source: PaymentSource;
  refundedCents: number;
  stripeFeeCents?: number;
  stripeNetCents?: number;
  paidAt?: Date;
  offline?: { method: 'bank' | 'cash' | 'other'; reference: string };
  history: IPaymentHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const PaymentHistoryEntrySchema = new Schema<IPaymentHistoryEntry>(
  {
    action: { type: String, required: true },
    amountCents: { type: Number, required: true },
    by: { type: String, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String },
  },
  { _id: false }
);

const PaymentSchema = new Schema<IPayment>(
  {
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
      index: true,
    },
    stripeCheckoutSessionId: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
    },
    stripePaymentIntentId: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
    },
    amountCents: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'usd',
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'expired', 'partially_refunded', 'refunded'],
      default: 'pending',
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['stripe', 'offline'],
      default: 'stripe',
      required: true,
    },
    refundedCents: {
      type: Number,
      default: 0,
      required: true,
    },
    stripeFeeCents: {
      type: Number,
    },
    stripeNetCents: {
      type: Number,
    },
    paidAt: {
      type: Date,
    },
    offline: {
      method: { type: String, enum: ['bank', 'cash', 'other'] },
      reference: { type: String },
    },
    history: {
      type: [PaymentHistoryEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

export const Payment =
  (mongoose.models.Payment as mongoose.Model<IPayment>) ||
  mongoose.model<IPayment>('Payment', PaymentSchema);
