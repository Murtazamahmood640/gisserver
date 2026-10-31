import mongoose, { Document, Schema } from 'mongoose';

export interface ISavedAddress {
  _id?: mongoose.Types.ObjectId;
  label: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  propertyType?: 'house' | 'apartment' | 'business' | 'other';
  gateCode?: string;
  parkingInstructions?: string;
  hasWaterHookup?: boolean;
  hasPowerHookup?: boolean;
  location?: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  isDefault: boolean;
}

export interface INotificationPreferences {
  email: boolean;
  push: boolean;
  sms: boolean;
}

export interface ICustomerProfile extends Document {
  userId: mongoose.Types.ObjectId;
  savedAddresses: ISavedAddress[];
  notificationPreferences: INotificationPreferences;
  preferredContactChannel?: 'sms' | 'email' | 'phone';
  createdAt: Date;
  updatedAt: Date;
}

const SavedAddressSchema = new Schema<ISavedAddress>(
  {
    label: { type: String, default: 'Home' },
    line1: { type: String, required: true, trim: true },
    line2: { type: String, default: '', trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    zip: { type: String, required: true, trim: true },
    country: { type: String, default: 'USA', trim: true },
    propertyType: {
      type: String,
      enum: ['house', 'apartment', 'business', 'other'],
      default: 'house',
    },
    gateCode: { type: String, default: '', trim: true },
    parkingInstructions: { type: String, default: '', trim: true },
    hasWaterHookup: { type: Boolean, default: false },
    hasPowerHookup: { type: Boolean, default: false },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
    },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true }
);

const CustomerProfileSchema = new Schema<ICustomerProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    savedAddresses: [SavedAddressSchema],
    notificationPreferences: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: false },
      sms: { type: Boolean, default: true },
    },
    preferredContactChannel: {
      type: String,
      enum: ['sms', 'email', 'phone'],
      default: 'sms',
    },
  },
  { timestamps: true }
);

export const CustomerProfile =
  mongoose.models.CustomerProfile ||
  mongoose.model<ICustomerProfile>('CustomerProfile', CustomerProfileSchema, 'customerProfiles');
