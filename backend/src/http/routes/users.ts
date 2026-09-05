import { createUserSchema, resetUserPasswordSchema, updateUserSchema } from '@tg-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { currentUser } from '../plugins/auth.js';
import { validate } from '../validate.js';

/**
 * User administration. Every route here is admin-only: managers can see their own
 * resources but never other accounts.
 */
export async function registerUserRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = { preHandler: app.requireAdmin };

  app.get('/api/v1/users', guard, async () => ctx.services.users.list());

  app.post('/api/v1/users', guard, async (request, reply) => {
    const input = validate(createUserSchema, request.body, 'user');
    const user = await ctx.services.users.create(input);
    reply.code(201);
    return user;
  });

  app.patch<{ Params: { id: string } }>('/api/v1/users/:id', guard, async (request) => {
    const input = validate(updateUserSchema, request.body, 'user');
    return ctx.services.users.update(request.params.id, input, currentUser(request).id);
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/users/:id/reset-password',
    guard,
    async (request) => {
      const input = validate(resetUserPasswordSchema, request.body, 'password reset');
      await ctx.services.users.resetPassword(request.params.id, input.newPassword);
      return { ok: true, mustChangePassword: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/users/:id', guard, async (request) => {
    await ctx.services.users.remove(request.params.id, currentUser(request).id);
    return { ok: true };
  });
}
