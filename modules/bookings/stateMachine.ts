import { BookingStatus } from '../../models/Booking';

export const VALID_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ['confirmed', 'cancelled', 'assigned'],
  confirmed: ['assigned', 'technician_en_route', 'in_progress', 'completed', 'cancelled', 'no_show'],
  assigned: ['technician_en_route', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'],
  technician_en_route: ['arrived', 'in_progress', 'completed', 'cancelled'],
  arrived: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: ['refunded'],
  cancelled: ['pending', 'confirmed'], // Admin deliberate reopen
  no_show: ['refunded', 'cancelled', 'confirmed'],
  refunded: [],
};

export function isValidTransition(from: BookingStatus, to: BookingStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
