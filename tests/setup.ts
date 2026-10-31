/**
 * Vitest test environment setup.
 *
 * Sets the minimum required environment variables so that validateEnv()
 * passes during tests.  All actual services (DB, email, Cloudinary) are
 * mocked at the test-file level and never make real network calls.
 *
 * Values here are intentionally fake — they only satisfy the presence
 * check; no real connections are made.
 */

process.env.NODE_ENV = 'test';

// Required vars — validateEnv() throws if any of these are missing.
process.env.MONGODB_URI ??= 'mongodb://localhost:27017/test';
process.env.JWT_SECRET ??= 'test-jwt-secret-for-vitest-only';
process.env.STACKMAIL_HOST ??= 'smtp.example.com';
process.env.STACKMAIL_USER ??= 'test@example.com';
process.env.STACKMAIL_PASS ??= 'test-smtp-password';
process.env.CLOUDINARY_CLOUD_NAME ??= 'test-cloud';
process.env.CLOUDINARY_API_KEY ??= 'test-api-key';
process.env.CLOUDINARY_API_SECRET ??= 'test-api-secret';
process.env.BUSINESS_TIMEZONE ??= 'America/New_York';
