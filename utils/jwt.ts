import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

export type TokenType = 'access' | 'legacy_admin' | 'password_reset' | 'email_verification';

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  type?: TokenType;
  status?: string;
  iat?: number;
  exp?: number;
}

export interface AccessTokenPayload {
  userId: string;
  email: string;
  role: 'customer' | 'technician' | 'supplier' | 'admin' | 'dispatcher';
  status: 'active' | 'suspended' | 'pending';
  emailVerified: boolean;
  type: 'access';
  iat?: number;
  exp?: number;
}

export interface PasswordResetPayload {
  userId: string;
  email: string;
  type: 'password_reset';
  pwdFingerprint?: string;
  iat?: number;
  exp?: number;
}

export interface EmailVerificationPayload {
  userId: string;
  email: string;
  type: 'email_verification';
  iat?: number;
  exp?: number;
}

/**
 * Legacy session token generator (7 days) for backwards compatibility
 * with existing admin panel and tests.
 * Carries type: 'legacy_admin'.
 */
export function generateToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(
    {
      ...payload,
      type: payload.type || 'legacy_admin',
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Short-lived access token (15 minutes) for v1 multi-role auth.
 * Explicitly carries type: 'access'.
 */
export function generateAccessToken(
  payload: Omit<AccessTokenPayload, 'iat' | 'exp' | 'type'>,
  expiresIn: string | number = '24h'
): string {
  return jwt.sign(
    {
      ...payload,
      type: 'access',
    },
    JWT_SECRET,
    { expiresIn: expiresIn as any }
  );
}

/**
 * Strictly verifies 15-minute access tokens.
 * Rejects tokens that do not have type === 'access'.
 */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AccessTokenPayload;
    if (decoded && decoded.type === 'access') {
      return decoded;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Generates an opaque, cryptographically secure 64-byte random hex string.
 * This raw token is sent to the client and stored as a SHA-256 hash in the DB.
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

/**
 * Hashes an opaque token using SHA-256 for secure constant-time DB lookup.
 */
export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Generates email verification token (24 hours validity).
 * Carries type: 'email_verification'.
 */
export function generateEmailVerificationToken(payload: { userId: string; email: string }): string {
  return jwt.sign({ ...payload, type: 'email_verification' }, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyEmailVerificationToken(token: string): EmailVerificationPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as EmailVerificationPayload;
    if (decoded && decoded.type === 'email_verification') {
      return decoded;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Verifies legacy tokens.
 * Rejects tokens whose type is password_reset or email_verification.
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    // Reject tokens not meant for authentication
    if (decoded.type === 'password_reset' || decoded.type === 'email_verification') {
      return null;
    }
    if (decoded && (decoded.type === 'legacy_admin' || decoded.type === 'access' || !decoded.type)) {
      return decoded;
    }
    return null;
  } catch (error) {
    return null;
  }
}

export function decodeToken(
  token: string
): (JwtPayload | PasswordResetPayload | EmailVerificationPayload) | null {
  try {
    const decoded = jwt.decode(token) as (
      | JwtPayload
      | PasswordResetPayload
      | EmailVerificationPayload
    );
    return decoded;
  } catch (error) {
    return null;
  }
}

/**
 * Generates a single-use password reset token.
 * Incorporates a fingerprint of the user's current password hash into the signing secret and payload.
 * When the password is changed, the hash changes, permanently invalidating any previously issued token.
 * Carries type: 'password_reset'.
 */
export function generatePasswordResetToken(
  payload: { userId: string; email: string },
  passwordHash: string
): string {
  const signingSecret = `${JWT_SECRET}:${passwordHash}`;
  const pwdFingerprint = passwordHash.slice(-10);

  return jwt.sign(
    {
      ...payload,
      pwdFingerprint,
      type: 'password_reset',
    },
    signingSecret,
    { expiresIn: '1h' }
  );
}

/**
 * Verifies a single-use password reset token against the user's current password hash.
 */
export function verifyPasswordResetToken(
  token: string,
  passwordHash: string
): PasswordResetPayload | null {
  try {
    const signingSecret = `${JWT_SECRET}:${passwordHash}`;
    const decoded = jwt.verify(token, signingSecret) as PasswordResetPayload;

    if (decoded && decoded.type === 'password_reset') {
      const expectedFingerprint = passwordHash.slice(-10);
      if (decoded.pwdFingerprint && decoded.pwdFingerprint !== expectedFingerprint) {
        return null;
      }
      return decoded;
    }
    return null;
  } catch (error) {
    return null;
  }
}
