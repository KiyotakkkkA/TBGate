import { createDestinationSchema, updateDestinationSchema } from '@tg-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { currentUser } from '../plugins/auth.js';
import { validate } from '../validate.js';

export async function registerDestinationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const guard = { preHandler: app.requireSession };

  app.get('/api/v1/destinations', guard, async (request) =>
    ctx.services.destinations.list(currentUser(request)),
  );

  app.post('/api/v1/destinations', guard, async (request, reply) => {
    const input = validate(createDestinationSchema, request.body, 'destination');
    const destination = await ctx.services.destinations.create(input, currentUser(request));
    reply.code(201);
    return destination;
  });

  app.get<{ Params: { id: string } }>('/api/v1/destinations/:id', guard, async (request) =>
    ctx.services.destinations.get(request.params.id, currentUser(request)),
  );

  app.patch<{ Params: { id: string } }>('/api/v1/destinations/:id', guard, async (request) => {
    const input = validate(updateDestinationSchema, request.body, 'destination');
    return ctx.services.destinations.update(request.params.id, input, currentUser(request));
  });

  app.delete<{ Params: { id: string } }>('/api/v1/destinations/:id', guard, async (request) => {
    await ctx.services.destinations.remove(request.params.id, currentUser(request));
    return { ok: true };
  });

  /**
   * Reveals the HMAC signing secret so it can be copied into the downstream service.
   * Deliberately a POST: it is an action, and it must never end up in a browser history
   * entry or an access log as a GET query.
   */
  app.post<{ Params: { id: string } }>(
    '/api/v1/destinations/:id/reveal-secret',
    guard,
    async (request) => {
      const secret = await ctx.services.destinations.revealSecretForActor(
        request.params.id,
        currentUser(request),
      );
      request.log.info(
        { destinationId: request.params.id, userId: currentUser(request).id },
        'Destination signing secret revealed',
      );
      return { signingSecret: secret };
    },
  );
}
