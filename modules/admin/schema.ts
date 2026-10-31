import { z } from 'zod';

export const adminOverviewQuerySchema = z.object({
  range: z.enum(['7d', '30d', '90d']).default('7d'),
});

export type AdminOverviewQuery = z.infer<typeof adminOverviewQuerySchema>;
