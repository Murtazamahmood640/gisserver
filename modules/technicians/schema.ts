import { z } from 'zod';

export const registerTechnicianSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    fullName: z.string().min(2).max(100),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
    phoneCountryCode: z.string().optional(),
    businessType: z
      .enum(['individual_contractor', 'licensed_business', 'employee'])
      .optional(),
    yearsExperience: z.number().min(0).optional(),
    emergencyAfterHours: z.boolean().optional(),
    languages: z.array(z.string()).optional(),
    termsAccepted: z.boolean().optional(),
    serviceArea: z
      .object({
        zipCodes: z.array(z.string()).optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        radiusKm: z.number().optional(),
      })
      .optional(),
    skills: z
      .object({
        categoryIds: z.array(z.string()).optional(),
        serviceIds: z.array(z.string()).optional(),
      })
      .optional(),
    equipmentCapabilities: z
      .object({
        hasWaterTank: z.boolean().optional(),
        hasGenerator: z.boolean().optional(),
        hasCompressor: z.boolean().optional(),
        hasScanner: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

export const updateProfileSchema = z
  .object({
    displayName: z.string().min(2).max(100).optional(),
    bio: z.string().max(1000).optional(),
    photoUrl: z.string().url().optional(),
    phone: z.string().optional(),
    businessType: z
      .enum(['individual_contractor', 'licensed_business', 'employee'])
      .optional(),
    yearsExperience: z.number().min(0).optional(),
    emergencyAfterHours: z.boolean().optional(),
    languages: z.array(z.string()).optional(),
    certifications: z
      .array(
        z.object({
          title: z.string().min(1),
          organization: z.string().optional(),
          certificateNumber: z.string().optional(),
          expiresAt: z.coerce.date().optional(),
        })
      )
      .optional(),
    equipmentCapabilities: z
      .object({
        hasWaterTank: z.boolean().optional(),
        hasGenerator: z.boolean().optional(),
        hasCompressor: z.boolean().optional(),
        hasScanner: z.boolean().optional(),
      })
      .optional(),
    vehicleInfo: z
      .object({
        type: z.string().optional(),
        plate: z.string().optional(),
        capacity: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export const updateSkillsSchema = z
  .object({
    categoryIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).min(1),
    serviceIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).default([]),
  })
  .strict();

export const updateServiceAreaSchema = z
  .object({
    zipCodes: z.array(z.string()).min(1),
    city: z.string().optional(),
    state: z.string().optional(),
    radiusKm: z.number().positive().optional(),
  })
  .strict();

export const updateAvailabilitySchema = z
  .object({
    weeklySchedule: z
      .array(
        z.object({
          day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
          from: z.string().regex(/^\d{2}:\d{2}$/),
          to: z.string().regex(/^\d{2}:\d{2}$/),
        })
      )
      .optional(),
    timeOff: z
      .array(
        z.object({
          from: z.coerce.date(),
          to: z.coerce.date(),
          note: z.string().optional(),
        })
      )
      .optional(),
  })
  .strict();

export const setOnlineSchema = z
  .object({
    isOnline: z.boolean().default(true),
  })
  .strict();

export const adminRejectSchema = z
  .object({
    reason: z.string().min(1),
  })
  .strict();

export const adminSuspendSchema = z
  .object({
    reason: z.string().min(1),
  })
  .strict();

export const adminPatchSchema = z
  .object({
    skills: z
      .object({
        categoryIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
        serviceIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).optional(),
      })
      .optional(),
    serviceArea: z
      .object({
        zipCodes: z.array(z.string()).optional(),
        city: z.string().optional(),
        state: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export const docApproveSchema = z
  .object({
    note: z.string().optional(),
  })
  .strict();

export const docRejectSchema = z
  .object({
    note: z.string().min(1),
  })
  .strict();
