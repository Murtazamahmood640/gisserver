import mongoose, { Document, Schema } from 'mongoose';

export type DocumentType = 'id' | 'license' | 'insurance' | 'certification' | 'other';
export type DocumentStatus = 'pending' | 'approved' | 'rejected';
export type VerificationStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'suspended';
export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface ITechnicianDocument {
  _id: mongoose.Types.ObjectId;
  type: DocumentType;
  storageRef: string; // Cloudinary public_id (private, select: false)
  resourceType?: string; // 'raw' | 'image'
  status: DocumentStatus;
  expiresAt?: Date;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  note?: string;
  expiryNotifiedAt?: Date;
}

export interface IWeeklySchedule {
  day: DayOfWeek;
  from: string; // HH:mm
  to: string; // HH:mm
}

export interface ITimeOff {
  from: Date;
  to: Date;
  note?: string;
}

export interface IScheduleSlot {
  bookingId: mongoose.Types.ObjectId;
  start: Date;
  end: Date;
  createdAt?: Date;
}

export interface IStatusHistoryEntry {
  status: string;
  by: string;
  at: Date;
  note?: string;
}

export interface ITechnicianCertification {
  title: string;
  organization?: string;
  certificateNumber?: string;
  expiresAt?: Date;
}

export interface ITechnicianEquipment {
  hasWaterTank?: boolean;
  hasGenerator?: boolean;
  hasCompressor?: boolean;
  hasScanner?: boolean;
}

export interface ITechnicianProfile extends Document {
  userId: mongoose.Types.ObjectId;
  displayName?: string;
  bio?: string;
  photoUrl?: string;
  phone?: string;
  businessType?: 'individual_contractor' | 'licensed_business' | 'employee';
  yearsExperience?: number;
  certifications?: ITechnicianCertification[];
  equipmentCapabilities?: ITechnicianEquipment;
  emergencyAfterHours?: boolean;
  languages?: string[];
  onboardingStep?: number;
  skills: {
    categoryIds: mongoose.Types.ObjectId[];
    serviceIds: mongoose.Types.ObjectId[];
  };
  serviceArea: {
    zipCodes: string[];
    center?: {
      type: 'Point';
      coordinates: [number, number]; // [lng, lat]
    };
    radiusKm?: number;
    city?: string;
    state?: string;
  };
  vehicleInfo?: {
    type?: string;
    plate?: string;
    capacity?: string;
  };
  documents: ITechnicianDocument[];
  verificationStatus: VerificationStatus;
  rejectionReason?: string;
  availability: {
    isOnline: boolean;
    weeklySchedule: IWeeklySchedule[];
    timeOff: ITimeOff[];
  };
  rating: {
    avg: number;
    count: number;
  };
  stats: {
    jobsCompleted: number;
    acceptanceRate: number;
  };
  activeSchedule?: IScheduleSlot[];
  payoutDetails: Record<string, any>;
  statusHistory: IStatusHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const TechnicianDocumentSchema = new Schema<ITechnicianDocument>(
  {
    type: {
      type: String,
      enum: ['id', 'license', 'insurance', 'certification', 'other'],
      required: true,
    },
    storageRef: {
      type: String,
      required: true,
      select: false, // NEVER returned to client
    },
    resourceType: {
      type: String,
      default: 'image',
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    expiresAt: {
      type: Date,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: {
      type: Date,
    },
    note: {
      type: String,
    },
    expiryNotifiedAt: {
      type: Date,
    },
  },
  { _id: true }
);

const WeeklyScheduleSchema = new Schema<IWeeklySchedule>(
  {
    day: {
      type: String,
      enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      required: true,
    },
    from: {
      type: String,
      required: true,
      match: /^\d{2}:\d{2}$/,
    },
    to: {
      type: String,
      required: true,
      match: /^\d{2}:\d{2}$/,
    },
  },
  { _id: false }
);

const TimeOffSchema = new Schema<ITimeOff>(
  {
    from: {
      type: Date,
      required: true,
    },
    to: {
      type: Date,
      required: true,
    },
    note: {
      type: String,
    },
  },
  { _id: false }
);

const StatusHistorySchema = new Schema<IStatusHistoryEntry>(
  {
    status: {
      type: String,
      required: true,
    },
    by: {
      type: String,
      required: true,
    },
    at: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
    },
  },
  { _id: false }
);

const TechnicianProfileSchema = new Schema<ITechnicianProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    displayName: {
      type: String,
      trim: true,
    },
    bio: {
      type: String,
      trim: true,
    },
    photoUrl: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    businessType: {
      type: String,
      enum: ['individual_contractor', 'licensed_business', 'employee'],
      default: 'individual_contractor',
    },
    yearsExperience: {
      type: Number,
      min: 0,
      default: 0,
    },
    certifications: [
      {
        title: { type: String, required: true },
        organization: { type: String },
        certificateNumber: { type: String },
        expiresAt: { type: Date },
      },
    ],
    equipmentCapabilities: {
      hasWaterTank: { type: Boolean, default: false },
      hasGenerator: { type: Boolean, default: false },
      hasCompressor: { type: Boolean, default: false },
      hasScanner: { type: Boolean, default: false },
    },
    emergencyAfterHours: {
      type: Boolean,
      default: false,
    },
    languages: [{ type: String, trim: true }],
    onboardingStep: {
      type: Number,
      default: 1,
    },
    skills: {
      categoryIds: [
        {
          type: Schema.Types.ObjectId,
          ref: 'ServiceCategory',
        },
      ],
      serviceIds: [
        {
          type: Schema.Types.ObjectId,
          ref: 'Service',
        },
      ],
    },
    serviceArea: {
      zipCodes: [{ type: String, trim: true }],
      center: {
        type: {
          type: String,
          enum: ['Point'],
        },
        coordinates: {
          type: [Number],
        },
      },
      radiusKm: {
        type: Number,
      },
      city: {
        type: String,
        trim: true,
      },
      state: {
        type: String,
        trim: true,
      },
    },
    vehicleInfo: {
      type: { type: String, trim: true },
      plate: { type: String, trim: true },
      capacity: { type: String, trim: true },
    },
    documents: [TechnicianDocumentSchema],
    verificationStatus: {
      type: String,
      enum: ['draft', 'pending_review', 'approved', 'rejected', 'suspended'],
      default: 'draft',
      index: true,
    },
    rejectionReason: {
      type: String,
    },
    availability: {
      isOnline: {
        type: Boolean,
        default: false,
      },
      weeklySchedule: [WeeklyScheduleSchema],
      timeOff: [TimeOffSchema],
    },
    rating: {
      avg: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },
    stats: {
      jobsCompleted: { type: Number, default: 0 },
      acceptanceRate: { type: Number, default: 0 },
    },
    activeSchedule: [
      {
        bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
        start: { type: Date, required: true },
        end: { type: Date, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    payoutDetails: {
      type: Schema.Types.Mixed,
      default: {},
    },
    statusHistory: [StatusHistorySchema],
  },
  {
    timestamps: true,
  }
);

// Indexes
// userId is already unique: true
// verificationStatus is index: true
TechnicianProfileSchema.index({ 'skills.categoryIds': 1 });
TechnicianProfileSchema.index({ 'serviceArea.zipCodes': 1 });
TechnicianProfileSchema.index({ 'serviceArea.center': '2dsphere' }, { sparse: true });

export const TechnicianProfile =
  mongoose.models.TechnicianProfile ||
  mongoose.model<ITechnicianProfile>('TechnicianProfile', TechnicianProfileSchema);
