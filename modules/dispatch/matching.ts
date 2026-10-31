import mongoose from 'mongoose';
import { IBooking, Booking } from '../../models/Booking';
import { TechnicianProfile, ITechnicianProfile, DayOfWeek } from '../../models/TechnicianProfile';
import { User, IUser } from '../../models/User';
import { DispatchOffer } from '../../models/DispatchOffer';
import { TechnicianLocation } from '../../models/TechnicianLocation';
import { DispatchSettings } from '../../models/DispatchSettings';
import { Service } from '../../models/Service';

export interface CandidateEvaluation {
  technicianUserId: string;
  technicianProfileId: string;
  displayName: string;
  photoUrl?: string;
  ratingAvg: number;
  jobsToday: number;
  distanceKm: number | null;
  eligible: boolean;
  exclusionReason?: string;
  rank?: number;
}

/**
 * Calculates Great-Circle distance in km between two GeoJSON Points [lng, lat].
 */
export function haversineDistanceKm(coord1: [number, number], coord2: [number, number]): number {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

/**
 * Converts a Date to DayOfWeek ('mon'..'sun') and 'HH:mm' in target timezone.
 */
export function getLocalDayAndSlot(
  date: Date,
  timeZone: string
): { day: DayOfWeek; timeMinutes: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const weekdayStr = parts.find((p) => p.type === 'weekday')?.value?.toLowerCase() || '';
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);

    const dayMap: Record<string, DayOfWeek> = {
      mon: 'mon',
      tue: 'tue',
      wed: 'wed',
      thu: 'thu',
      fri: 'fri',
      sat: 'sat',
      sun: 'sun',
    };
    const day = dayMap[weekdayStr.slice(0, 3)] || 'mon';
    return { day, timeMinutes: hour * 60 + minute };
  } catch {
    const days: DayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const d = days[date.getUTCDay()];
    return { day: d, timeMinutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
}

/**
 * Parses "HH:mm" to minutes from midnight.
 */
export function parseTimeMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map((s) => parseInt(s, 10));
  return (h || 0) * 60 + (m || 0);
}

/**
 * Checks if a technician has a schedule or availability conflict for a given target time window.
 */
export function checkTechnicianAvailabilityConflict(
  profile: ITechnicianProfile,
  targetStart: Date,
  targetEnd: Date,
  serviceDurationMinutes: number,
  timezone: string,
  excludeBookingId?: string
): { hasConflict: boolean; reason?: string } {
  // 1. Check schedule conflicts in activeSchedule (other than excludeBookingId)
  if (profile.activeSchedule && profile.activeSchedule.length > 0) {
    const sStart = targetStart.getTime();
    const sEnd = targetEnd.getTime();
    for (const slot of profile.activeSchedule) {
      if (excludeBookingId && slot.bookingId?.toString() === excludeBookingId.toString()) {
        continue;
      }
      const slotStart = new Date(slot.start).getTime();
      const slotEnd = new Date(slot.end).getTime();
      if (sStart < slotEnd && slotStart < sEnd) {
        return {
          hasConflict: true,
          reason: 'Technician has an overlapping assigned booking',
        };
      }
    }
  }

  // 2. Check weekly working schedule
  const { day, timeMinutes } = getLocalDayAndSlot(targetStart, timezone);
  const schedules = profile.availability?.weeklySchedule || [];
  const daySchedule = schedules.find((s: { day: DayOfWeek }) => s.day === day);
  if (!daySchedule) {
    return {
      hasConflict: true,
      reason: `Technician has no working schedule for ${day}`,
    };
  }

  const fromMinutes = parseTimeMinutes(daySchedule.from);
  const toMinutes = parseTimeMinutes(daySchedule.to);
  const bookingEndMinutes = timeMinutes + serviceDurationMinutes;
  if (timeMinutes < fromMinutes || bookingEndMinutes > toMinutes) {
    return {
      hasConflict: true,
      reason: `Requested time slot is outside technician working hours (${daySchedule.from}-${daySchedule.to})`,
    };
  }

  // 3. Check time off
  const timeOffs = profile.availability?.timeOff || [];
  const sStart = targetStart.getTime();
  const sEnd = targetEnd.getTime();
  for (const to of timeOffs) {
    const toStart = new Date(to.from).getTime();
    const toEnd = new Date(to.to).getTime();
    if (sStart < toEnd && toStart < sEnd) {
      return {
        hasConflict: true,
        reason: `Booking falls during technician scheduled time off (${to.note || 'Time Off'})`,
      };
    }
  }

  return { hasConflict: false };
}

