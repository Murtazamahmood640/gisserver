import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateEnv } from '../config/env';

/** Snapshot the current process.env and restore it after each test. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

const REQUIRED = [
  'MONGODB_URI',
  'JWT_SECRET',
  'STACKMAIL_HOST',
  'STACKMAIL_USER',
  'STACKMAIL_PASS',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
] as const;

describe('validateEnv()', () => {
  it('passes when all required vars are set', () => {
    // setup.ts already sets them, so this should not throw
    expect(() => validateEnv()).not.toThrow();
  });

  for (const key of REQUIRED) {
    it(`throws when ${key} is missing`, () => {
      withEnv({ [key]: undefined }, () => {
        expect(() => validateEnv()).toThrow(key);
      });
    });

    it(`throws when ${key} is empty string`, () => {
      withEnv({ [key]: '' }, () => {
        expect(() => validateEnv()).toThrow(key);
      });

    });

    it(`throws when ${key} is whitespace only`, () => {
      withEnv({ [key]: '   ' }, () => {
        expect(() => validateEnv()).toThrow(key);
      });
    });
  }

  it('lists ALL missing required vars in a single error', () => {
    const clearAll: Record<string, undefined> = Object.fromEntries(
      REQUIRED.map((k) => [k, undefined])
    );
    withEnv(clearAll, () => {
      let error: Error | undefined;
      try {
        validateEnv();
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeDefined();
      for (const key of REQUIRED) {
        expect(error!.message).toContain(key);
      }
    });
  });

  it('does not throw for optional vars being absent in test/dev', () => {
    // FB_PAGE_ID and FB_ACCESS_TOKEN and CRON_SECRET and BUSINESS_TIMEZONE are optional in test/dev
    withEnv(
      {
        NODE_ENV: 'test',
        FB_PAGE_ID: undefined,
        FB_ACCESS_TOKEN: undefined,
        CRON_SECRET: undefined,
        BUSINESS_TIMEZONE: undefined,
      },
      () => {
        expect(() => validateEnv()).not.toThrow();
      }
    );
  });

  describe('BUSINESS_TIMEZONE validation', () => {
    it('throws in production when BUSINESS_TIMEZONE is missing', () => {
      withEnv(
        {
          NODE_ENV: 'production',
          BUSINESS_TIMEZONE: undefined,
        },
        () => {
          expect(() => validateEnv()).toThrow('BUSINESS_TIMEZONE');
        }
      );
    });

    it('throws in production when BUSINESS_TIMEZONE is empty string', () => {
      withEnv(
        {
          NODE_ENV: 'production',
          BUSINESS_TIMEZONE: '',
        },
        () => {
          expect(() => validateEnv()).toThrow('BUSINESS_TIMEZONE');
        }
      );
    });

    it('throws in production when BUSINESS_TIMEZONE is whitespace only', () => {
      withEnv(
        {
          NODE_ENV: 'production',
          BUSINESS_TIMEZONE: '   ',
        },
        () => {
          expect(() => validateEnv()).toThrow('BUSINESS_TIMEZONE');
        }
      );
    });

    it('passes in production when BUSINESS_TIMEZONE is provided', () => {
      withEnv(
        {
          NODE_ENV: 'production',
          BUSINESS_TIMEZONE: 'America/New_York',
        },
        () => {
          expect(() => validateEnv()).not.toThrow();
        }
      );
    });

    it('allows default BUSINESS_TIMEZONE in development when unset', () => {
      withEnv(
        {
          NODE_ENV: 'development',
          BUSINESS_TIMEZONE: undefined,
        },
        () => {
          expect(() => validateEnv()).not.toThrow();
        }
      );
    });
  });
});
