import { relations, sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
};

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'manager'] })
      .notNull()
      .default('manager'),
    status: text('status', { enum: ['active', 'blocked'] })
      .notNull()
      .default('active'),
    displayName: text('display_name'),
    /** Set when an admin resets a password, forcing a change on next login. */
    mustChangePassword: integer('must_change_password', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** The account bootstrapped from ADMIN_USERNAME; it can never be deleted or blocked. */
    isBootstrap: integer('is_bootstrap', { mode: 'boolean' }).notNull().default(false),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_username_unique').on(table.username)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Keyed digest of the cookie value; the raw session token is never stored. */
    tokenHash: text('token_hash').notNull(),
    csrfToken: text('csrf_token').notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

export const bots = sqliteTable(
  'bots',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    telegramBotId: text('telegram_bot_id'),
    telegramUsername: text('telegram_username'),
    /** AES-256-GCM sealed Telegram bot token. */
    encryptedToken: text('encrypted_token').notNull(),
    /** Masked display form, e.g. `123456789:******wXyZ`. */
    tokenHint: text('token_hint'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** AES-256-GCM sealed Telegram `secret_token` authenticating inbound webhooks. */
    encryptedWebhookSecret: text('encrypted_webhook_secret').notNull(),
    /** JSON array of Telegram update types; empty means "Telegram default set". */
    allowedUpdates: text('allowed_updates', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    webhookState: text('webhook_state', {
      enum: ['not_configured', 'active', 'mismatch', 'error', 'unknown'],
    })
      .notNull()
      .default('not_configured'),
    webhookUrl: text('webhook_url'),
    webhookLastError: text('webhook_last_error'),
    webhookLastSetAt: integer('webhook_last_set_at', { mode: 'timestamp_ms' }),
    lastUpdateAt: integer('last_update_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (table) => [
    index('bots_owner_idx').on(table.ownerId),
    index('bots_enabled_idx').on(table.enabled),
    uniqueIndex('bots_telegram_bot_id_unique').on(table.telegramBotId),
  ],
);

export const destinations = sqliteTable(
  'destinations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    url: text('url').notNull(),
    method: text('method').notNull().default('POST'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    timeoutMs: integer('timeout_ms'),
    headers: text('headers', { mode: 'json' }).$type<Record<string, string> | null>(),
    signingEnabled: integer('signing_enabled', { mode: 'boolean' }).notNull().default(true),
    /** AES-256-GCM sealed HMAC secret. */
    encryptedSigningSecret: text('encrypted_signing_secret'),
    signingSecretHint: text('signing_secret_hint'),
    ...timestamps,
  },
  (table) => [index('destinations_owner_idx').on(table.ownerId)],
);

export const routes = sqliteTable(
  'routes',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    destinationId: text('destination_id')
      .notNull()
      .references(() => destinations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** JSON array of update types; `*` matches every update. */
    updateTypes: text('update_types', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    priority: integer('priority').notNull().default(100),
    chatIdFilter: text('chat_id_filter'),
    ...timestamps,
  },
  (table) => [
    index('routes_bot_idx').on(table.botId),
    index('routes_destination_idx').on(table.destinationId),
  ],
);

export const telegramEvents = sqliteTable(
  'telegram_events',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    telegramUpdateId: integer('telegram_update_id'),
    eventType: text('event_type').notNull(),
    chatId: text('chat_id'),
    /** Raw Telegram Update JSON, stored verbatim. */
    payload: text('payload').notNull(),
    isTest: integer('is_test', { mode: 'boolean' }).notNull().default(false),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    // Idempotency: Telegram retries the same update_id; we accept it exactly once per bot.
    uniqueIndex('telegram_events_bot_update_unique').on(table.botId, table.telegramUpdateId),
    index('telegram_events_bot_received_idx').on(table.botId, table.receivedAt),
    index('telegram_events_type_idx').on(table.eventType),
    index('telegram_events_received_idx').on(table.receivedAt),
    index('telegram_events_chat_idx').on(table.chatId),
  ],
);

export const deliveries = sqliteTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => telegramEvents.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    routeId: text('route_id').references(() => routes.id, { onDelete: 'set null' }),
    destinationId: text('destination_id').references(() => destinations.id, {
      onDelete: 'set null',
    }),
    /** Snapshot of the target at enqueue time, so history survives destination edits. */
    destinationUrl: text('destination_url').notNull(),
    destinationMethod: text('destination_method').notNull().default('POST'),
    eventType: text('event_type').notNull(),
    status: text('status', {
      enum: ['pending', 'processing', 'success', 'failed', 'retrying'],
    })
      .notNull()
      .default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }).notNull().default(now),
    responseStatus: integer('response_status'),
    durationMs: integer('duration_ms'),
    lastError: text('last_error'),
    /** Optimistic worker lease; a stale lease is reclaimed after the lock timeout. */
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    lockedBy: text('locked_by'),
    isReplay: integer('is_replay', { mode: 'boolean' }).notNull().default(false),
    replayOfDeliveryId: text('replay_of_delivery_id'),
    isTest: integer('is_test', { mode: 'boolean' }).notNull().default(false),
    requestHeaders: text('request_headers', { mode: 'json' }).$type<Record<
      string,
      string
    > | null>(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (table) => [
    index('deliveries_queue_idx').on(table.status, table.nextAttemptAt),
    index('deliveries_event_idx').on(table.eventId),
    index('deliveries_bot_created_idx').on(table.botId, table.createdAt),
    index('deliveries_destination_idx').on(table.destinationId),
    index('deliveries_created_idx').on(table.createdAt),
  ],
);

export const deliveryAttempts = sqliteTable(
  'delivery_attempts',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().default(now),
    durationMs: integer('duration_ms'),
    responseStatus: integer('response_status'),
    /** Truncated to DELIVERY_MAX_RESPONSE_BODY_BYTES. */
    responseBody: text('response_body'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    succeeded: integer('succeeded', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [index('delivery_attempts_delivery_idx').on(table.deliveryId, table.attempt)],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Human-recognisable prefix shown in the UI, e.g. `tgw_ab12cd34`. */
    prefix: text('prefix').notNull(),
    /** Keyed digest of the full key; the plaintext key exists only at creation time. */
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('api_keys_token_hash_unique').on(table.tokenHash),
    index('api_keys_owner_idx').on(table.ownerId),
  ],
);

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

export const usersRelations = relations(users, ({ many }) => ({
  bots: many(bots),
  sessions: many(sessions),
  apiKeys: many(apiKeys),
}));

export const botsRelations = relations(bots, ({ one, many }) => ({
  owner: one(users, { fields: [bots.ownerId], references: [users.id] }),
  routes: many(routes),
  events: many(telegramEvents),
}));

export const routesRelations = relations(routes, ({ one }) => ({
  bot: one(bots, { fields: [routes.botId], references: [bots.id] }),
  destination: one(destinations, {
    fields: [routes.destinationId],
    references: [destinations.id],
  }),
}));

export const telegramEventsRelations = relations(telegramEvents, ({ one, many }) => ({
  bot: one(bots, { fields: [telegramEvents.botId], references: [bots.id] }),
  deliveries: many(deliveries),
}));

export const deliveriesRelations = relations(deliveries, ({ one, many }) => ({
  event: one(telegramEvents, { fields: [deliveries.eventId], references: [telegramEvents.id] }),
  bot: one(bots, { fields: [deliveries.botId], references: [bots.id] }),
  route: one(routes, { fields: [deliveries.routeId], references: [routes.id] }),
  destination: one(destinations, {
    fields: [deliveries.destinationId],
    references: [destinations.id],
  }),
  attempts: many(deliveryAttempts),
}));

export const deliveryAttemptsRelations = relations(deliveryAttempts, ({ one }) => ({
  delivery: one(deliveries, {
    fields: [deliveryAttempts.deliveryId],
    references: [deliveries.id],
  }),
}));

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type BotRow = typeof bots.$inferSelect;
export type DestinationRow = typeof destinations.$inferSelect;
export type RouteRow = typeof routes.$inferSelect;
export type TelegramEventRow = typeof telegramEvents.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
