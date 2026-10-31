import { z } from 'zod';

export const createPayoutSchema = z.object({
  technicianUserId: z.string().min(1, 'technicianUserId is required'),
  upToDate: z.string().optional(),
});

export const markPaidSchema = z.object({
  reference: z.string().trim().min(1, 'Reference is required'),
  method: z.enum(['bank', 'cash', 'other']),
  paidAt: z.string().optional(),
});
