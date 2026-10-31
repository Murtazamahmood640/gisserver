import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IDispatchSettings extends Document {
  autoDispatch: boolean;
  offerTimeoutSecondsAsap: number;
  offerTimeoutMinutesScheduled: number;
  batchSize: number;
  batchSizeScheduled: number;
  maxOffersPerBooking: number;
  maxDistanceKm: number;
  escalateToAdminOnExhaust: boolean;
  locationMinIntervalSeconds: number;
  onlineRequiredWithinHours: number;
  scheduleBufferMinutes: number;
  allowTrackingStatuses: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IDispatchSettingsModel extends Model<IDispatchSettings> {
  getSettings(): Promise<IDispatchSettings>;
}

const DispatchSettingsSchema = new Schema<IDispatchSettings, IDispatchSettingsModel>(
  {
    autoDispatch: {
      type: Boolean,
      default: false,
    },
    offerTimeoutSecondsAsap: {
      type: Number,
      default: 60,
    },
    offerTimeoutMinutesScheduled: {
      type: Number,
      default: 30,
    },
    batchSize: {
      type: Number,
      default: 1,
    },
    batchSizeScheduled: {
      type: Number,
      default: 3,
    },
    maxOffersPerBooking: {
      type: Number,
      default: 8,
    },
    maxDistanceKm: {
      type: Number,
      default: 50,
    },
    escalateToAdminOnExhaust: {
      type: Boolean,
      default: true,
    },
    locationMinIntervalSeconds: {
      type: Number,
      default: 5,
    },
    onlineRequiredWithinHours: {
      type: Number,
      default: 3,
    },
    scheduleBufferMinutes: {
      type: Number,
      default: 30,
    },
    allowTrackingStatuses: {
      type: [String],
      default: ['technician_en_route', 'arrived', 'in_progress'],
    },
  },
  { timestamps: true }
);

DispatchSettingsSchema.statics.getSettings = async function (): Promise<IDispatchSettings> {
  let doc = await this.findOne();
  if (!doc) {
    doc = await this.create({
      autoDispatch: false,
      offerTimeoutSecondsAsap: 60,
      offerTimeoutMinutesScheduled: 30,
      batchSize: 1,
      batchSizeScheduled: 3,
      maxOffersPerBooking: 8,
      maxDistanceKm: 50,
      escalateToAdminOnExhaust: true,
      locationMinIntervalSeconds: 5,
      onlineRequiredWithinHours: 3,
      scheduleBufferMinutes: 30,
      allowTrackingStatuses: ['technician_en_route', 'arrived', 'in_progress'],
    });
  } else {
    // Ensure default values for newly added fields if existing document lacks them
    let modified = false;
    if (doc.batchSizeScheduled === undefined) {
      doc.batchSizeScheduled = 3;
      modified = true;
    }
    if (doc.onlineRequiredWithinHours === undefined) {
      doc.onlineRequiredWithinHours = 3;
      modified = true;
    }
    if (doc.scheduleBufferMinutes === undefined) {
      doc.scheduleBufferMinutes = 30;
      modified = true;
    }
    if (modified) {
      await doc.save();
    }
  }
  return doc;
};

export const DispatchSettings =
  (mongoose.models.DispatchSettings as IDispatchSettingsModel) ||
  mongoose.model<IDispatchSettings, IDispatchSettingsModel>(
    'DispatchSettings',
    DispatchSettingsSchema,
    'dispatchSettings'
  );
