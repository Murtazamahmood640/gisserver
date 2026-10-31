import mongoose from 'mongoose';
import { BookingSettings, IBookingSettings } from '../../models/BookingSettings';
import { SlotReservation } from '../../models/SlotReservation';
import { Service } from '../../models/Service';
import { ServiceCategory } from '../../models/ServiceCategory';
import logger from '../../config/logger';

export interface SlotAvailabilityItem {
  slot: string; // 24h format "HH:mm"
  available: boolean;
  remaining: number;
}

export class SlotFullError extends Error {
  statusCode = 409;
  code = 'SLOT_FULL';
  constructor(message = 'The requested time slot is completely booked') {
    super(message);
    this.name = 'SlotFullError';
  }
}

/**
 * Normalizes any slot string ("09:00 AM", "1:00 PM", "13:00") into standard 24h "HH:mm".
 */
export function normalizeSlotTo24h(slotStr: string): string {
  const trimmed = slotStr.trim().toUpperCase();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/);
  if (!match) return trimmed;
  let hour = parseInt(match[1], 10);
  const minute = match[2];
  const ampm = match[3];

  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  return `${String(hour).padStart(2, '0')}:${minute}`;
}

/**
 * Formats a 24h "HH:mm" slot into 12h display format "9:00 AM" / "1:00 PM".
 */
export function formatSlotTo12h(slot24: string): string {
  const [hStr, mStr] = slot24.split(':');
  let hour = parseInt(hStr, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  return `${hour}:${mStr} ${ampm}`;
}

/**
 * Converts a local calendar date ("YYYY-MM-DD") and slot ("HH:mm") in a specific
 * IANA timezone into a UTC Date object using native Intl formatting.
 */
export function localToUtc(dateStr: string, slotStr: string, timeZone: string = 'UTC'): Date {
  const slot24 = normalizeSlotTo24h(slotStr);
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = slot24.split(':').map(Number);

  // Initial candidate as UTC
  const utcCandidate = new Date(Date.UTC(year, month - 1, day, hour, minute));

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(utcCandidate);
    const getPart = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);

    const tzYear = getPart('year');
    const tzMonth = getPart('month');
    const tzDay = getPart('day');
    let tzHour = getPart('hour');
    if (tzHour === 24) tzHour = 0;
    const tzMinute = getPart('minute');

    const tzAsUtc = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute);
    const offsetMs = tzAsUtc - utcCandidate.getTime();

    return new Date(utcCandidate.getTime() - offsetMs);
  } catch {
    return utcCandidate;
  }
}

/**
 * Converts a UTC Date into local { date: "YYYY-MM-DD", slot: "HH:mm" } in an IANA timezone.
 */
export function utcToLocal(
  utcDate: Date,
  timeZone: string = 'UTC'
): { date: string; slot: string } {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(utcDate);
    const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '00';

    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    let hour = getPart('hour');
    if (hour === '24') hour = '00';
    const minute = getPart('minute');

    return {
      date: `${year}-${month}-${day}`,
      slot: `${hour}:${minute}`,
    };
  } catch {
    const iso = utcDate.toISOString();
    return {
      date: iso.split('T')[0],
      slot: iso.split('T')[1].substring(0, 5),
    };
  }
}

export class AvailabilityService {
  /**
   * Retrieves or initializes default booking settings.
   */
  static async getBookingSettings(): Promise<IBookingSettings> {
    let settings = await BookingSettings.findOne();
    if (!settings) {
      settings = await BookingSettings.create({
        businessTimezone: process.env.BUSINESS_TIMEZONE || 'America/New_York',
        slots: [
          '08:00',
          '09:00',
          '10:00',
          '11:00',
          '12:00',
          '13:00',
          '14:00',
          '15:00',
          '16:00',
          '17:00',
        ],
        slotCapacity: 2,
        minLeadHours: 2,
        maxAdvanceDays: 60,
        cancellation: { freeCancelHours: 24, lateFeePercent: 20 },
        closedDates: [],
      });
    }
    return settings;
  }

