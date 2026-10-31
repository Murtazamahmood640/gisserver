import { z } from 'zod';

export const completeJobSchema = z.object({
  notes: z.string().max(2000).optional(),
  checklist: z
    .array(
      z.object({
        label: z.string().min(1),
        done: z.boolean(),
      })
    )
    .optional(),
});

export const releaseJobSchema = z.object({
  reason: z.string().min(1, 'Reason is required').max(500),
});
