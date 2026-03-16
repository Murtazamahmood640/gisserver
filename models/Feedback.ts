import mongoose from 'mongoose';

export interface IFeedback extends mongoose.Document {
  name: string;
  email: string;
  rating: number;
  title: string;
  feedback: string;
  status: 'pending' | 'draft' | 'publish';
  createdAt: Date;
  updatedAt: Date;
}

const feedbackSchema = new mongoose.Schema<IFeedback>(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
    },
    rating: {
      type: Number,
      required: [true, 'Rating is required'],
      min: 1,
      max: 5,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
    },
    feedback: {
      type: String,
      required: [true, 'Feedback is required'],
    },
    status: {
      type: String,
      enum: ['pending', 'draft', 'publish'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

export const Feedback =
  mongoose.models.Feedback || mongoose.model<IFeedback>('Feedback', feedbackSchema);