/**
 * Returns ranked eligible candidates for a given booking.
 */
export async function eligibleTechnicians(
  booking: IBooking,
  options?: { explain?: boolean }
): Promise<CandidateEvaluation[]> {
  const settings = await DispatchSettings.getSettings();
  const timezone = booking.timezone || process.env.BUSINESS_TIMEZONE || 'America/New_York';

  // 1. Load all technician profiles
  const profiles = await TechnicianProfile.find().lean();
  if (profiles.length === 0) return [];

  const userIds = profiles.map((p) => p.userId);
  const users = await User.find({ _id: { $in: userIds } }).lean();
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  // Load active locations
  const locations = await TechnicianLocation.find({
    technicianUserId: { $in: userIds },
  }).lean();
  const locationMap = new Map(
    locations.map((l) => [l.technicianUserId.toString(), l])
  );

  // Load existing offers for this booking
  const existingOffers = await DispatchOffer.find({
    bookingId: booking._id,
  }).lean();
  const offeredTechSet = new Set<string>(
    existingOffers
      .filter((o) => ['sent', 'accepted', 'declined'].includes(o.status))
      .map((o) => o.technicianUserId.toString())
  );

  // Determine booking estimated duration (default 60 minutes)
  let serviceDurationMinutes = 60;
  if (booking.serviceId) {
    const serviceDoc = (await Service.findById(booking.serviceId).lean()) as { durationMinutes?: number } | null;
    if (serviceDoc && serviceDoc.durationMinutes) {
      serviceDurationMinutes = serviceDoc.durationMinutes;
    }
  }
  const bufferMinutes = settings.scheduleBufferMinutes ?? 30;
  const bookingStart = new Date(booking.scheduledAt).getTime();
  const bookingEnd = bookingStart + (serviceDurationMinutes + bufferMinutes) * 60 * 1000;

  // Load open offers across all candidates to prevent overlapping offer conflicts
  const now = new Date();
  const openOffers = await DispatchOffer.find({
    technicianUserId: { $in: userIds },
    status: 'sent',
    expiresAt: { $gt: now },
    bookingId: { $ne: booking._id },
  }).lean();
  const openOfferBookingIds = openOffers.map((o) => o.bookingId);
  const openOfferBookings = await Booking.find({
    _id: { $in: openOfferBookingIds },
    deletedAt: null,
  }).lean();
  const openOfferBookingMap = new Map(
    openOfferBookings.map((b) => [b._id.toString(), b])
  );

  // Day boundaries in booking timezone for "jobs today" count
  const startOfDay = new Date(booking.scheduledAt);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(booking.scheduledAt);
  endOfDay.setUTCHours(23, 59, 59, 999);

  // Load today's active/assigned/completed bookings for all candidates
  const activeBookings = await Booking.find({
    $or: [
      { technicianId: { $in: userIds } },
      { 'assignment.technicianUserId': { $in: userIds } },
    ],
    status: { $in: ['assigned', 'technician_en_route', 'arrived', 'in_progress', 'completed'] },
    scheduledAt: { $gte: startOfDay, $lte: endOfDay },
    deletedAt: null,
    _id: { $ne: booking._id },
  }).lean();

  const evaluations: CandidateEvaluation[] = [];

  for (const profile of profiles) {
    const techUserId = profile.userId.toString();
    const user = userMap.get(techUserId);

    let eligible = true;
    let exclusionReason: string | undefined;

    // Check 1: Profile approved
    if (profile.verificationStatus !== 'approved') {
      eligible = false;
      exclusionReason = `Technician verification status is '${profile.verificationStatus}', required 'approved'`;
    }

    // Check 2: User active and email verified
    if (eligible && (!user || user.status !== 'active' || user.isActive === false)) {
      eligible = false;
      exclusionReason = `Technician user account is not active (status='${user?.status}')`;
    }
    if (eligible && user && user.emailVerified === false) {
      eligible = false;
      exclusionReason = 'Technician email is not verified';
    }

    // Check 3: Online status
    // isOnline flag is required only when the booking is ASAP or its scheduledAt is within dispatchSettings.onlineRequiredWithinHours (default 3)
    const hoursUntilScheduled = (bookingStart - Date.now()) / (1000 * 60 * 60);
    const onlineRequired = Boolean(
      booking.isAsap || hoursUntilScheduled <= (settings.onlineRequiredWithinHours ?? 3)
    );
    if (eligible && onlineRequired && !profile.availability?.isOnline) {
      eligible = false;
      exclusionReason = 'Technician is currently offline (required for ASAP or near-term bookings)';
    }

    // Check 4: Skill matches service or category
    if (eligible) {
      const skills = profile.skills || { categoryIds: [], serviceIds: [] };
      const hasServiceSkill =
        booking.serviceId &&
        skills.serviceIds?.some(
          (s: mongoose.Types.ObjectId | string) => s.toString() === booking.serviceId.toString()
        );
      const hasCategorySkill =
        booking.categoryId &&
        skills.categoryIds?.some(
          (c: mongoose.Types.ObjectId | string) => c.toString() === booking.categoryId.toString()
        );
      if (!hasServiceSkill && !hasCategorySkill) {
        eligible = false;
        exclusionReason = 'Technician skills do not cover booking service or category';
      }
    }

    // Check 5: Service area covers booking (zip match OR radius match)
    let distanceKm: number | null = null;
    const bookingZip = booking.address?.zip?.trim();
    const techZipCodes = (profile.serviceArea?.zipCodes || []).map((z: string) => z.trim());

    if (eligible) {
      const zipMatched = Boolean(bookingZip && techZipCodes.includes(bookingZip));
      let radiusMatched = false;

      // Check geo distance from current location or serviceArea center
      const techLoc = locationMap.get(techUserId);
      const techCoord: [number, number] | undefined =
        techLoc?.location?.coordinates || profile.serviceArea?.center?.coordinates;

      if (techCoord && booking.location?.coordinates) {
        distanceKm = haversineDistanceKm(techCoord, booking.location.coordinates);
        const radius = profile.serviceArea?.radiusKm || settings.maxDistanceKm;
        if (distanceKm <= radius) {
          radiusMatched = true;
        }
      }

      if (!zipMatched && !radiusMatched) {
        eligible = false;
        exclusionReason = `Booking location/zip (${bookingZip || 'none'}) is outside technician service area`;
      }
    }

    // Check 6: Maximum distance limit (when distance is known)
    if (eligible && distanceKm !== null && distanceKm > settings.maxDistanceKm) {
      eligible = false;
      exclusionReason = `Distance (${distanceKm} km) exceeds maximum dispatch radius (${settings.maxDistanceKm} km)`;
    }

    // Check 7: Weekly availability and Time Off
    if (eligible) {
      const { day, timeMinutes } = getLocalDayAndSlot(new Date(booking.scheduledAt), timezone);
      const schedules = profile.availability?.weeklySchedule || [];
      const daySchedule = schedules.find((s: { day: DayOfWeek }) => s.day === day);

      if (!daySchedule) {
        eligible = false;
        exclusionReason = `Technician has no working schedule for ${day}`;
      } else {
        const fromMinutes = parseTimeMinutes(daySchedule.from);
        const toMinutes = parseTimeMinutes(daySchedule.to);
        const bookingEndMinutes = timeMinutes + serviceDurationMinutes;
        if (timeMinutes < fromMinutes || bookingEndMinutes > toMinutes) {
          eligible = false;
          exclusionReason = `Booking time slot (${Math.floor(timeMinutes / 60)}:${timeMinutes % 60}) is outside working hours (${daySchedule.from}-${daySchedule.to})`;
        }
      }

      // Check time off
      if (eligible) {
        const timeOffs = profile.availability?.timeOff || [];
        for (const to of timeOffs) {
          const toStart = new Date(to.from).getTime();
          const toEnd = new Date(to.to).getTime();
          if (bookingStart >= toStart && bookingStart <= toEnd) {
            eligible = false;
            exclusionReason = `Booking falls during technician scheduled time off (${to.note || 'Vacation/Leave'})`;
            break;
          }
        }
      }
    }

    // Check 8: Schedule conflict with existing active assigned bookings or open sent offers
    if (eligible) {
      const techActiveBookings = activeBookings.filter(
        (b) =>
          (b.technicianId?.toString() === techUserId ||
            b.assignment?.technicianUserId?.toString() === techUserId) &&
          ['assigned', 'technician_en_route', 'arrived', 'in_progress'].includes(b.status)
      );

      for (const b of techActiveBookings) {
        const bStart = new Date(b.scheduledAt).getTime();
        const bEnd = bStart + (60 + bufferMinutes) * 60 * 1000;
        if (bookingStart < bEnd && bookingEnd > bStart) {
          eligible = false;
          exclusionReason = `Technician has an overlapping booking (${b.bookingNumber})`;
          break;
        }
      }

      // Check open (sent) offers for other bookings
      if (eligible) {
        const techOpenOffers = openOffers.filter(
          (o) => o.technicianUserId.toString() === techUserId
        );
        for (const o of techOpenOffers) {
          const ob = openOfferBookingMap.get(o.bookingId.toString());
          if (ob) {
            const obStart = new Date(ob.scheduledAt).getTime();
            const obEnd = obStart + (60 + bufferMinutes) * 60 * 1000;
            if (bookingStart < obEnd && bookingEnd > obStart) {
              eligible = false;
              exclusionReason = `Technician has an overlapping open offer for booking (${ob.bookingNumber})`;
              break;
            }
          }
        }
      }
    }

    // Check 9: Not already offered or declined for this booking
    if (eligible && offeredTechSet.has(techUserId)) {
      eligible = false;
      exclusionReason = 'Technician already received or responded to an offer for this booking';
    }

    // Jobs completed today count
    const jobsToday = activeBookings.filter(
      (b) =>
        (b.technicianId?.toString() === techUserId ||
          b.assignment?.technicianUserId?.toString() === techUserId) &&
        b.status === 'completed'
    ).length;

    evaluations.push({
      technicianUserId: techUserId,
      technicianProfileId: profile._id.toString(),
      displayName: profile.displayName || user?.fullName || 'Technician',
      photoUrl: profile.photoUrl,
      ratingAvg: profile.rating?.avg ?? 5.0,
      jobsToday,
      distanceKm,
      eligible,
      exclusionReason,
    });
  }

  // Filter or return all for explain mode
  const eligibleOnly = evaluations.filter((e) => e.eligible);

  // Sorting / Ranking rules:
  // 1. Distance (ascending, nulls last)
  // 2. Rating avg (descending)
  // 3. Jobs today (ascending)
  // 4. Deterministic tie-break by technicianUserId
  eligibleOnly.sort((a, b) => {
    if (a.distanceKm !== null && b.distanceKm !== null) {
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    } else if (a.distanceKm !== null && b.distanceKm === null) {
      return -1;
    } else if (a.distanceKm === null && b.distanceKm !== null) {
      return 1;
    }

    if (b.ratingAvg !== a.ratingAvg) {
      return b.ratingAvg - a.ratingAvg;
    }

    if (a.jobsToday !== b.jobsToday) {
      return a.jobsToday - b.jobsToday;
    }

    return a.technicianUserId.localeCompare(b.technicianUserId);
  });

  // Assign ranks
  eligibleOnly.forEach((c, index) => {
    c.rank = index + 1;
  });

  if (options?.explain) {
    return evaluations;
  }

  return eligibleOnly;
}