  /**
   * Checks slot availability for a specified date and category.
   */
  static async getAvailability(params: {
    date: string; // "YYYY-MM-DD"
    serviceId?: string;
    categoryId?: string;
  }): Promise<{
    date: string;
    timezone: string;
    slots: SlotAvailabilityItem[];
  }> {
    const { date, serviceId, categoryId: rawCatId } = params;

    const settings = await this.getBookingSettings();
    const timezone = settings.businessTimezone;

    // Resolve categoryId
    let resolvedCategoryId: mongoose.Types.ObjectId | null = null;
    if (rawCatId && mongoose.isValidObjectId(rawCatId)) {
      resolvedCategoryId = new mongoose.Types.ObjectId(rawCatId);
    } else if (serviceId) {
      let service = null;
      if (mongoose.isValidObjectId(serviceId)) {
        service = await Service.findById(serviceId);
      } else {
        service = await Service.findOne({ slug: serviceId });
      }
      if (service && service.categoryId) {
        resolvedCategoryId = service.categoryId as mongoose.Types.ObjectId;
      }
    }

    if (!resolvedCategoryId) {
      // Default to mobile detailing category if not provided
      const defaultCategory = await ServiceCategory.findOne({ slug: 'mobile-detailing' });
      if (defaultCategory) {
        resolvedCategoryId = defaultCategory._id;
      }
    }

    const slots = settings.slots || [];
    const slotCapacity = settings.slotCapacity || 2;
    const now = new Date();

    // 1. Check if date is in closed dates
    if (settings.closedDates.includes(date)) {
      return {
        date,
        timezone,
        slots: slots.map((s) => ({ slot: s, available: false, remaining: 0 })),
      };
    }

    // 2. Lead time cutoff in UTC
    const leadTimeCutoffUtc = new Date(now.getTime() + settings.minLeadHours * 3600 * 1000);

    // 3. Max advance days check
    const maxDateUtc = new Date(now.getTime() + settings.maxAdvanceDays * 24 * 3600 * 1000);

    // 4. Query current reservations for this date and category
    const reservations = resolvedCategoryId
      ? await SlotReservation.find({ date, categoryId: resolvedCategoryId })
      : [];

    const reservationMap: Record<string, number> = {};
    for (const r of reservations) {
      reservationMap[normalizeSlotTo24h(r.slot)] = r.count;
    }

    const resultSlots: SlotAvailabilityItem[] = slots.map((rawSlot) => {
      const slot24 = normalizeSlotTo24h(rawSlot);
      const slotUtc = localToUtc(date, slot24, timezone);

      // Check if slot is within lead time or past max advance days
      const isPastOrTooSoon = slotUtc <= leadTimeCutoffUtc;
      const isBeyondAdvance = slotUtc > maxDateUtc;

      const currentCount = reservationMap[slot24] || 0;
      const remaining = Math.max(0, slotCapacity - currentCount);
      const available = !isPastOrTooSoon && !isBeyondAdvance && remaining > 0;

      return {
        slot: slot24,
        available,
        remaining,
      };
    });

    return {
      date,
      timezone,
      slots: resultSlots,
    };
  }

  /**
   * Atomically reserves a slot for a given date, slot, and category.
   * Throws SlotFullError (HTTP 409) if capacity is reached.
   */
  static async reserveSlotAtomic(
    date: string,
    rawSlot: string,
    categoryId: mongoose.Types.ObjectId,
    capacity?: number
  ): Promise<boolean> {
    const slot = normalizeSlotTo24h(rawSlot);
    let targetCapacity = capacity;
    if (!targetCapacity) {
      const settings = await this.getBookingSettings();
      targetCapacity = settings.slotCapacity || 2;
    }

    // 1. Try atomic increment if count < capacity
    const updated = await SlotReservation.findOneAndUpdate(
      { date, slot, categoryId, count: { $lt: targetCapacity } },
      { $inc: { count: 1 } },
      { returnDocument: 'after' }
    );

    if (updated) {
      logger.info({ date, slot, count: updated.count }, 'Slot reserved successfully');
      return true;
    }

    // 2. Document may not exist yet or count is at capacity
    const existing = await SlotReservation.findOne({ date, slot, categoryId });
    if (existing && existing.count >= targetCapacity) {
      throw new SlotFullError(
        `Selected slot '${slot}' on ${date} is fully booked (capacity: ${targetCapacity})`
      );
    }

    if (!existing) {
      try {
        await SlotReservation.create({
          date,
          slot,
          categoryId,
          count: 1,
        });
        logger.info({ date, slot, count: 1 }, 'Initial slot reservation created');
        return true;
      } catch (err: any) {
        if (err.code === 11000) {
          // Concurrent insert occurred; retry the atomic findOneAndUpdate
          const retry = await SlotReservation.findOneAndUpdate(
            { date, slot, categoryId, count: { $lt: targetCapacity } },
            { $inc: { count: 1 } },
            { returnDocument: 'after' }
          );
          if (retry) return true;
          throw new SlotFullError(
            `Selected slot '${slot}' on ${date} is fully booked (capacity: ${targetCapacity})`
          );
        }
        throw err;
      }
    }

    throw new SlotFullError(
      `Selected slot '${slot}' on ${date} is fully booked (capacity: ${targetCapacity})`
    );
  }

  /**
   * Releases an atomic slot reservation (e.g. on cancellation, reschedule, or failed booking).
   */
  static async releaseSlotAtomic(
    date: string,
    rawSlot: string,
    categoryId: mongoose.Types.ObjectId
  ): Promise<void> {
    const slot = normalizeSlotTo24h(rawSlot);
    await SlotReservation.updateOne(
      { date, slot, categoryId, count: { $gt: 0 } },
      { $inc: { count: -1 } }
    );
    logger.info({ date, slot, categoryId: categoryId.toString() }, 'Slot reservation released');
  }
}
