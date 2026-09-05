import type { Client } from '@libsql/client';
import type { Env } from './config/env.js';
import { applyPragmas, createDatabase, type Database } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { hmacSha256Hex } from './lib/crypto.js';
import { createLogger, type Logger } from './lib/logger.js';
import { ApiKeyService } from './services/api-keys.js';
import { AuthService } from './services/auth.js';
import { BotService } from './services/bots.js';
import { DeliveryService } from './services/deliveries.js';
import { DestinationService } from './services/destinations.js';
import { EventService } from './services/events.js';
import { RouteService } from './services/routes.js';
import { StatsService } from './services/stats.js';
import { UserService } from './services/users.js';
import { TelegramClient } from './telegram/client.js';
import { CleanupJob } from './worker/cleanup.js';
import { DeliveryWorker } from './worker/delivery-worker.js';

export const APP_VERSION = process.env.APP_VERSION ?? '1.0.0';

export interface AppServices {
  users: UserService;
  auth: AuthService;
  apiKeys: ApiKeyService;
  bots: BotService;
  destinations: DestinationService;
  routes: RouteService;
  events: EventService;
  deliveries: DeliveryService;
  stats: StatsService;
}

export interface AppContext {
  env: Env;
  log: Logger;
  db: Database;
  client: Client;
  telegram: TelegramClient;
  services: AppServices;
  worker: DeliveryWorker | null;
  cleanup: CleanupJob;
  startedAt: number;
  version: string;
  close: () => Promise<void>;
}

export interface CreateContextOptions {
  /** Injected in tests so the suite never reaches the real Telegram API or the network. */
  telegramFetch?: typeof fetch;
  deliveryFetch?: typeof fetch;
  logger?: Logger;
  runMigrations?: boolean;
  startWorker?: boolean;
}

/**
 * Wires the object graph. Everything is constructed explicitly - no DI container - so the
 * dependency direction stays obvious and tests can substitute individual pieces.
 */
export async function createAppContext(
  env: Env,
  options: CreateContextOptions = {},
): Promise<AppContext> {
  const log = options.logger ?? createLogger(env);
  const startedAt = Date.now();

  const handle = createDatabase(env.DATABASE_URL);
  await applyPragmas(handle.client);

  if (options.runMigrations !== false) {
    await runMigrations(handle.db, handle.client, log);
  }

  const telegram = new TelegramClient({
    apiBaseUrl: env.TELEGRAM_API_BASE_URL,
    timeoutMs: env.TELEGRAM_API_TIMEOUT_MS,
    ...(options.telegramFetch ? { fetchImpl: options.telegramFetch } : {}),
  });

  const users = new UserService(handle.db, log);
  const auth = new AuthService(handle.db, users, env.SESSION_SECRET, env.SESSION_TTL_HOURS, log);
  // API keys are peppered with a value derived from - but not equal to - the master key.
  const apiKeyPepper = hmacSha256Hex(env.APP_ENCRYPTION_KEY.toString('hex'), 'api-key-pepper/v1');
  const apiKeys = new ApiKeyService(handle.db, apiKeyPepper, log);

  const bots = new BotService(
    handle.db,
    telegram,
    {
      publicBaseUrl: env.PUBLIC_BASE_URL,
      webhookPath: env.TELEGRAM_WEBHOOK_PATH,
      dropPendingUpdates: env.TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES,
      encryptionKey: env.APP_ENCRYPTION_KEY,
    },
    log,
  );

  const ssrf = { allowPrivateNetworks: env.DESTINATION_ALLOW_PRIVATE_NETWORKS };
  const destinations = new DestinationService(
    handle.db,
    { encryptionKey: env.APP_ENCRYPTION_KEY, ssrf },
    log,
  );
  const routes = new RouteService(handle.db, bots, destinations, log);
  const events = new EventService(
    handle.db,
    routes,
    { maxAttempts: env.DELIVERY_MAX_ATTEMPTS },
    log,
  );
  const deliveries = new DeliveryService(handle.db, log);
  const stats = new StatsService(handle.db, handle.client, deliveries, {
    publicBaseUrl: env.PUBLIC_BASE_URL,
    version: APP_VERSION,
    startedAt,
  });

  const workerEnabled = options.startWorker ?? env.DELIVERY_WORKER_ENABLED;
  const worker = workerEnabled
    ? new DeliveryWorker(
        handle.db,
        deliveries,
        destinations,
        {
          concurrency: env.DELIVERY_WORKER_CONCURRENCY,
          pollIntervalMs: env.DELIVERY_WORKER_POLL_INTERVAL_MS,
          defaultTimeoutMs: env.DELIVERY_TIMEOUT_MS,
          maxResponseBodyBytes: env.DELIVERY_MAX_RESPONSE_BODY_BYTES,
          retry: {
            maxAttempts: env.DELIVERY_MAX_ATTEMPTS,
            delaysMs: env.DELIVERY_RETRY_DELAYS_MS,
          },
          ssrf,
          userAgent: `TelegramGateway/${APP_VERSION}`,
        },
        log,
        options.deliveryFetch ?? fetch,
      )
    : null;

  const cleanup = new CleanupJob(
    events,
    deliveries,
    auth,
    {
      eventRetentionDays: env.EVENT_RETENTION_DAYS,
      deliveryRetentionDays: env.DELIVERY_RETENTION_DAYS,
      intervalHours: env.CLEANUP_INTERVAL_HOURS,
    },
    log,
  );

  return {
    env,
    log,
    db: handle.db,
    client: handle.client,
    telegram,
    services: { users, auth, apiKeys, bots, destinations, routes, events, deliveries, stats },
    worker,
    cleanup,
    startedAt,
    version: APP_VERSION,
    close: async () => {
      cleanup.stop();
      if (worker) await worker.stop();
      handle.close();
    },
  };
}
