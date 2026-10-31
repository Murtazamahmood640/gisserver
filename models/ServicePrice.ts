import mongoose, { Document, Schema } from 'mongoose';

export type VehicleCategory = 'sedan' | 'crossover' | 'suv' | 'truck' | 'rv-boat-semi';

export interface IServicePrice extends Document {
  serviceId: mongoose.Types.ObjectId;
  vehicleCategory: VehicleCategory;
  price: number; // Integer cents
  createdAt: Date;
  updatedAt: Date;
}

const ServicePriceSchema = new Schema<IServicePrice>(
  {
    serviceId: {
      type: Schema.Types.ObjectId,
      ref: 'Service',
      required: [true, 'Service ID is required'],
      index: true,
    },
    vehicleCategory: {
      type: String,
      enum: ['sedan', 'crossover', 'suv', 'truck', 'rv-boat-semi'],
      required: [true, 'Vehicle category is required'],
    },
    price: {
      type: Number,
      required: [true, 'Price in cents is required'],
      min: [1, 'Price must be a positive integer in cents'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} is not an integer. Store money as integer cents.',
      },
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index ensuring only one price per service and vehicle category
ServicePriceSchema.index({ serviceId: 1, vehicleCategory: 1 }, { unique: true });

export const ServicePrice =
  mongoose.models.ServicePrice ||
  mongoose.model<IServicePrice>('ServicePrice', ServicePriceSchema, 'servicePrices');
