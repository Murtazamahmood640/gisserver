import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IPaymentSettings extends Document {
  requirePrepayment: boolean;
  autoConfirmOnPayment: boolean;
  unpaidExpiryMinutes: number;
  currency: 'usd';
  payoutHoldDays: number;
  minPayoutCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IPaymentSettingsModel extends Model<IPaymentSettings> {
  getSettings(): Promise<IPaymentSettings>;
}

const PaymentSettingsSchema = new Schema<IPaymentSettings, IPaymentSettingsModel>(
  {
    requirePrepayment: {
      type: Boolean,
      default: false,
    },
    autoConfirmOnPayment: {
      type: Boolean,
      default: true,
    },
    unpaidExpiryMinutes: {
      type: Number,
      default: 30,
    },
    currency: {
      type: String,
      enum: ['usd'],
      default: 'usd',
    },
    payoutHoldDays: {
      type: Number,
      default: 3,
      min: 0,
    },
    minPayoutCents: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

PaymentSettingsSchema.statics.getSettings = async function (): Promise<IPaymentSettings> {
  let doc = await this.findOne();
  if (!doc) {
    doc = await this.create({
      requirePrepayment: false,
      autoConfirmOnPayment: true,
      unpaidExpiryMinutes: 30,
      currency: 'usd',
      payoutHoldDays: 3,
      minPayoutCents: 0,
    });
  }
  return doc;
};

export const PaymentSettings =
  (mongoose.models.PaymentSettings as IPaymentSettingsModel) ||
  mongoose.model<IPaymentSettings, IPaymentSettingsModel>(
    'PaymentSettings',
    PaymentSettingsSchema,
    'paymentSettings'
  );
