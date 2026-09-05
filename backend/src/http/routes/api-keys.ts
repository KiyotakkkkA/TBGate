import { createApiKeySchema } from '@tg-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { currentUser } from '../plugins/auth.js';
import { validate } from '../validate.js';

export async function registerApiKeyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = { preHandler: app.requireSession };

  app.get('/api/v1/api-keys', guard, async (request) =>
    ctx.services.apiKeys.list(currentUser(request)),
  );

  /** The plaintext key is in this response and nowhere else - it is never stored. */
  app.post('/api/v1/api-keys', guard, async (request, reply) => {
    const input = validate(createApiKeySchema, request.body, 'API key');
    const created = await ctx.services.apiKeys.create(input, currentUser(request));
    reply.code(201);
    return created;
  });

  app.post<{ Params: { id: string } }>('/api/v1/api-keys/:id/revoke', guard, async (request) => {
    await ctx.services.apiKeys.revoke(request.params.id, currentUser(request));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/api-keys/:id', guard, async (request) => {
    await ctx.services.apiKeys.remove(request.params.id, currentUser(request));
    return { ok: true };
  });
}
