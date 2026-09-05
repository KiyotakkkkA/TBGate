import type { ApiErrorBody, ErrorCode } from '@tg-gateway/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { EncryptionError } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';

function body(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ApiErrorBody {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

/**
 * Single error boundary: domain errors map to their own code and status, while anything
 * unexpected is logged in full and answered with a generic message so internals never leak.
 *
 * The 404 handler lives in server.ts instead - Fastify allows only one per prefix, and it
 * has to know whether the admin SPA is being served.
 */
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      const level = error.statusCode >= 500 ? 'error' : 'warn';
      request.log[level](
        { err: error, code: error.code, statusCode: error.statusCode },
        'Request failed',
      );
      reply.code(error.statusCode).send(body(error.code, error.message, request.id, error.details));
      return;
    }

    if (error instanceof EncryptionError) {
      request.log.error({ err: error }, 'Encryption failure');
      reply
        .code(500)
        .send(
          body(
            'ENCRYPTION_ERROR',
            'A stored secret could not be decrypted. Check that APP_ENCRYPTION_KEY matches the one used to write the database.',
            request.id,
          ),
        );
      return;
    }

    if (error.statusCode === 429) {
      reply.code(429).send(body('RATE_LIMITED', 'Too many requests, please slow down', request.id));
      return;
    }

    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ err: error }, 'Client error');
      reply
        .code(error.statusCode)
        .send(
          body(
            error.statusCode === 413 ? 'VALIDATION_ERROR' : 'VALIDATION_ERROR',
            error.message,
            request.id,
          ),
        );
      return;
    }

    request.log.error({ err: error }, 'Unhandled error');
    reply.code(500).send(body('INTERNAL_ERROR', 'An unexpected error occurred', request.id));
  });
});
