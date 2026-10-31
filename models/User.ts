import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export type UserRole = 'customer' | 'technician' | 'supplier' | 'admin' | 'dispatcher' | 'user';
export type UserStatus = 'active' | 'suspended' | 'pending';

/**
 * Role migration mapping:
 * - 'admin' remains 'admin' (superadmin / full access)
 * - Legacy 'user' is mapped to 'dispatcher' (admin-panel operations staff)
 * - 'customer' is standard public end-user
 * - 'technician' is field/service worker
 * - 'supplier' is parts/inventory supplier
 */

export interface IUser extends mongoose.Document {
  email: string;
  password: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  role: UserRole;
  isActive: boolean;
  status: UserStatus;
  phone?: string;
  phoneCountryCode?: string;
  phoneVerified: boolean;
  emailVerified: boolean;
  avatarUrl?: string;
  lastLoginAt?: Date;
  failedLoginAttempts: number;
  lockUntil?: Date;
  fcmTokens: string[];
  termsAcceptedAt?: Date;
  privacyAcceptedAt?: Date;
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
  getEffectiveRole(): 'customer' | 'technician' | 'supplier' | 'admin' | 'dispatcher';
  isLocked(): boolean;
}

const userSchema = new mongoose.Schema<IUser>(
  {
    email: {
      type: String,
      required: [true, 'Please provide an email'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
    },
    password: {
      type: String,
      required: [true, 'Please provide a password'],
      minlength: 6,
      select: false,
    },
    fullName: {
      type: String,
      required: [true, 'Please provide a full name'],
      trim: true,
    },
    firstName: {
      type: String,
      trim: true,
    },
    lastName: {
      type: String,
      trim: true,
    },
    role: {
      type: String,
      enum: ['customer', 'technician', 'supplier', 'admin', 'dispatcher', 'user'],
      default: 'customer',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'pending'],
      default: 'active',
    },
    phone: {
      type: String,
      trim: true,
    },
    phoneCountryCode: {
      type: String,
      default: '+1',
      trim: true,
    },
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    avatarUrl: {
      type: String,
      trim: true,
    },
    lastLoginAt: {
      type: Date,
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
    },
    fcmTokens: {
      type: [String],
      default: [],
    },
    termsAcceptedAt: {
      type: Date,
    },
    privacyAcceptedAt: {
      type: Date,
    },
    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpires: {
      type: Date,
      select: false,
    },
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password method
userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Check if account is temporarily locked
userSchema.methods.isLocked = function (): boolean {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

// Map legacy 'user' role to 'dispatcher'
userSchema.methods.getEffectiveRole = function (): 'customer' | 'technician' | 'supplier' | 'admin' | 'dispatcher' {
  if (this.role === 'user') return 'dispatcher';
  return this.role;
};

export const User =
  mongoose.models.User || mongoose.model<IUser>('User', userSchema);
