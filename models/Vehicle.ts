import mongoose, { Document, Schema } from 'mongoose';

export type VehicleCategorySlug = 'sedan' | 'crossover' | 'suv' | 'truck' | 'rv-boat-semi';

export interface IVehicle extends Document {
  ownerUserId: mongoose.Types.ObjectId;
  category: VehicleCategorySlug;
  make: string;
  vehicleModel: string;
  year: number;
  color?: string;
  plate?: string;
  vin?: string;
  isDefault: boolean;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const VehicleSchema = new Schema<IVehicle>(
  {
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ['sedan', 'crossover', 'suv', 'truck', 'rv-boat-semi'],
      required: true,
    },
    make: { type: String, required: true, trim: true },
    vehicleModel: { type: String, required: true, trim: true },
    year: { type: Number, required: true },
    color: { type: String, default: '', trim: true },
    plate: { type: String, default: '', trim: true },
    vin: { type: String, default: '', trim: true },
    isDefault: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

VehicleSchema.virtual('model')
  .get(function () {
    return this.vehicleModel;
  })
  .set(function (this: any, v: string) {
    this.vehicleModel = v;
  });

VehicleSchema.set('toJSON', { virtuals: true });
VehicleSchema.set('toObject', { virtuals: true });

VehicleSchema.index({ ownerUserId: 1, deletedAt: 1 });

export const Vehicle =
  mongoose.models.Vehicle ||
  mongoose.model<IVehicle>('Vehicle', VehicleSchema, 'vehicles');
