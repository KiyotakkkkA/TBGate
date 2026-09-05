import { deliveriesQuerySchema, eventsQuerySchema } from '@tg-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { currentUser } from '../plugins/auth.js';
import { validate } from '../validate.js';

export async function registerEventRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = { preHandler: app.requireSession };
  const readGuard = { preHandler: app.requireAuth('events:read') };

  app.get('/api/v1/events', readGuard, async (request) => {
    const query = validate(eventsQuerySchema, request.query, 'query');
    return ctx.services.events.list(query, currentUser(request));
  });

  app.get<{ Params: { id: string } }>('/api/v1/events/:id', readGuard, async (request) =>
    ctx.services.events.get(request.params.id, currentUser(request)),
  );

  app.get<{ Params: { id: string } }>('/api/v1/events/:id/deliveries', guard, async (request) => {
    // Confirms access to the event before listing its deliveries.
    await ctx.services.events.get(request.params.id, currentUser(request));
    const query = validate(
      deliveriesQuerySchema,
      { ...(request.query as Record<string, unknown>), eventId: request.params.id },
      'query',
    );
    return ctx.services.deliveries.list(query, currentUser(request));
  });

  /**
   * Replays a stored event: re-runs route matching and queues fresh deliveries.
   * The original event and its delivery history are left untouched.
   */
  app.post<{ Params: { id: string } }>('/api/v1/events/:id/replay', guard, async (request) => {
    const actor = currentUser(request);
    const event = await ctx.services.events.get(request.params.id, actor);
    const bot = await ctx.services.bots.getRowForActor(event.botId, actor);
    const row = await ctx.services.events.getRow(event.id);

    const created = await ctx.services.events.enqueueDeliveries({
      eventId: row.id,
      bot,
      eventType: row.eventType,
      chatId: row.chatId,
      isTest: row.isTest,
      isReplay: true,
    });

    request.log.info({ eventId: row.id, deliveries: created }, 'Event replayed');
    return { ok: true, deliveries: created };
  });
}
