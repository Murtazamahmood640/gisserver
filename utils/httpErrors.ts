export interface AppError extends Error {
  statusCode: number;
  code: string;
  retryAfter?: number;
}

export function createHttpError(
  message: string,
  statusCode: number,
  code: string,
  retryAfter?: number
): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  err.code = code;
  if (retryAfter !== undefined) {
    err.retryAfter = retryAfter;
  }
  return err;
}

export function getErrorDetails(
  err: unknown,
  fallbackCode = 'SERVER_ERROR',
  fallbackStatus = 500
): { statusCode: number; code: string; message: string; retryAfter?: number } {
  const e = err as { statusCode?: number; code?: string; message?: string; retryAfter?: number };
  return {
    statusCode: typeof e?.statusCode === 'number' ? e.statusCode : fallbackStatus,
    code: typeof e?.code === 'string' ? e.code : fallbackCode,
    message: typeof e?.message === 'string' ? e.message : 'Internal server error',
    retryAfter: typeof e?.retryAfter === 'number' ? e.retryAfter : undefined,
  };
}
