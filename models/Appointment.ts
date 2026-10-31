import mongoose from 'mongoose';

export interface CouponDetail {
  code: string;
  discountPercentage: number;
  discountAmount: number;
}

export interface AddonDetail {
  name: string;
  price: number;
}

export interface IAppointment extends mongoose.Document {
  fullName: string;
  phone: string;
  email: string;
  address: string;
  vehicleName: string;
  make: string;
  vehicleModel: string; // ✅ renamed from 'model'
  year: string;
  serviceType: string;
  vehicleCategory: string;
  date: string;
  timeSlot: string;
  promoCode?: string;
  coupons: CouponDetail[];
  addons: AddonDetail[];
  basePrice: number;
  totalDiscount: number;
  discountApplied: boolean;
  totalPrice: number;
  status: 'Pending' | 'Confirmed' | 'Completed' | 'Cancelled';
  createdAt: Date;
  updatedAt: Date;
}

const appointmentSchema = new mongoose.Schema<IAppointment>(
  {
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
    },
    address: {
      type: String,
      required: [true, 'Address is required'],
    },
    vehicleName: {
      type: String,
      default: '',
    },
    make: {
      type: String,
      required: [true, 'Vehicle make is required'],
    },
    vehicleModel: { // ✅ renamed from 'model'
      type: String,
      required: [true, 'Vehicle model is required'],
    },
    year: {
      type: String,
      required: [true, 'Vehicle year is required'],
    },
    serviceType: {
      type: String,
      required: [true, 'Service type is required'],
    },
    vehicleCategory: {
      type: String,
      required: [true, 'Vehicle category is required'],
    },
    date: {
      type: String,
      required: [true, 'Date is required'],
    },
    timeSlot: {
      type: String,
      required: [true, 'Time slot is required'],
    },
    promoCode: {
      type: String,
      default: '',
    },
    coupons: [
      {
        code: {
          type: String,
          required: true,
        },
        discountPercentage: {
          type: Number,
          required: true,
        },
        discountAmount: {
          type: Number,
          required: true,
        },
      },
    ],
    addons: [
      {
        name: {
          type: String,
          required: true,
        },
        price: {
          type: Number,
          required: true,
        },
      },
    ],
    basePrice: {
      type: Number,
      required: [true, 'Base price is required'],
    },
    totalDiscount: {
      type: Number,
      default: 0,
    },
    discountApplied: {
      type: Boolean,
      default: false,
    },
    totalPrice: {
      type: Number,
      required: [true, 'Total price is required'],
    },
    status: {
      type: String,
      enum: ['Pending', 'Confirmed', 'Completed', 'Cancelled'],
      default: 'Pending',
    },
  },
  { timestamps: true }
);

export const Appointment =
  mongoose.models.Appointment ||
  mongoose.model<IAppointment>('Appointment', appointmentSchema);