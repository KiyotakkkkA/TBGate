export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'CSRF_INVALID',
  'ACCOUNT_BLOCKED',
  'INVALID_CREDENTIALS',
  'TELEGRAM_API_ERROR',
  'TELEGRAM_TOKEN_INVALID',
  'WEBHOOK_NOT_CONFIGURED',
  'DESTINATION_UNREACHABLE',
  'DESTINATION_URL_REJECTED',
  'ENCRYPTION_ERROR',
  'CONFIGURATION_ERROR',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
