import mongoose, { Document, Schema } from 'mongoose';

export interface ILocationPing extends Document {
  bookingId: mongoose.Types.ObjectId;
  technicianUserId: mongoose.Types.ObjectId;
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  at: Date;
}

const LocationPingSchema = new Schema<ILocationPing>(
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
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
        required: true,
      },
      coordinates: {
        type: [Number], // [lng, lat]
        required: true,
      },
    },
    at: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  { timestamps: false }
);

// Compound index for chronological tracking lookups by booking
LocationPingSchema.index({ bookingId: 1, at: 1 });

// TTL index: audit trail expires after 7 days
LocationPingSchema.index({ at: 1 }, { expireAfterSeconds: 604800 });

export const LocationPing =
  mongoose.models.LocationPing ||
  mongoose.model<ILocationPing>('LocationPing', LocationPingSchema, 'locationPings');
