import mongoose, { Document, Schema } from 'mongoose';

export type PayoutStatus = 'draft' | 'paid' | 'void';
export type PayoutMethod = 'bank' | 'cash' | 'other';

export interface IPayoutHistoryEntry {
  action: string;
  by: string;
  at: Date;
  note?: string;
}

export interface IPayout extends Document {
  technicianUserId: mongoose.Types.ObjectId;
  status: PayoutStatus;
  bookingIds: mongoose.Types.ObjectId[];
  grossCents: number;
  adjustmentsCents: number; // negative or zero
  netCents: number;
  periodTo?: Date;
  reference?: string;
  method?: PayoutMethod;
  paidAt?: Date;
  paidBy?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  notes?: string;
  history: IPayoutHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const PayoutHistoryEntrySchema = new Schema<IPayoutHistoryEntry>(
  {
    action: { type: String, required: true },
    by: { type: String, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String },
  },
  { _id: false }
);

const PayoutSchema = new Schema<IPayout>(
  {
    technicianUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['draft', 'paid', 'void'],
      default: 'draft',
      required: true,
      index: true,
    },
    bookingIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Booking',
      },
    ],
    grossCents: {
      type: Number,
      required: true,
      default: 0,
    },
    adjustmentsCents: {
      type: Number,
      required: true,
      default: 0,
    },
    netCents: {
      type: Number,
      required: true,
      default: 0,
    },
    periodTo: {
      type: Date,
    },
    reference: {
      type: String,
    },
    method: {
      type: String,
      enum: ['bank', 'cash', 'other'],
    },
    paidAt: {
      type: Date,
    },
    paidBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    notes: {
      type: String,
    },
    history: {
      type: [PayoutHistoryEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

PayoutSchema.index({ technicianUserId: 1, status: 1 });

export const Payout =
  (mongoose.models.Payout as mongoose.Model<IPayout>) ||
  mongoose.model<IPayout>('Payout', PayoutSchema, 'payouts');
