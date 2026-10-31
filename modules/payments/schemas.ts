import { z } from 'zod';

export const checkoutSchema = z.object({}).optional();

export const refundSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z.string().trim().min(1, 'Reason is required'),
});

export const offlinePaymentSchema = z.object({
  method: z.enum(['bank', 'cash', 'other']),
  reference: z.string().trim().min(1, 'Reference is required'),
  amountCents: z.number().int().positive('Amount must be positive integer cents'),
});

export const updatePaymentSettingsSchema = z.object({
  requirePrepayment: z.boolean().optional(),
  autoConfirmOnPayment: z.boolean().optional(),
  unpaidExpiryMinutes: z.number().int().positive().max(1440).optional(),
  currency: z.literal('usd').optional(),
  payoutHoldDays: z.number().int().min(0).max(90).optional(),
  minPayoutCents: z.number().int().min(0).optional(),
});
