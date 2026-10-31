import mongoose from 'mongoose';

export interface IRefreshToken extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  tokenHash: string; // bcrypt or sha256 hash of raw refresh token
  deviceInfo: string; // user-agent, mobile client ID, etc.
  ipAddress?: string;
  issuedAt: Date;
  expiresAt: Date;
  revoked: boolean;
  revokedAt?: Date;
  replacedByTokenHash?: string; // Token rotation chain
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new mongoose.Schema<IRefreshToken>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      index: true,
    },
    deviceInfo: {
      type: String,
      default: 'unknown',
    },
    ipAddress: {
      type: String,
    },
    issuedAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revoked: {
      type: Boolean,
      default: false,
    },
    revokedAt: {
      type: Date,
    },
    replacedByTokenHash: {
      type: String,
    },
  },
  { timestamps: true }
);

// TTL index to auto-clean expired tokens (retaining 7 days after expiry for audit/rotation checks)
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
// Composite index for fast user session lookup
refreshTokenSchema.index({ userId: 1, revoked: 1 });

export const RefreshToken =
  mongoose.models.RefreshToken ||
  mongoose.model<IRefreshToken>('RefreshToken', refreshTokenSchema);
