import mongoose, { Document, Schema } from 'mongoose';

export type PartOrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export type PartOrderPaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed' | 'refunded';

export interface IPartOrderItem {
  productId: mongoose.Types.ObjectId;
  supplierId: mongoose.Types.ObjectId;
  name: string;
  sku: string;
  brand: string;
  priceCents: number;
  quantity: number;
  totalCents: number;
  imageUrl?: string;
  condition?: string;
}

export interface IPartOrderShippingAddress {
  fullName?: string;
  phone?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

export interface IPartOrderStatusHistory {
  status: PartOrderStatus;
  by: string;
  at: Date;
  note?: string;
}

export interface IPartOrder extends Document {
  orderNumber: string;
  customerId: mongoose.Types.ObjectId;
  items: IPartOrderItem[];
  shippingAddress: IPartOrderShippingAddress;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  status: PartOrderStatus;
  paymentStatus: PartOrderPaymentStatus;
  statusHistory: IPartOrderStatusHistory[];
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PartOrderItemSchema = new Schema<IPartOrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'PartProduct', required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'SupplierProfile', required: true },
    name: { type: String, required: true },
    sku: { type: String, required: true },
    brand: { type: String, required: true },
    priceCents: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    totalCents: { type: Number, required: true, min: 0 },
    imageUrl: { type: String },
    condition: { type: String },
  },
  { _id: false }
);

const PartOrderShippingAddressSchema = new Schema<IPartOrderShippingAddress>(
  {
    fullName: { type: String },
    phone: { type: String },
    line1: { type: String, required: true },
    line2: { type: String, default: '' },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zip: { type: String, required: true },
    country: { type: String, default: 'USA' },
  },
  { _id: false }
);

const PartOrderStatusHistorySchema = new Schema<IPartOrderStatusHistory>(
  {
    status: { type: String, required: true },
    by: { type: String, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String },
  },
  { _id: false }
);

const PartOrderSchema = new Schema<IPartOrder>(
  {
    orderNumber: { type: String, required: true, unique: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [PartOrderItemSchema], required: true },
    shippingAddress: { type: PartOrderShippingAddressSchema, required: true },
    subtotalCents: { type: Number, required: true, min: 0 },
    shippingCents: { type: Number, default: 0, min: 0 },
    taxCents: { type: Number, default: 0, min: 0 },
    totalCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
      default: 'pending',
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'pending', 'paid', 'failed', 'refunded'],
      default: 'unpaid',
      index: true,
    },
    statusHistory: { type: [PartOrderStatusHistorySchema], default: [] },
    notes: { type: String },
  },
  { timestamps: true }
);

export const PartOrder =
  (mongoose.models.PartOrder as mongoose.Model<IPartOrder>) ||
  mongoose.model<IPartOrder>('PartOrder', PartOrderSchema);
