import mongoose, { Document, Schema } from 'mongoose';

export type CommissionScope = 'global' | 'category' | 'service';

export interface ICommissionRule extends Document {
  scope: CommissionScope;
  scopeId?: mongoose.Types.ObjectId;
  commissionPercent: number; // e.g. 15 for 15%
  processingPercent: number; // e.g. 3 for 3%
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CommissionRuleSchema = new Schema<ICommissionRule>(
  {
    scope: {
      type: String,
      enum: ['global', 'category', 'service'],
      default: 'global',
      required: true,
      index: true,
    },
    scopeId: {
      type: Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    commissionPercent: {
      type: Number,
      required: [true, 'Commission percentage is required'],
      default: 15,
      min: [0, 'Commission percent cannot be negative'],
      max: [100, 'Commission percent cannot exceed 100'],
    },
    processingPercent: {
      type: Number,
      required: [true, 'Processing percentage is required'],
      default: 3,
      min: [0, 'Processing percent cannot be negative'],
      max: [100, 'Processing percent cannot exceed 100'],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

CommissionRuleSchema.pre('validate', function () {
  if (this.commissionPercent + this.processingPercent > 100) {
    throw new Error('Total of commissionPercent and processingPercent cannot exceed 100');
  }
});

export const CommissionRule =
  mongoose.models.CommissionRule ||
  mongoose.model<ICommissionRule>('CommissionRule', CommissionRuleSchema, 'commissionRules');
