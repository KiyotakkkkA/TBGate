import { deliveriesQuerySchema } from '@tg-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { currentUser } from '../plugins/auth.js';
import { validate } from '../validate.js';

export async function registerDeliveryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const readGuard = { preHandler: app.requireAuth('deliveries:read') };
  const retryGuard = { preHandler: app.requireAuth('deliveries:retry') };

  app.get('/api/v1/deliveries', readGuard, async (request) => {
    const query = validate(deliveriesQuerySchema, request.query, 'query');
    return ctx.services.deliveries.list(query, currentUser(request));
  });

  app.get<{ Params: { id: string } }>('/api/v1/deliveries/:id', readGuard, async (request) =>
    ctx.services.deliveries.get(request.params.id, currentUser(request)),
  );

  /** Queues a new delivery for the same event; the original record is preserved. */
  app.post<{ Params: { id: string } }>(
    '/api/v1/deliveries/:id/retry',
    retryGuard,
    async (request) => ctx.services.deliveries.replay(request.params.id, currentUser(request)),
  );
}
