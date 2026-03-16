import mongoose from 'mongoose';

export interface IContact extends mongoose.Document {
  fullName: string;
  email: string;
  phone: string;
  subject: string;
  message: string;
  status: 'New' | 'Reviewed' | 'Responded' | 'Resolved';
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new mongoose.Schema<IContact>(
  {
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
    },
    subject: {
      type: String,
      required: [true, 'Subject is required'],
    },
    message: {
      type: String,
      required: [true, 'Message is required'],
    },
    status: {
      type: String,
      enum: ['New', 'Reviewed', 'Responded', 'Resolved'],
      default: 'New',
    },
  },
  { timestamps: true }
);

export const Contact =
  mongoose.models.Contact || mongoose.model<IContact>('Contact', contactSchema);
