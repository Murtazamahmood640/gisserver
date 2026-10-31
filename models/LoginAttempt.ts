import mongoose from 'mongoose';

export interface ILoginAttempt extends mongoose.Document {
  key: string; // `${email}:${ip}`
  email: string;
  ip: string;
  failedLoginAttempts: number;
  lockUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
  isLocked(): boolean;
}

const loginAttemptSchema = new mongoose.Schema<ILoginAttempt>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    ip: {
      type: String,
      required: true,
      index: true,
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Method to verify if currently locked out
loginAttemptSchema.methods.isLocked = function (): boolean {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

// Compound index for queries by email
loginAttemptSchema.index({ email: 1, ip: 1 });
// TTL index: auto-expire records after 2 hours of inactivity
loginAttemptSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 2 * 3600 });

export const LoginAttempt =
  mongoose.models.LoginAttempt ||
  mongoose.model<ILoginAttempt>('LoginAttempt', loginAttemptSchema);
