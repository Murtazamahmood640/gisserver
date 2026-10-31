import mongoose, { Document, Schema } from 'mongoose';
import { VehicleCategorySlug } from './Vehicle';

export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'assigned'
  | 'technician_en_route'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'refunded';

export type BookingPaymentStatus =
  | 'unpaid'
  | 'pending'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'failed';

export type BookingSource = 'web' | 'ios' | 'android' | 'admin' | 'legacy-migration';

export interface IGuestInfo {
  fullName: string;
  email: string;
  phone: string;
}

export interface IVehicleSnapshot {
  category: VehicleCategorySlug;
  make: string;
  model: string;
  year: number;
}

export interface IServiceSnapshot {
  name: string;
  slug: string;
}

export interface IAddonSnapshot {
  addonId?: mongoose.Types.ObjectId;
  name: string;
  priceCents: number;
}

export interface IAddressSnapshot {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  freeText?: string;
}

export interface IStatusHistoryEntry {
  status: BookingStatus;
  by: string;
  at: Date;
  note?: string;
}

export interface IPricingSnapshot {
  baseCents: number;
  addonsCents: number;
  discountCents: number;
  couponCode?: string | null;
  couponPercent: number;
  taxCents: number;
  totalCents: number;
  commissionPercent: number;
  processingPercent: number;
  commissionCents: number;
  processingCents: number;
  providerPayoutCents: number;
}

export interface IBookingAssignment {
  /** Reference to User._id of assigned technician. Kept in sync with booking.technicianId (one source of truth). */
  technicianUserId?: mongoose.Types.ObjectId;
  assignedAt?: Date;
  assignedBy?: 'auto' | 'admin' | 'dispatcher' | 'technician';
  acceptedAt?: Date;
}

export interface IBookingDispatch {
  status: 'none' | 'searching' | 'offered' | 'assigned' | 'exhausted';
  attempts: number;
  lastOfferAt?: Date;
  exhaustedAt?: Date;
}

export interface IBookingCompletionChecklistItem {
  label: string;
  done: boolean;
}

export interface IBookingPayout {
  payoutId: string;
}

export interface IBookingCompletion {
  notes?: string;
  checklist?: IBookingCompletionChecklistItem[];
}

