import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app';
import { User } from '../models/User';
import { Booking } from '../models/Booking';
import { TechnicianProfile } from '../models/TechnicianProfile';
import { Contact } from '../models/Contact';
import { Feedback } from '../models/Feedback';
import { generateAccessToken } from '../utils/jwt';

// Mock DB connection
vi.mock('../config/database', () => ({
  connectDB: vi.fn().mockResolvedValue(true),
}));

describe('Admin Overview & Counts API (/api/v1/admin)', () => {
  const adminToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439001',
    email: 'admin@test.com',
    role: 'admin',
    status: 'active',
    emailVerified: true,
  });

  const dispatcherToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439002',
    email: 'dispatcher@test.com',
    role: 'dispatcher',
    status: 'active',
    emailVerified: true,
  });

  const customerToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439003',
    email: 'customer@test.com',
    role: 'customer',
    status: 'active',
    emailVerified: true,
  });

  const technicianToken = generateAccessToken({
    userId: '507f1f77bcf86cd799439004',
    email: 'tech@test.com',
    role: 'technician',
    status: 'active',
    emailVerified: true,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Role boundaries', () => {
    it('rejects unauthenticated request to /admin/counts with 401', async () => {
      const res = await request(app).get('/api/v1/admin/counts');
      expect(res.status).toBe(401);
    });

    it('rejects customer from /admin/counts with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/counts')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
    });

    it('rejects technician from /admin/counts with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/counts')
        .set('Authorization', `Bearer ${technicianToken}`);
      expect(res.status).toBe(403);
    });

    it('allows dispatcher to access /admin/counts with 200', async () => {
      vi.spyOn(Booking, 'countDocuments').mockResolvedValue(3 as never);
      vi.spyOn(TechnicianProfile, 'countDocuments').mockResolvedValue(2 as never);
      vi.spyOn(Contact, 'countDocuments').mockResolvedValue(5 as never);
      vi.spyOn(Feedback, 'countDocuments').mockResolvedValue(1 as never);

      const res = await request(app)
        .get('/api/v1/admin/counts')
        .set('Authorization', `Bearer ${dispatcherToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        pendingBookings: 3,
        pendingTechnicians: 2,
        newContacts: 5,
        pendingFeedback: 1,
        unassignedBookings: 3,
      });
    });

    it('allows admin to access /admin/counts with 200', async () => {
      vi.spyOn(Booking, 'countDocuments').mockResolvedValue(0 as never);
      vi.spyOn(TechnicianProfile, 'countDocuments').mockResolvedValue(0 as never);
      vi.spyOn(Contact, 'countDocuments').mockResolvedValue(0 as never);
      vi.spyOn(Feedback, 'countDocuments').mockResolvedValue(0 as never);

      const res = await request(app)
        .get('/api/v1/admin/counts')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pendingBookings).toBe(0);
    });
  });

  describe('GET /api/v1/admin/overview', () => {
    it('rejects customer and technician with 403', async () => {
      const resCust = await request(app)
        .get('/api/v1/admin/overview')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(resCust.status).toBe(403);

      const resTech = await request(app)
        .get('/api/v1/admin/overview')
        .set('Authorization', `Bearer ${technicianToken}`);
      expect(resTech.status).toBe(403);
    });

    it('rejects invalid range parameter with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/overview?range=365d')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('admin response includes bookedValueCents in KPIs and dailyTrend', async () => {
      vi.spyOn(Booking, 'countDocuments').mockResolvedValue(10 as never);
      vi.spyOn(TechnicianProfile, 'countDocuments').mockResolvedValue(2 as never);
      vi.spyOn(Contact, 'countDocuments').mockResolvedValue(4 as never);
      vi.spyOn(Feedback, 'countDocuments').mockResolvedValue(1 as never);
      vi.spyOn(User, 'countDocuments').mockResolvedValue(8 as never);

      const mockBookingRecord = {
        _id: new mongoose.Types.ObjectId(),
        bookingNumber: 'GIS-001001',
        status: 'confirmed',
        scheduledAt: new Date(),
        scheduledLocal: { date: '2026-10-22', slot: '10:00' },
        pricing: { totalCents: 15000 },
        guest: { fullName: 'John Doe', email: 'john@secret.com', phone: '555-1234' },
      };

      vi.spyOn(Booking, 'find').mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([mockBookingRecord]),
        }),
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([mockBookingRecord]),
            }),
          }),
        }),
      } as never);

      vi.spyOn(Booking, 'aggregate').mockResolvedValue([
        { name: 'Ceramic Coating', count: 5 },
      ] as never);

      vi.spyOn(TechnicianProfile, 'find').mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([
                {
                  _id: new mongoose.Types.ObjectId(),
                  displayName: 'Mike Tech',
                  verificationStatus: 'pending_review',
                  createdAt: new Date(),
                },
              ]),
            }),
          }),
        }),
      } as never);

      vi.spyOn(Contact, 'find').mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([
                {
                  _id: new mongoose.Types.ObjectId(),
                  fullName: 'Inquiry Person',
                  subject: 'Quote request',
                  createdAt: new Date(),
                },
              ]),
            }),
          }),
        }),
      } as never);

      const res = await request(app)
        .get('/api/v1/admin/overview?range=7d')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.kpis.bookedValueCents).toBeDefined();
      expect(res.body.data.kpis.bookedValueCents).toBe(15000);

      // Verify dailyTrend items include bookedValueCents for admin
      expect(res.body.data.dailyTrend.length).toBe(7);
      expect(res.body.data.dailyTrend[0].bookedValueCents).toBeDefined();

      // Verify recent bookings have NO PII (no email, no phone)
      const recent = res.body.data.recent.bookings[0];
      expect(recent.bookingNumber).toBe('GIS-001001');
      expect(recent.guest.fullName).toBe('John Doe');
      expect(recent.guest.email).toBeUndefined();
      expect(recent.guest.phone).toBeUndefined();
    });

    it('dispatcher response OMITS bookedValueCents from KPIs and dailyTrend', async () => {
      vi.spyOn(Booking, 'countDocuments').mockResolvedValue(5 as never);
      vi.spyOn(TechnicianProfile, 'countDocuments').mockResolvedValue(1 as never);
      vi.spyOn(Contact, 'countDocuments').mockResolvedValue(2 as never);
      vi.spyOn(Feedback, 'countDocuments').mockResolvedValue(0 as never);
      vi.spyOn(User, 'countDocuments').mockResolvedValue(3 as never);

      const mockBookingRecord = {
        _id: new mongoose.Types.ObjectId(),
        bookingNumber: 'GIS-001002',
        status: 'confirmed',
        scheduledAt: new Date(),
        scheduledLocal: { date: '2026-10-22', slot: '11:00' },
        pricing: { totalCents: 20000 },
      };

      vi.spyOn(Booking, 'find').mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([mockBookingRecord]),
        }),
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([mockBookingRecord]),
            }),
          }),
        }),
      } as never);

      vi.spyOn(Booking, 'aggregate').mockResolvedValue([]);
      vi.spyOn(TechnicianProfile, 'find').mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as never);
      vi.spyOn(Contact, 'find').mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as never);

      const res = await request(app)
        .get('/api/v1/admin/overview?range=7d')
        .set('Authorization', `Bearer ${dispatcherToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // STRICT REQUIREMENT: bookedValueCents omitted for dispatcher
      expect(res.body.data.kpis.bookedValueCents).toBeUndefined();
      expect(res.body.data.dailyTrend[0].bookedValueCents).toBeUndefined();
      expect(res.body.data.recent.bookings[0].bookedValueCents).toBeUndefined();
    });

    it('excludes cancelled bookings from revenue totals', async () => {
      vi.spyOn(Booking, 'countDocuments').mockResolvedValue(1 as never);
      vi.spyOn(TechnicianProfile, 'countDocuments').mockResolvedValue(0 as never);
      vi.spyOn(Contact, 'countDocuments').mockResolvedValue(0 as never);
      vi.spyOn(Feedback, 'countDocuments').mockResolvedValue(0 as never);
      vi.spyOn(User, 'countDocuments').mockResolvedValue(0 as never);

      const cancelledBooking = {
        _id: new mongoose.Types.ObjectId(),
        bookingNumber: 'GIS-CANCELLED',
        status: 'cancelled',
        scheduledAt: new Date(),
        scheduledLocal: { date: '2026-10-22', slot: '14:00' },
        pricing: { totalCents: 50000 },
      };

      vi.spyOn(Booking, 'find').mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([cancelledBooking]),
        }),
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as never);

      vi.spyOn(Booking, 'aggregate').mockResolvedValue([]);
      vi.spyOn(TechnicianProfile, 'find').mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as never);
      vi.spyOn(Contact, 'find').mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as never);

      const res = await request(app)
        .get('/api/v1/admin/overview?range=7d')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.kpis.bookedValueCents).toBe(0); // cancelled excluded!
    });
  });
});
