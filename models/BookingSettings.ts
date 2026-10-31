import mongoose, { Document, Schema } from 'mongoose';

export interface ICancellationSettings {
  freeCancelHours: number;
  lateFeePercent: number;
}

export interface IBookingSettings extends Document {
  businessTimezone: string;
  slots: string[]; // 24h format "HH:mm"
  slotCapacity: number;
  minLeadHours: number;
  maxAdvanceDays: number;
  cancellation: ICancellationSettings;
  closedDates: string[]; // "YYYY-MM-DD"
  createdAt: Date;
  updatedAt: Date;
}

const BookingSettingsSchema = new Schema<IBookingSettings>(
  {
    businessTimezone: {
      type: String,
      default: () => process.env.BUSINESS_TIMEZONE || 'America/New_York',
    },
    slots: {
      type: [String],
      default: [
        '08:00',
        '09:00',
        '10:00',
        '11:00',
        '12:00',
        '13:00',
        '14:00',
        '15:00',
        '16:00',
        '17:00',
      ],
    },
    slotCapacity: {
      type: Number,
      default: 2,
      min: [1, 'Capacity must be at least 1'],
    },
    minLeadHours: {
      type: Number,
      default: 2,
      min: [0, 'Lead time cannot be negative'],
    },
    maxAdvanceDays: {
      type: Number,
      default: 60,
      min: [1, 'Advance days must be at least 1'],
    },
    cancellation: {
      freeCancelHours: { type: Number, default: 24, min: 0 },
      lateFeePercent: { type: Number, default: 20, min: 0, max: 100 },
    },
    closedDates: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

export const BookingSettings =
  mongoose.models.BookingSettings ||
  mongoose.model<IBookingSettings>('BookingSettings', BookingSettingsSchema, 'bookingSettings');
