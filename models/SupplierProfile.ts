import mongoose, { Document, Schema } from 'mongoose';

export type SupplierBusinessType =
  | 'manufacturer'
  | 'distributor'
  | 'wholesaler'
  | 'retailer'
  | 'salvage'
  | 'other';

export type SupplierDocumentType =
  | 'business_license'
  | 'tax_certificate'
  | 'insurance'
  | 'id'
  | 'other';

export type SupplierDocumentStatus = 'pending' | 'approved' | 'rejected';

export type SupplierVerificationStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'suspended';

export interface ISupplierDocument {
  _id: mongoose.Types.ObjectId;
  type: SupplierDocumentType;
  storageRef: string; // Cloudinary public_id / storage key (select: false)
  resourceType: string; // 'raw' | 'image'
  fileName?: string;
  status: SupplierDocumentStatus;
  expiresAt?: Date;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  note?: string;
}

export interface ISupplierStatusHistoryEntry {
  status: string;
  by: string;
  at: Date;
  note?: string;
}

export interface ISupplierContactPerson {
  name?: string;
  title?: string;
  email?: string;
  phone?: string;
}

export interface ISupplierBusinessAddress {
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}

export interface ISupplierWarehouseAddress {
  street?: string;
  suiteOrDock?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}

export interface ISupplierPayoutDetails {
  bankName?: string;
  routingNumber?: string;
  accountNumberLast4?: string;
}

export interface ISupplierProfile extends Document {
  userId: mongoose.Types.ObjectId;
  companyName: string;
  tradingName?: string;
  businessType: SupplierBusinessType;
  taxId?: string;
  businessRegistrationNumber?: string;
  website?: string;
  description?: string;
  categories: string[];
  brandsSpecialized?: string[];
  estimatedSkuCount?: string;
  catalogMethod?: 'manual' | 'csv' | 'api';
  contactPerson?: ISupplierContactPerson;
  businessPhone?: string;
  supportEmail?: string;
  businessAddress?: ISupplierBusinessAddress;
  dispatchWarehouseAddress?: ISupplierWarehouseAddress;
  willCallPickupAllowed?: boolean;
  orderCutoffTime?: string;
  fulfillmentLeadTimeHours?: number;
  warrantyPeriod?: string;
  returnWindowDays?: number;
  restockingFeePercent?: number;
  documents: ISupplierDocument[];
  verificationStatus: SupplierVerificationStatus;
  rejectionReason?: string;
  suspensionReason?: string;
  payoutDetails?: ISupplierPayoutDetails;
  onboardingStep?: number;
  statusHistory: ISupplierStatusHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const SupplierDocumentSchema = new Schema<ISupplierDocument>(
  {
    type: {
      type: String,
      enum: ['business_license', 'tax_certificate', 'insurance', 'id', 'other'],
      required: true,
    },
    storageRef: {
      type: String,
      required: true,
      select: false, // NEVER returned directly to client
    },
    resourceType: {
      type: String,
      default: 'image',
    },
    fileName: {
      type: String,
      trim: true,
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
      trim: true,
    },
  },
  { _id: true }
);

const SupplierStatusHistorySchema = new Schema<ISupplierStatusHistoryEntry>(
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

const SupplierContactPersonSchema = new Schema<ISupplierContactPerson>(
  {
    name: { type: String, trim: true },
    title: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
  },
  { _id: false }
);

const SupplierBusinessAddressSchema = new Schema<ISupplierBusinessAddress>(
  {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    zipCode: { type: String, trim: true },
    country: { type: String, trim: true, default: 'US' },
  },
  { _id: false }
);

const SupplierWarehouseAddressSchema = new Schema<ISupplierWarehouseAddress>(
  {
    street: { type: String, trim: true },
    suiteOrDock: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    zipCode: { type: String, trim: true },
    country: { type: String, trim: true, default: 'US' },
  },
  { _id: false }
);

const SupplierPayoutDetailsSchema = new Schema<ISupplierPayoutDetails>(
  {
    bankName: { type: String, trim: true },
    routingNumber: { type: String, trim: true },
    accountNumberLast4: { type: String, trim: true },
  },
  { _id: false }
);

const SupplierProfileSchema = new Schema<ISupplierProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    tradingName: {
      type: String,
      trim: true,
    },
    businessType: {
      type: String,
      enum: ['manufacturer', 'distributor', 'wholesaler', 'retailer', 'salvage', 'other'],
      required: true,
      default: 'distributor',
    },
    taxId: {
      type: String,
      trim: true,
    },
    businessRegistrationNumber: {
      type: String,
      trim: true,
    },
    website: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    categories: {
      type: [String],
      default: [],
    },
    brandsSpecialized: {
      type: [String],
      default: [],
    },
    estimatedSkuCount: {
      type: String,
      trim: true,
    },
    catalogMethod: {
      type: String,
      enum: ['manual', 'csv', 'api'],
      default: 'manual',
    },
    contactPerson: SupplierContactPersonSchema,
    businessPhone: {
      type: String,
      trim: true,
    },
    supportEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    businessAddress: SupplierBusinessAddressSchema,
    dispatchWarehouseAddress: SupplierWarehouseAddressSchema,
    willCallPickupAllowed: {
      type: Boolean,
      default: false,
    },
    orderCutoffTime: {
      type: String,
      trim: true,
    },
    fulfillmentLeadTimeHours: {
      type: Number,
      default: 24,
    },
    warrantyPeriod: {
      type: String,
      trim: true,
    },
    returnWindowDays: {
      type: Number,
      default: 30,
    },
    restockingFeePercent: {
      type: Number,
      default: 0,
    },
    payoutDetails: SupplierPayoutDetailsSchema,
    onboardingStep: {
      type: Number,
      default: 1,
    },
    documents: [SupplierDocumentSchema],
    verificationStatus: {
      type: String,
      enum: ['draft', 'pending_review', 'approved', 'rejected', 'suspended'],
      default: 'draft',
      index: true,
    },
    rejectionReason: {
      type: String,
      trim: true,
    },
    suspensionReason: {
      type: String,
      trim: true,
    },
    statusHistory: [SupplierStatusHistorySchema],
  },
  {
    timestamps: true,
  }
);

SupplierProfileSchema.index({ companyName: 'text', description: 'text' });
SupplierProfileSchema.index({ categories: 1 });

export const SupplierProfile =
  mongoose.models.SupplierProfile ||
  mongoose.model<ISupplierProfile>('SupplierProfile', SupplierProfileSchema);
