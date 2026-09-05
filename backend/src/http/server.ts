import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AppContext } from '../app-context.js';
import { newRequestId } from '../lib/ids.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBotRoutes } from './routes/bots.js';
import { registerDeliveryRoutes } from './routes/deliveries.js';
import { registerDestinationRoutes } from './routes/destinations.js';
import { registerEventRoutes } from './routes/events.js';
import { registerGatewayApiRoutes } from './routes/gateway-api.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTelegramWebhookRoutes } from './routes/telegram-webhook.js';
import { registerUserRoutes } from './routes/users.js';

/** Locates the built admin SPA. Set STATIC_DIR to override. */
export function resolveStaticDir(configured: string): string | null {
  if (configured) {
    const absolute = resolve(process.cwd(), configured);
    return existsSync(resolve(absolute, 'index.html')) ? absolute : null;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../public'), // dist/index.js -> backend/public (Docker image layout)
    resolve(here, '../../public'),
    resolve(process.cwd(), 'public'),
    resolve(process.cwd(), '../frontend/dist'), // running from backend/ in development
    resolve(process.cwd(), 'frontend/dist'),
  ];
  return candidates.find((candidate) => existsSync(resolve(candidate, 'index.html'))) ?? null;
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  // Widened to FastifyBaseLogger so the instance keeps Fastify's default generics and
  // route modules can be typed against a plain FastifyInstance.
  const logger: FastifyBaseLogger = ctx.log;

  const app = Fastify({
    loggerInstance: logger,
    trustProxy: ctx.env.TRUST_PROXY,
    bodyLimit: ctx.env.MAX_REQUEST_BODY_BYTES,
    genReqId: () => newRequestId(),
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(errorHandlerPlugin);
  await app.register(cookie, { secret: ctx.env.SESSION_SECRET });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React and Tailwind set element styles at runtime; scripts stay strictly self-hosted.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(ctx.env.COOKIE_SECURE ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: ctx.env.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
  });

  if (ctx.env.API_RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, {
      global: true,
      max: ctx.env.API_RATE_LIMIT_MAX,
      timeWindow: ctx.env.API_RATE_LIMIT_WINDOW_MS,
      keyGenerator: (request) => {
        const header = request.headers.authorization ?? request.headers['x-api-key'];
        if (typeof header === 'string' && header.length > 0) return `key:${header.slice(-16)}`;
        return `ip:${request.ip}`;
      },
    });
  }

  await app.register(authPlugin, { ctx });

  // Correlation id on every response, so a UI error can be traced in the logs.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await registerHealthRoutes(app, ctx);
  await registerTelegramWebhookRoutes(app, ctx);
  await registerAuthRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerBotRoutes(app, ctx);
  await registerDestinationRoutes(app, ctx);
  await registerEventRoutes(app, ctx);
  await registerDeliveryRoutes(app, ctx);
  await registerApiKeyRoutes(app, ctx);
  await registerSettingsRoutes(app, ctx);
  await registerGatewayApiRoutes(app, ctx);

  const staticDir = resolveStaticDir(ctx.env.STATIC_DIR);
  if (staticDir) {
    ctx.log.info({ staticDir }, 'Serving admin panel from the API process');
    await app.register(fastifyStatic, { root: staticDir, wildcard: false, index: ['index.html'] });
  } else {
    ctx.log.warn(
      'Admin panel assets were not found; the API is running headless (run `pnpm --filter ./frontend build`)',
    );
  }

  // Fastify allows exactly one not-found handler per prefix. API-shaped paths always get a
  // JSON error; everything else falls through to the SPA so client-side routing works on reload.
  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? '/';
    const isApiPath =
      url.startsWith('/api/') ||
      url.startsWith(ctx.env.TELEGRAM_WEBHOOK_PATH) ||
      url === '/health' ||
      url === '/ready';

    if (staticDir && request.method === 'GET' && !isApiPath) {
      reply.type('text/html').sendFile('index.html');
      return;
    }

    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${url} not found`,
        requestId: request.id,
      },
    });
  });

  return app;
}
