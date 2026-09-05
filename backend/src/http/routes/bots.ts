import {
  createBotSchema,
  createRouteSchema,
  updateBotSchema,
  updateRouteSchema,
} from '@tg-gateway/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { buildSampleUpdate } from '../../telegram/sample.js';
import { currentUser } from '../plugins/auth.js';
import { validate } from '../validate.js';

const testEventSchema = z.object({
  eventType: z.string().trim().min(1).max(64).default('message'),
});

export async function registerBotRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = { preHandler: app.requireSession };
  // Read endpoints also accept a gateway API key holding the matching scope.
  const readGuard = { preHandler: app.requireAuth('bots:read') };

  app.get('/api/v1/bots', readGuard, async (request) =>
    ctx.services.bots.list(currentUser(request)),
  );

  app.post('/api/v1/bots', guard, async (request, reply) => {
    const input = validate(createBotSchema, request.body, 'bot');
    const bot = await ctx.services.bots.create(input, currentUser(request));
    reply.code(201);
    return bot;
  });

  app.get<{ Params: { botId: string } }>('/api/v1/bots/:botId', readGuard, async (request) =>
    ctx.services.bots.get(request.params.botId, currentUser(request)),
  );

  app.patch<{ Params: { botId: string } }>('/api/v1/bots/:botId', guard, async (request) => {
    const input = validate(updateBotSchema, request.body, 'bot');
    return ctx.services.bots.update(request.params.botId, input, currentUser(request));
  });

  app.delete<{ Params: { botId: string } }>('/api/v1/bots/:botId', guard, async (request) => {
    await ctx.services.bots.remove(request.params.botId, currentUser(request));
    return { ok: true };
  });

  /* ------------------------------------------------------------ telegram */

  app.post<{ Params: { botId: string } }>(
    '/api/v1/bots/:botId/telegram/test',
    guard,
    async (request) => ctx.services.bots.testConnection(request.params.botId, currentUser(request)),
  );

  app.get<{ Params: { botId: string } }>('/api/v1/bots/:botId/webhook', guard, async (request) =>
    ctx.services.bots.getWebhookInfo(request.params.botId, currentUser(request)),
  );

  app.post<{ Params: { botId: string } }>('/api/v1/bots/:botId/webhook', guard, async (request) => {
    // Ownership is enforced before the privileged registration call.
    await ctx.services.bots.getRowForActor(request.params.botId, currentUser(request));
    return ctx.services.bots.registerWebhook(request.params.botId);
  });

  app.delete<{ Params: { botId: string } }>(
    '/api/v1/bots/:botId/webhook',
    guard,
    async (request) => {
      await ctx.services.bots.getRowForActor(request.params.botId, currentUser(request));
      await ctx.services.bots.deleteWebhook(request.params.botId);
      return { ok: true };
    },
  );

  /* -------------------------------------------------------------- routes */

  app.get<{ Params: { botId: string } }>('/api/v1/bots/:botId/routes', guard, async (request) =>
    ctx.services.routes.listForBot(request.params.botId, currentUser(request)),
  );

  app.post<{ Params: { botId: string } }>(
    '/api/v1/bots/:botId/routes',
    guard,
    async (request, reply) => {
      const input = validate(createRouteSchema, request.body, 'route');
      const route = await ctx.services.routes.create(
        request.params.botId,
        input,
        currentUser(request),
      );
      reply.code(201);
      return route;
    },
  );

  app.patch<{ Params: { routeId: string } }>('/api/v1/routes/:routeId', guard, async (request) => {
    const input = validate(updateRouteSchema, request.body, 'route');
    return ctx.services.routes.update(request.params.routeId, input, currentUser(request));
  });

  app.delete<{ Params: { routeId: string } }>('/api/v1/routes/:routeId', guard, async (request) => {
    await ctx.services.routes.remove(request.params.routeId, currentUser(request));
    return { ok: true };
  });

  /**
   * Sends a clearly-marked synthetic event through a single route, so an operator can
   * verify the downstream service without waiting for real Telegram traffic.
   */
  app.post<{ Params: { routeId: string } }>(
    '/api/v1/routes/:routeId/test',
    guard,
    async (request) => {
      const actor = currentUser(request);
      const route = await ctx.services.routes.get(request.params.routeId, actor);
      const input = validate(testEventSchema, request.body ?? {}, 'test event');

      const eventType =
        route.updateTypes.includes(input.eventType) || route.updateTypes.includes('*')
          ? input.eventType
          : (route.updateTypes[0] ?? 'message');

      const bot = await ctx.services.bots.getRowForActor(route.botId, actor);
      const update = buildSampleUpdate(eventType, bot.name);
      // Restrict the fan-out to the route under test.
      const result = await ctx.services.events.ingest(bot, update, {
        isTest: true,
        onlyRouteId: route.id,
      });

      if (result.eventId) {
        return {
          ok: true,
          eventId: result.eventId,
          eventType: result.eventType,
          deliveries: result.deliveriesCreated,
        };
      }
      return { ok: false, eventId: null, eventType, deliveries: 0 };
    },
  );
}
