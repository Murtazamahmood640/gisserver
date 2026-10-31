import mongoose, { Document, Schema } from 'mongoose';

export type DispatchOfferStatus = 'sent' | 'accepted' | 'declined' | 'expired' | 'cancelled';
export type DispatchOfferSource = 'auto' | 'manual';

export interface IDispatchOffer extends Document {
  bookingId: mongoose.Types.ObjectId;
  technicianUserId: mongoose.Types.ObjectId;
  status: DispatchOfferStatus;
  sentAt: Date;
  expiresAt: Date;
  respondedAt?: Date;
  declineReason?: string;
  rank: number;
  distanceKm?: number | null;
  source: DispatchOfferSource;
  createdAt: Date;
  updatedAt: Date;
}

const DispatchOfferSchema = new Schema<IDispatchOffer>(
  {
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      index: true,
    },
    technicianUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['sent', 'accepted', 'declined', 'expired', 'cancelled'],
      default: 'sent',
      required: true,
      index: true,
    },
    sentAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    respondedAt: {
      type: Date,
    },
    declineReason: {
      type: String,
    },
    rank: {
      type: Number,
      required: true,
    },
    distanceKm: {
      type: Number,
      default: null,
    },
    source: {
      type: String,
      enum: ['auto', 'manual'],
      default: 'auto',
      required: true,
    },
  },
  { timestamps: true }
);

// One active offer per pair per booking
DispatchOfferSchema.index({ bookingId: 1, technicianUserId: 1 }, { unique: true });

// Technician queries for pending offers with expiry
DispatchOfferSchema.index({ technicianUserId: 1, status: 1, expiresAt: 1 });

// Sweeper index for expired offers
DispatchOfferSchema.index({ status: 1, expiresAt: 1 });

export const DispatchOffer =
  mongoose.models.DispatchOffer ||
  mongoose.model<IDispatchOffer>('DispatchOffer', DispatchOfferSchema, 'dispatchOffers');
