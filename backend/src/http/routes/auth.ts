import { changePasswordSchema, loginSchema } from '@tg-gateway/shared';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { CSRF_COOKIE, SESSION_COOKIE, toSessionUserDto } from '../../services/auth.js';
import { currentUser } from '../plugins/auth.js';
import { validate } from '../validate.js';

function cookieOptions(ctx: AppContext, expiresAt: Date): CookieSerializeOptions {
  return {
    path: '/',
    httpOnly: true,
    secure: ctx.env.COOKIE_SECURE,
    sameSite: ctx.env.COOKIE_SAME_SITE,
    expires: expiresAt,
  };
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/v1/auth/login', {
    config: { rateLimit: { max: ctx.env.LOGIN_RATE_LIMIT_MAX, timeWindow: 60_000 } },
    handler: async (request, reply) => {
      const input = validate(loginSchema, request.body, 'login request');
      const result = await ctx.services.auth.login(input.username, input.password, {
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      });

      const options = cookieOptions(ctx, result.expiresAt);
      reply.setCookie(SESSION_COOKIE, result.token, options);
      // Readable by the SPA so it can echo the value back as the CSRF header.
      reply.setCookie(CSRF_COOKIE, result.csrfToken, { ...options, httpOnly: false });

      return {
        user: result.user,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt.toISOString(),
      };
    },
  });

  app.post('/api/v1/auth/logout', {
    preHandler: app.requireSession,
    handler: async (request, reply) => {
      if (request.sessionToken) await ctx.services.auth.logout(request.sessionToken);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      reply.clearCookie(CSRF_COOKIE, { path: '/' });
      return { ok: true };
    },
  });

  app.get('/api/v1/auth/me', {
    preHandler: app.requireSession,
    handler: async (request) => ({
      user: toSessionUserDto(currentUser(request)),
      csrfToken: request.csrfToken,
    }),
  });

  app.post('/api/v1/auth/change-password', {
    preHandler: app.requireSession,
    handler: async (request) => {
      const input = validate(changePasswordSchema, request.body, 'password change');
      const user = currentUser(request);
      await ctx.services.users.changeOwnPassword(user.id, input.currentPassword, input.newPassword);
      return { ok: true };
    },
  });
}