export interface IBooking extends Document {
  bookingNumber: string;
  customerId?: mongoose.Types.ObjectId | null;
  guest?: IGuestInfo;
  guestAccessTokenHash?: string | null;
  vehicleId?: mongoose.Types.ObjectId | null;
  vehicleSnapshot: IVehicleSnapshot;
  categoryId: mongoose.Types.ObjectId;
  serviceId: mongoose.Types.ObjectId;
  serviceSnapshot: IServiceSnapshot;
  addons: IAddonSnapshot[];
  address: IAddressSnapshot;
  location?: {
    type: 'Point';
    coordinates: [number, number];
  } | null;
  scheduledAt: Date;
  scheduledLocal: {
    date: string; // "YYYY-MM-DD"
    slot: string; // "HH:mm"
  };
  timezone: string;
  isAsap: boolean;
  status: BookingStatus;
  statusHistory: IStatusHistoryEntry[];
  pricing: IPricingSnapshot;
  paymentStatus: BookingPaymentStatus;
  paymentExpiresAt?: Date;
  paidAt?: Date;
  payout?: IBookingPayout;
  /** Primary technician reference (kept in sync with assignment.technicianUserId). */
  technicianId?: mongoose.Types.ObjectId | null;
  assignment?: IBookingAssignment;
  dispatch?: IBookingDispatch;
  enRouteAt?: Date;
  arrivedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  completion?: IBookingCompletion;
  notes?: string;
  source: BookingSource;
  legacyAppointmentId?: mongoose.Types.ObjectId | null;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const BookingSchema = new Schema<IBooking>(
  {
    bookingNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    guest: {
      fullName: { type: String },
      email: { type: String, lowercase: true, trim: true },
      phone: { type: String, trim: true },
    },
    guestAccessTokenHash: {
      type: String,
      default: null,
      index: true,
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle',
      default: null,
    },
    vehicleSnapshot: {
      category: {
        type: String,
        enum: ['sedan', 'crossover', 'suv', 'truck', 'rv-boat-semi'],
        required: true,
      },
      make: { type: String, default: '' },
      model: { type: String, default: '' },
      year: { type: Number, default: new Date().getFullYear() },
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCategory',
      required: true,
      index: true,
    },
    serviceId: {
      type: Schema.Types.ObjectId,
      ref: 'Service',
      required: true,
      index: true,
    },
    serviceSnapshot: {
      name: { type: String, required: true },
      slug: { type: String, required: true },
    },
    addons: [
      {
        addonId: { type: Schema.Types.ObjectId, ref: 'Addon' },
        name: { type: String, required: true },
        priceCents: { type: Number, required: true },
      },
    ],
    address: {
      line1: { type: String, default: '' },
      line2: { type: String, default: '' },
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      zip: { type: String, default: '' },
      country: { type: String, default: 'USA' },
      freeText: { type: String, default: '' },
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number],
      },
    },
    scheduledAt: {
      type: Date,
      required: true,
      index: true,
    },
    scheduledLocal: {
      date: { type: String, required: true },
      slot: { type: String, required: true },
    },
    timezone: {
      type: String,
      default: () => process.env.BUSINESS_TIMEZONE || 'America/New_York',
    },
    isAsap: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: [
        'pending',
        'confirmed',
        'assigned',
        'technician_en_route',
        'arrived',
        'in_progress',
        'completed',
        'cancelled',
        'no_show',
        'refunded',
      ],
      default: 'pending',
      index: true,
    },
    statusHistory: [
      {
        status: { type: String, required: true },
        by: { type: String, default: 'system' },
        at: { type: Date, default: Date.now },
        note: { type: String, default: '' },
      },
    ],
    pricing: {
      baseCents: { type: Number, required: true },
      addonsCents: { type: Number, required: true, default: 0 },
      discountCents: { type: Number, required: true, default: 0 },
      couponCode: { type: String, default: null },
      couponPercent: { type: Number, default: 0 },
      taxCents: { type: Number, default: 0 },
      totalCents: { type: Number, required: true },
      commissionPercent: { type: Number, default: 15 },
      processingPercent: { type: Number, default: 3 },
      commissionCents: { type: Number, default: 0 },
      processingCents: { type: Number, default: 0 },
      providerPayoutCents: { type: Number, default: 0 },
    },
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'pending', 'paid', 'partially_refunded', 'refunded', 'failed'],
      default: 'unpaid',
      index: true,
    },
    paymentExpiresAt: { type: Date },
    paidAt: { type: Date },
    technicianId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    assignment: {
      technicianUserId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
      assignedAt: { type: Date },
      assignedBy: {
        type: String,
        enum: ['auto', 'admin', 'dispatcher', 'technician'],
      },
      acceptedAt: { type: Date },
    },
    dispatch: {
      status: {
        type: String,
        enum: ['none', 'searching', 'offered', 'assigned', 'exhausted'],
        default: 'none',
      },
      attempts: {
        type: Number,
        default: 0,
      },
      lastOfferAt: { type: Date },
      exhaustedAt: { type: Date },
    },
    enRouteAt: { type: Date },
    arrivedAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    completion: {
      notes: { type: String },
      checklist: [
        {
          label: { type: String, required: true },
          done: { type: Boolean, default: false },
        },
      ],
    },
    notes: {
      type: String,
      default: '',
    },
    source: {
      type: String,
      enum: ['web', 'ios', 'android', 'admin', 'legacy-migration'],
      default: 'web',
    },
    legacyAppointmentId: {
      type: Schema.Types.ObjectId,
      // No default — omitting the field is how sparse uniqueness works.
      // Do NOT store null; sparse index excludes missing/undefined fields only.
      unique: true,
      sparse: true,
    },
    payout: {
      type: {
        payoutId: { type: String, required: true },
      },
      required: false,
      _id: false,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// Compound indexes
BookingSchema.index({ customerId: 1, scheduledAt: -1 });
BookingSchema.index({ technicianId: 1, scheduledAt: -1 });
BookingSchema.index({ 'guest.email': 1 });
BookingSchema.index({ location: '2dsphere' }, { sparse: true });
BookingSchema.index({ 'payout.payoutId': 1 }, { sparse: true });

export const Booking =
  mongoose.models.Booking || mongoose.model<IBooking>('Booking', BookingSchema, 'bookings');
