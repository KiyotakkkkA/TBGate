import { createAppContext } from './app-context.js';
import { ConfigurationError, loadEnv } from './config/env.js';
import { buildServer } from './http/server.js';
import { createLogger } from './lib/logger.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      // Printed without any provided values, so secrets cannot leak through a boot failure.
      process.stderr.write(`${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const log = createLogger(env);
  const ctx = await createAppContext(env, { logger: log });

  const bootstrap = await ctx.services.users.bootstrapAdmin(env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
  if (bootstrap.created) {
    log.info(
      { username: env.ADMIN_USERNAME },
      'Administrator created from ADMIN_USERNAME/ADMIN_PASSWORD. Change the password after signing in.',
    );
  }

  // Non-destructive: reports a PUBLIC_BASE_URL change instead of silently re-registering.
  await ctx.services.bots.auditWebhooks().catch((error: unknown) => {
    log.warn({ err: error }, 'Webhook audit failed');
  });

  const app = await buildServer(ctx);

  if (ctx.worker) ctx.worker.start();
  ctx.cleanup.start();

  await app.listen({ host: env.HOST, port: env.PORT });
  log.info(
    { host: env.HOST, port: env.PORT, publicBaseUrl: env.PUBLIC_BASE_URL },
    `${env.APP_NAME} is ready`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down');

    const timer = setTimeout(() => {
      log.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 30_000);
    timer.unref();

    try {
      await app.close(); // stops accepting new requests, drains in-flight ones
      await ctx.close(); // stops the worker, releases leases, closes the database
      log.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal startup error: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
