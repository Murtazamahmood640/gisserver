import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';

interface MongoError extends Error {
  code?: number;
  keyValue?: Record<string, unknown>;
  errors?: Record<string, { message: string; path?: string }>;
  path?: string;
  value?: unknown;
}

export function globalErrorHandler(
  err: MongoError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  logger.error({ err, reqId: (req as any).id }, '[Error Handler] Unhandled error');


  // Mongoose Validation Error -> 400
  if (err.name === 'ValidationError' && err.errors) {
    const details = Object.entries(err.errors).map(([field, errObj]) => ({
      field,
      message: errObj.message,
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

  // Mongoose CastError (e.g. invalid ObjectId) -> 400
  if (err.name === 'CastError') {
    res.status(400).json({
      success: false,
      message: `Invalid format for field '${err.path}'`,
      error: {
        code: 'INVALID_CAST',
        message: `Invalid format for field '${err.path}': ${String(err.value)}`,
      },
    });
    return;
  }

  // Duplicate key error (code 11000) -> 409
  if (err.code === 11000) {
    const fields = err.keyValue ? Object.keys(err.keyValue).join(', ') : 'field';
    res.status(409).json({
      success: false,
      message: `Duplicate entry for ${fields}`,
      error: {
        code: 'DUPLICATE_KEY_ERROR',
        message: `A record with this ${fields} already exists`,
        details: err.keyValue,
      },
    });
    return;
  }

  // Malformed JSON payload -> 400
  if (err instanceof SyntaxError && 'status' in err && (err as { status?: number }).status === 400) {
    res.status(400).json({
      success: false,
      message: 'Malformed JSON payload',
      error: {
        code: 'BAD_REQUEST',
        message: 'Malformed JSON payload',
      },
    });
    return;
  }

  // CORS Error -> 403
  if (err.message === 'Not allowed by CORS') {
    res.status(403).json({
      success: false,
      message: 'Not allowed by CORS policy',
      error: {
        code: 'CORS_FORBIDDEN',
        message: 'Origin not allowed by CORS policy',
      },
    });
    return;
  }

  // Application / Custom Error (e.g. statusCode 400, 401, 403, 404, 409)
  const customStatus = (err as any).statusCode || (err as any).status;
  if (customStatus && typeof customStatus === 'number') {
    res.status(customStatus).json({
      success: false,
      message: err.message || 'An error occurred',
      error: {
        code: (err as any).code || 'ERROR',
        message: err.message || 'An error occurred',
        details: (err as any).details,
      },
    });
    return;
  }

  // Fallback -> 500
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message:
        process.env.NODE_ENV === 'development'
          ? err.message || 'Internal server error'
          : 'Internal server error',
    },
  });
}
