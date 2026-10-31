import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const error: ZodError = result.error;
      const details = error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));

      res.status(400).json({
        success: false,
        message: 'Validation failed',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details,
        },
      });
      return;
    }

    req.body = result.data;
    next();
  };
}
