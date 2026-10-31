import { z } from 'zod';

export const updateLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).optional(),
  speed: z.number().min(0).max(500).optional(),
  accuracy: z.number().min(0).max(10000).optional(),
});
