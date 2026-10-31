import { z } from 'zod';

export const vehicleCategoryEnum = z.enum([
  'sedan',
  'crossover',
  'suv',
  'truck',
  'rv-boat-semi',
]);

const currentYear = new Date().getFullYear();

export const createVehicleSchema = z
  .object({
    category: vehicleCategoryEnum,
    make: z.string().min(1, 'Vehicle make is required'),
    model: z.string().min(1).optional(),
    vehicleModel: z.string().min(1).optional(),
    year: z.coerce
      .number()
      .int()
      .min(1900, 'Invalid year')
      .max(currentYear + 2, 'Year cannot be in the distant future'),
    color: z.string().optional().default(''),
    plate: z.string().optional().default(''),
    vin: z.string().optional().default(''),
    isDefault: z.boolean().optional().default(false),
  })
  .transform((data) => ({
    ...data,
    vehicleModel: data.vehicleModel || data.model || '',
  }))
  .refine((data) => !!data.vehicleModel, {
    message: 'Vehicle model is required',
    path: ['model'],
  });

export const updateVehicleSchema = z
  .object({
    category: vehicleCategoryEnum.optional(),
    make: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    vehicleModel: z.string().min(1).optional(),
    year: z.coerce
      .number()
      .int()
      .min(1900)
      .max(currentYear + 2)
      .optional(),
    color: z.string().optional(),
    plate: z.string().optional(),
    vin: z.string().optional(),
    isDefault: z.boolean().optional(),
  })
  .transform((data) => {
    const res: any = { ...data };
    if (data.model && !data.vehicleModel) {
      res.vehicleModel = data.model;
    }
    return res;
  });
