import type { ErrorCode } from '@tg-gateway/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.expose = options.expose ?? true;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super('VALIDATION_ERROR', message, 400, { details });
    this.name = 'ValidationError';
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super('FORBIDDEN', message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super('NOT_FOUND', `${resource} not found`, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
    this.name = 'ConflictError';
  }
}

export class TelegramApiError extends AppError {
  constructor(
    message: string,
    readonly telegramErrorCode: number | null,
    readonly telegramDescription: string | null,
  ) {
    super('TELEGRAM_API_ERROR', message, 502, {
      details: { telegramErrorCode, telegramDescription },
    });
    this.name = 'TelegramApiError';
  }
}

export class DestinationError extends AppError {
  constructor(code: 'DESTINATION_UNREACHABLE' | 'DESTINATION_URL_REJECTED', message: string) {
    super(code, message, 502);
    this.name = 'DestinationError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
