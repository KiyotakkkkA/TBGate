import { TELEGRAM_PROXY_DENYLIST, sendMessageSchema } from '@tg-gateway/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { ForbiddenError, ValidationError } from '../../lib/errors.js';
import { currentUser } from '../plugins/auth.js';
import { validate } from '../validate.js';

const objectBody = z.record(z.string(), z.unknown());

/**
 * Outbound Telegram API for downstream services.
 *
 * Callers authenticate with a gateway API key and address bots by their gateway id;
 * the Telegram bot token is decrypted server side for the duration of the call and is
 * never returned, logged, or otherwise exposed to the client.
 */
export async function registerGatewayApiRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const sendGuard = { preHandler: app.requireAuth('telegram:send') };

  async function tokenFor(request: Parameters<typeof currentUser>[0], botId: string) {
    const bot = await ctx.services.bots.getRowForActor(botId, currentUser(request));
    if (!bot.enabled) {
      throw new ForbiddenError('This bot is disabled; enable it before sending messages');
    }
    return { bot, token: ctx.services.bots.revealToken(bot) };
  }

  app.post<{ Params: { botId: string } }>(
    '/api/v1/bots/:botId/sendMessage',
    sendGuard,
    async (request) => {
      const payload = validate(sendMessageSchema, request.body, 'sendMessage payload');
      const { token } = await tokenFor(request, request.params.botId);
      const result = await ctx.telegram.sendMessage(token, payload);
      return { ok: true, result };
    },
  );

  const passthrough: Array<
    [
      string,
      'sendPhoto' | 'sendDocument' | 'editMessageText' | 'deleteMessage' | 'answerCallbackQuery',
    ]
  > = [
    ['sendPhoto', 'sendPhoto'],
    ['sendDocument', 'sendDocument'],
    ['editMessageText', 'editMessageText'],
    ['deleteMessage', 'deleteMessage'],
    ['answerCallbackQuery', 'answerCallbackQuery'],
  ];

  for (const [path, method] of passthrough) {
    app.post<{ Params: { botId: string } }>(
      `/api/v1/bots/:botId/${path}`,
      sendGuard,
      async (request) => {
        const payload = validate(objectBody, request.body ?? {}, `${path} payload`);
        const { token } = await tokenFor(request, request.params.botId);
        const result = await ctx.telegram[method](token, payload);
        return { ok: true, result };
      },
    );
  }

  /**
   * Generic proxy for Telegram methods the gateway does not model explicitly.
   * Webhook and getUpdates management are denied: those belong to the gateway itself,
   * and letting a client change them would break inbound routing.
   */
  app.post<{ Params: { botId: string; method: string } }>(
    '/api/v1/bots/:botId/telegram/:method',
    sendGuard,
    async (request) => {
      const method = request.params.method;
      if (!/^[a-zA-Z]{2,64}$/.test(method)) {
        throw new ValidationError('Invalid Telegram method name');
      }
      if (TELEGRAM_PROXY_DENYLIST.has(method.toLowerCase())) {
        throw new ForbiddenError(
          `Method "${method}" is managed by the gateway and cannot be called through the proxy`,
        );
      }
      const payload = validate(objectBody, request.body ?? {}, 'Telegram payload');
      const { token } = await tokenFor(request, request.params.botId);
      const result = await ctx.telegram.call(token, method, payload);
      return { ok: true, result };
    },
  );
}
