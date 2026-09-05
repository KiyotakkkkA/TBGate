import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { pingDatabase } from '../../db/client.js';

/**
 * `/health` reports process liveness only (cheap, safe for a Docker HEALTHCHECK).
 * `/ready` additionally verifies the database, so an orchestrator can hold traffic back
 * until the volume is mounted and migrations have completed.
 */
export async function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const summary = () => ({
    status: 'ok' as const,
    name: ctx.env.APP_NAME,
    version: ctx.version,
    uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
  });

  app.get('/health', { config: { rateLimit: false } }, async () => summary());
  app.get('/api/v1/health', { config: { rateLimit: false } }, async () => summary());

  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const database = await pingDatabase(ctx.client);
    const worker = ctx.worker ? ctx.worker.isRunning : true;
    const ready = database;
    reply.code(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not_ready',
      checks: { database, worker },
      version: ctx.version,
    };
  });
}
