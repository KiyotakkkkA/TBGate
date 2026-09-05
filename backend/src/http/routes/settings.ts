import type { SettingsDto } from '@tg-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { resolveSqlitePath } from '../../db/client.js';
import { currentUser } from '../plugins/auth.js';

/**
 * Runtime information for the Settings page. Only non-sensitive configuration is exposed:
 * no secrets, no tokens, no database credentials.
 */
export async function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v1/settings',
    { preHandler: app.requireSession },
    async (): Promise<SettingsDto> => {
      const path = resolveSqlitePath(ctx.env.DATABASE_URL);
      return {
        appName: ctx.env.APP_NAME,
        version: ctx.version,
        nodeEnv: ctx.env.NODE_ENV,
        publicBaseUrl: ctx.env.PUBLIC_BASE_URL,
        webhookPath: ctx.env.TELEGRAM_WEBHOOK_PATH,
        trustProxy: ctx.env.TRUST_PROXY,
        telegramApiBaseUrl: ctx.env.TELEGRAM_API_BASE_URL,
        database: { driver: 'sqlite (libsql)', path: path ?? ctx.env.DATABASE_URL },
        worker: {
          enabled: ctx.worker !== null,
          concurrency: ctx.env.DELIVERY_WORKER_CONCURRENCY,
          timeoutMs: ctx.env.DELIVERY_TIMEOUT_MS,
          maxAttempts: ctx.env.DELIVERY_MAX_ATTEMPTS,
          retryDelaysMs: ctx.env.DELIVERY_RETRY_DELAYS_MS,
        },
        retention: {
          eventDays: ctx.env.EVENT_RETENTION_DAYS,
          deliveryDays: ctx.env.DELIVERY_RETENTION_DAYS,
          cleanupIntervalHours: ctx.env.CLEANUP_INTERVAL_HOURS,
        },
        security: {
          cookieSecure: ctx.env.COOKIE_SECURE,
          cookieSameSite: ctx.env.COOKIE_SAME_SITE,
          sessionTtlHours: ctx.env.SESSION_TTL_HOURS,
          allowPrivateDestinations: ctx.env.DESTINATION_ALLOW_PRIVATE_NETWORKS,
          rateLimitEnabled: ctx.env.API_RATE_LIMIT_ENABLED,
        },
        uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
      };
    },
  );

  app.get('/api/v1/dashboard', { preHandler: app.requireSession }, async (request) =>
    ctx.services.stats.dashboard(currentUser(request), ctx.worker?.isRunning ?? false),
  );

  app.post('/api/v1/settings/cleanup', { preHandler: app.requireAdmin }, async () =>
    ctx.cleanup.runOnce(),
  );
}
