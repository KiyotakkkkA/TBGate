import type { ApiScope, UserRole } from '@tg-gateway/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { AppContext } from '../../app-context.js';
import type { UserRow } from '../../db/schema.js';
import { AppError, ForbiddenError, UnauthenticatedError } from '../../lib/errors.js';
import { ApiKeyService, type ApiKeyPrincipal } from '../../services/api-keys.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../../services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present on admin routes after `requireSession`. */
    currentUser?: UserRow;
    sessionToken?: string;
    csrfToken?: string;
    /** Present on gateway API routes after `requireApiKey`. */
    apiPrincipal?: ApiKeyPrincipal;
  }

  interface FastifyInstance {
    requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireApiKey: (
      scope: ApiScope,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Accepts either an admin session cookie or a gateway API key holding `scope`. */
    requireAuth: (
      scope: ApiScope,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function assertRole(user: UserRow, role: UserRole): void {
  if (user.role !== role) {
    throw new ForbiddenError('This action requires administrator privileges');
  }
}

/**
 * Session and API-key authentication.
 *
 * Admin routes use an HttpOnly session cookie plus a double-submit CSRF token; the gateway
 * API uses bearer API keys and is therefore exempt from CSRF (no ambient credentials).
 */
export const authPlugin = fp(async (app: FastifyInstance, options: { ctx: AppContext }) => {
  const { ctx } = options;

  app.decorate('requireSession', async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw new UnauthenticatedError('You are not signed in');

    const { session, user } = await ctx.services.auth.resolve(token);

    if (MUTATING_METHODS.has(request.method)) {
      const presented = request.headers[CSRF_HEADER];
      const value = Array.isArray(presented) ? presented[0] : presented;
      if (!value || value !== session.csrfToken) {
        throw new AppError('CSRF_INVALID', 'Missing or invalid CSRF token', 403);
      }
    }

    request.currentUser = user;
    request.sessionToken = token;
    request.csrfToken = session.csrfToken;
  });

  app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.requireSession(request, reply);
    assertRole(request.currentUser as UserRow, 'admin');
  });

  app.decorate('requireApiKey', (scope: ApiScope) => async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const apiKeyHeader = request.headers['x-api-key'];
    let token: string | null = null;

    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      token = header.slice(7).trim();
    } else if (typeof apiKeyHeader === 'string') {
      token = apiKeyHeader.trim();
    }
    if (!token) {
      throw new UnauthenticatedError('Provide a gateway API key via the Authorization header');
    }

    const principal = await ctx.services.apiKeys.authenticate(token);
    ApiKeyService.assertScope(principal, scope);
    request.apiPrincipal = principal;

    // An API key acts as its owner, so the same ownership rules apply to key traffic.
    if (!principal.ownerId) {
      throw new ForbiddenError('This API key has no owner and can no longer be used');
    }
    const owner = await ctx.services.users.findById(principal.ownerId);
    if (!owner) throw new ForbiddenError('The owner of this API key no longer exists');
    if (owner.status === 'blocked')
      throw new ForbiddenError('The owner of this API key is blocked');
    request.currentUser = owner;
  });

  app.decorate(
    'requireAuth',
    (scope: ApiScope) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.cookies[SESSION_COOKIE]) {
        await app.requireSession(request, reply);
        return;
      }
      await app.requireApiKey(scope)(request, reply);
    },
  );
});

export function currentUser(request: FastifyRequest): UserRow {
  const user = request.currentUser;
  if (!user) throw new UnauthenticatedError();
  return user;
}
