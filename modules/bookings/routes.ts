import { Router } from 'express';
import { BookingController } from './controller';
import { TrackingController } from '../tracking/controller';
import {
  authenticateToken,
  optionalAuthenticateToken,
  requireRoles,
  requireAdminRole,
} from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import {
  bookingLookupLimiter,
  availabilityLimiter,
  bookingCreationLimiter,
} from '../../middleware/rateLimiter';
import {
  createBookingSchema,
  cancelBookingSchema,
  rescheduleBookingSchema,
  updateBookingStatusSchema,
  adminUpdateBookingSchema,
  updateBookingSettingsSchema,
  quoteBookingSchema,
} from './schema';

const router = Router();

// ---------------------------------------------------------------------------
// 1. Availability & Quotes (Public, Rate Limited to 120 per 15 min per IP)
// ---------------------------------------------------------------------------
router.get('/availability', availabilityLimiter, BookingController.getAvailability);
router.post('/quote', availabilityLimiter, validateBody(quoteBookingSchema), BookingController.getQuote);

// ---------------------------------------------------------------------------
// 2. Booking Lifecycle (Customer / Guest)
// ---------------------------------------------------------------------------
// Create booking (guest or authenticated, 10 per 15 min, skipping 400 validation errors)
router.post(
  '/',
  optionalAuthenticateToken,
  bookingCreationLimiter,
  validateBody(createBookingSchema),
  BookingController.create
);

// My bookings (authenticated customer)
router.get('/mine', authenticateToken, BookingController.getMine);

// Single booking for guest via explicit /guest/:id alias
router.get('/guest/:id', optionalAuthenticateToken, bookingLookupLimiter, BookingController.getById);

// Single booking (owner, guest with token, or admin/dispatcher)
router.get('/:id', optionalAuthenticateToken, bookingLookupLimiter, BookingController.getById);

// Live technician tracking (owner, guest with token, admin/dispatcher)
router.get('/:id/tracking', optionalAuthenticateToken, bookingLookupLimiter, TrackingController.getTracking);

// Cancel booking (owner, guest with token, or admin/dispatcher)
router.post(
  '/:id/cancel',
  optionalAuthenticateToken,
  bookingLookupLimiter,
  validateBody(cancelBookingSchema),
  BookingController.cancel
);

// Reschedule booking (owner, guest with token, or admin/dispatcher)
router.post(
  '/:id/reschedule',
  optionalAuthenticateToken,
  bookingLookupLimiter,
  validateBody(rescheduleBookingSchema),
  BookingController.reschedule
);

// ---------------------------------------------------------------------------
// 3. Admin / Dispatcher Management
// ---------------------------------------------------------------------------
// List all bookings with filters, search, and CSV export
router.get(
  '/',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  BookingController.adminList
);

// State machine transition
router.patch(
  '/:id/status',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  validateBody(updateBookingStatusSchema),
  BookingController.adminUpdateStatus
);

// Edit notes, address, or assigned technician
router.patch(
  '/:id',
  authenticateToken,
  requireRoles('admin', 'dispatcher'),
  validateBody(adminUpdateBookingSchema),
  BookingController.adminUpdate
);

// Delete booking (admin only)
router.delete(
  '/:id',
  authenticateToken,
  requireAdminRole,
  BookingController.adminDelete
);

export default router;
