import mongoose, { Document, Schema } from 'mongoose';

export interface ITechnicianLocation extends Document {
  technicianUserId: mongoose.Types.ObjectId;
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  heading?: number;
  speed?: number;
  accuracy?: number;
  bookingId?: mongoose.Types.ObjectId | null;
  updatedAt: Date;
}

const TechnicianLocationSchema = new Schema<ITechnicianLocation>(
  {
    technicianUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
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
    heading: {
      type: Number,
    },
    speed: {
      type: Number,
    },
    accuracy: {
      type: Number,
    },
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
      index: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

// 2dsphere index for geo proximity queries
TechnicianLocationSchema.index({ location: '2dsphere' });

// TTL index: documents expire 24 hours after last update
TechnicianLocationSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });

export const TechnicianLocation =
  mongoose.models.TechnicianLocation ||
  mongoose.model<ITechnicianLocation>('TechnicianLocation', TechnicianLocationSchema, 'technicianLocations');
