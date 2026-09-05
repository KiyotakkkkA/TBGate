import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { safeEqual } from '../../lib/crypto.js';
import { NotFoundError, UnauthenticatedError } from '../../lib/errors.js';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Inbound Telegram webhook: `POST {TELEGRAM_WEBHOOK_PATH}/:botId`.
 *
 * The bot token never appears in the URL - the path carries an opaque gateway bot id and
 * the request is authenticated with the per-bot Telegram `secret_token`.
 *
 * The handler persists the update and enqueues deliveries, then acknowledges immediately.
 * Actual HTTP delivery happens in the background worker so Telegram is never kept waiting.
 */
export async function registerTelegramWebhookRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const path = `${ctx.env.TELEGRAM_WEBHOOK_PATH}/:botId`;

  app.post<{ Params: { botId: string } }>(path, {
    // Telegram bursts on backlog drain; the shared API limiter would reject legitimate traffic.
    config: { rateLimit: false },
    handler: async (request, reply) => {
      const { botId } = request.params;
      const bot = await ctx.services.bots.findEnabledById(botId);
      if (!bot) throw new NotFoundError('Bot');

      const presented = request.headers[SECRET_HEADER];
      const value = Array.isArray(presented) ? presented[0] : presented;
      const expected = ctx.services.bots.revealWebhookSecret(bot);
      if (!value || !safeEqual(value, expected)) {
        request.log.warn({ botId }, 'Rejected webhook with an invalid secret token');
        throw new UnauthenticatedError('Invalid Telegram secret token');
      }

      if (!bot.enabled) {
        // Acknowledge so Telegram stops retrying a bot the operator turned off.
        request.log.info({ botId }, 'Dropping update for a disabled bot');
        reply.code(200);
        return { ok: true, status: 'disabled' };
      }

      const result = await ctx.services.events.ingest(bot, request.body);
      void ctx.services.bots.markUpdateReceived(botId).catch(() => undefined);

      request.log.info(
        {
          botId,
          eventId: result.eventId,
          eventType: result.eventType,
          status: result.status,
          deliveries: result.deliveriesCreated,
        },
        'Telegram update accepted',
      );

      reply.code(200);
      return { ok: true, status: result.status, deliveries: result.deliveriesCreated };
    },
  });
}
