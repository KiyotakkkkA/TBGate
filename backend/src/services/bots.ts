import type {
  BotDto,
  CreateBotInput,
  UpdateBotInput,
  WebhookInfoDto,
  WebhookState,
} from '@tg-gateway/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { bots, routes, telegramEvents, users, type BotRow, type UserRow } from '../db/schema.js';
import { decryptSecret, encryptSecret, maskBotToken, randomToken } from '../lib/crypto.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { newBotId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { TelegramClient } from '../telegram/client.js';

export interface BotServiceConfig {
  publicBaseUrl: string;
  webhookPath: string;
  dropPendingUpdates: boolean;
  encryptionKey: Buffer;
}

/** Telegram's `secret_token` allows A-Z a-z 0-9 _ - only, 1..256 characters. */
function generateWebhookSecret(): string {
  return randomToken(32).replace(/[^A-Za-z0-9_-]/g, '');
}

export class BotService {
  constructor(
    private readonly db: Database,
    private readonly telegram: TelegramClient,
    private readonly config: BotServiceConfig,
    private readonly log: Logger,
  ) {}

  webhookUrlFor(botId: string): string {
    const base = this.config.publicBaseUrl.replace(/\/+$/, '');
    return `${base}${this.config.webhookPath}/${botId}`;
  }

  /** Decrypts a bot token. Called only immediately before a Telegram API request. */
  revealToken(row: BotRow): string {
    return decryptSecret(row.encryptedToken, this.config.encryptionKey);
  }

  revealWebhookSecret(row: BotRow): string {
    return decryptSecret(row.encryptedWebhookSecret, this.config.encryptionKey);
  }

  toDto(
    row: BotRow,
    extra: { ownerUsername: string | null; routeCount: number; eventCount: number },
  ): BotDto {
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      ownerId: row.ownerId,
      ownerUsername: extra.ownerUsername,
      telegramBotId: row.telegramBotId,
      telegramUsername: row.telegramUsername,
      tokenHint: row.tokenHint,
      tokenConfigured: row.encryptedToken.length > 0,
      allowedUpdates: row.allowedUpdates,
      webhookUrl: this.webhookUrlFor(row.id),
      webhookState: row.webhookState,
      webhookLastError: row.webhookLastError,
      webhookLastSetAt: row.webhookLastSetAt ? row.webhookLastSetAt.toISOString() : null,
      routeCount: extra.routeCount,
      eventCount: extra.eventCount,
      lastUpdateAt: row.lastUpdateAt ? row.lastUpdateAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private assertAccess(row: BotRow, actor: UserRow): void {
    if (actor.role === 'admin') return;
    if (row.ownerId !== actor.id) {
      throw new ForbiddenError('You do not have access to this bot');
    }
  }

  async getRow(id: string): Promise<BotRow> {
    const rows = await this.db.select().from(bots).where(eq(bots.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('Bot');
    return row;
  }

  async getRowForActor(id: string, actor: UserRow): Promise<BotRow> {
    const row = await this.getRow(id);
    this.assertAccess(row, actor);
    return row;
  }

  /** Used by the inbound webhook path, where there is no admin actor. */
  async findEnabledById(id: string): Promise<BotRow | null> {
    const rows = await this.db.select().from(bots).where(eq(bots.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async list(actor: UserRow): Promise<BotDto[]> {
    const rows = await this.db
      .select({
        bot: bots,
        ownerUsername: users.username,
        routeCount: sql<number>`(SELECT COUNT(*) FROM ${routes} WHERE ${routes.botId} = ${bots.id})`,
        eventCount: sql<number>`(SELECT COUNT(*) FROM ${telegramEvents} WHERE ${telegramEvents.botId} = ${bots.id})`,
      })
      .from(bots)
      .leftJoin(users, eq(users.id, bots.ownerId))
      .orderBy(desc(bots.createdAt));

    return rows
      .filter((row) => actor.role === 'admin' || row.bot.ownerId === actor.id)
      .map((row) =>
        this.toDto(row.bot, {
          ownerUsername: row.ownerUsername,
          routeCount: Number(row.routeCount),
          eventCount: Number(row.eventCount),
        }),
      );
  }

  async get(id: string, actor: UserRow): Promise<BotDto> {
    const row = await this.getRowForActor(id, actor);
    const [counts] = await this.db
      .select({
        ownerUsername: users.username,
        routeCount: sql<number>`(SELECT COUNT(*) FROM ${routes} WHERE ${routes.botId} = ${bots.id})`,
        eventCount: sql<number>`(SELECT COUNT(*) FROM ${telegramEvents} WHERE ${telegramEvents.botId} = ${bots.id})`,
      })
      .from(bots)
      .leftJoin(users, eq(users.id, bots.ownerId))
      .where(eq(bots.id, id));

    return this.toDto(row, {
      ownerUsername: counts?.ownerUsername ?? null,
      routeCount: Number(counts?.routeCount ?? 0),
      eventCount: Number(counts?.eventCount ?? 0),
    });
  }

  async create(input: CreateBotInput, actor: UserRow): Promise<BotDto> {
    const identity = await this.telegram.getMe(input.token).catch((error) => {
      if (error instanceof AppError && error.code === 'TELEGRAM_API_ERROR') {
        throw new AppError(
          'TELEGRAM_TOKEN_INVALID',
          'Telegram rejected this bot token. Check that it was copied correctly from @BotFather.',
          400,
        );
      }
      throw error;
    });

    const telegramBotId = String(identity.id);
    const existing = await this.db
      .select({ id: bots.id })
      .from(bots)
      .where(eq(bots.telegramBotId, telegramBotId))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictError(`Bot @${identity.username ?? telegramBotId} is already registered`);
    }

    const id = newBotId();
    const row: typeof bots.$inferInsert = {
      id,
      name: input.name,
      ownerId: actor.id,
      telegramBotId,
      telegramUsername: identity.username ?? null,
      encryptedToken: encryptSecret(input.token, this.config.encryptionKey),
      tokenHint: maskBotToken(input.token),
      enabled: input.enabled,
      encryptedWebhookSecret: encryptSecret(generateWebhookSecret(), this.config.encryptionKey),
      allowedUpdates: input.allowedUpdates,
      webhookState: 'not_configured',
      webhookUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const [created] = await this.db.insert(bots).values(row).returning();
    if (!created) throw new Error('Failed to create bot');

    this.log.info(
      { botId: id, telegramBotId, telegramUsername: identity.username },
      'Bot registered',
    );

    if (created.enabled) {
      await this.registerWebhook(created.id).catch((error: unknown) => {
        this.log.warn({ botId: id, err: error }, 'Initial webhook registration failed');
      });
    }

    return this.get(id, actor);
  }

  async update(id: string, input: UpdateBotInput, actor: UserRow): Promise<BotDto> {
    const row = await this.getRowForActor(id, actor);
    const patch: Partial<typeof bots.$inferInsert> = { updatedAt: new Date() };
    let webhookNeedsRefresh = false;

    if (input.name !== undefined) patch.name = input.name;

    if (input.token !== undefined) {
      const identity = await this.telegram.getMe(input.token).catch(() => {
        throw new AppError('TELEGRAM_TOKEN_INVALID', 'Telegram rejected this bot token', 400);
      });
      if (row.telegramBotId && String(identity.id) !== row.telegramBotId) {
        throw new ConflictError(
          'This token belongs to a different Telegram bot. Create a new bot entry instead.',
        );
      }
      patch.encryptedToken = encryptSecret(input.token, this.config.encryptionKey);
      patch.tokenHint = maskBotToken(input.token);
      patch.telegramUsername = identity.username ?? null;
      patch.telegramBotId = String(identity.id);
      webhookNeedsRefresh = true;
    }

    if (input.allowedUpdates !== undefined) {
      patch.allowedUpdates = input.allowedUpdates;
      webhookNeedsRefresh = true;
    }

    if (input.ownerId !== undefined) {
      if (actor.role !== 'admin') {
        throw new ForbiddenError('Only an administrator can reassign bot ownership');
      }
      patch.ownerId = input.ownerId;
    }

    if (input.enabled !== undefined) patch.enabled = input.enabled;

    await this.db.update(bots).set(patch).where(eq(bots.id, id));

    if (input.enabled === false) {
      await this.deleteWebhook(id).catch((error: unknown) => {
        this.log.warn({ botId: id, err: error }, 'Could not remove webhook while disabling bot');
      });
    } else if (input.enabled === true || webhookNeedsRefresh) {
      const current = await this.getRow(id);
      if (current.enabled) {
        await this.registerWebhook(id).catch((error: unknown) => {
          this.log.warn({ botId: id, err: error }, 'Webhook refresh after update failed');
        });
      }
    }

    return this.get(id, actor);
  }

  async remove(id: string, actor: UserRow): Promise<void> {
    const row = await this.getRowForActor(id, actor);
    // Best effort: stop Telegram from delivering to a bot we are about to forget.
    await this.deleteWebhook(id).catch(() => undefined);
    await this.db.delete(bots).where(eq(bots.id, row.id));
    this.log.info({ botId: id }, 'Bot deleted');
  }

  async testConnection(
    id: string,
    actor: UserRow,
  ): Promise<{ id: number; username: string | null; firstName: string }> {
    const row = await this.getRowForActor(id, actor);
    const identity = await this.telegram.getMe(this.revealToken(row));
    await this.db
      .update(bots)
      .set({
        telegramUsername: identity.username ?? null,
        telegramBotId: String(identity.id),
        updatedAt: new Date(),
      })
      .where(eq(bots.id, id));
    return {
      id: identity.id,
      username: identity.username ?? null,
      firstName: identity.first_name,
    };
  }

  async registerWebhook(id: string): Promise<{ url: string }> {
    const row = await this.getRow(id);
    const url = this.webhookUrlFor(id);
    try {
      await this.telegram.setWebhook(this.revealToken(row), {
        url,
        secretToken: this.revealWebhookSecret(row),
        allowedUpdates: row.allowedUpdates,
        dropPendingUpdates: this.config.dropPendingUpdates,
      });
      await this.db
        .update(bots)
        .set({
          webhookState: 'active',
          webhookUrl: url,
          webhookLastError: null,
          webhookLastSetAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bots.id, id));
      this.log.info({ botId: id, url }, 'Telegram webhook registered');
      return { url };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.db
        .update(bots)
        .set({ webhookState: 'error', webhookLastError: message, updatedAt: new Date() })
        .where(eq(bots.id, id));
      throw error;
    }
  }

  async deleteWebhook(id: string): Promise<void> {
    const row = await this.getRow(id);
    await this.telegram.deleteWebhook(this.revealToken(row), false);
    await this.db
      .update(bots)
      .set({
        webhookState: 'not_configured',
        webhookUrl: null,
        webhookLastError: null,
        updatedAt: new Date(),
      })
      .where(eq(bots.id, id));
    this.log.info({ botId: id }, 'Telegram webhook deleted');
  }

  async getWebhookInfo(id: string, actor: UserRow): Promise<WebhookInfoDto> {
    const row = await this.getRowForActor(id, actor);
    const info = await this.telegram.getWebhookInfo(this.revealToken(row));
    const expectedUrl = this.webhookUrlFor(id);

    let state: WebhookState;
    if (!info.url) state = 'not_configured';
    else if (info.url !== expectedUrl) state = 'mismatch';
    else if (info.last_error_message) state = 'error';
    else state = 'active';

    await this.db
      .update(bots)
      .set({
        webhookState: state,
        webhookUrl: info.url || null,
        webhookLastError: info.last_error_message ?? null,
        updatedAt: new Date(),
      })
      .where(eq(bots.id, id));

    return {
      url: info.url,
      expectedUrl,
      hasCustomCertificate: info.has_custom_certificate,
      pendingUpdateCount: info.pending_update_count,
      ipAddress: info.ip_address,
      lastErrorDate: info.last_error_date,
      lastErrorMessage: info.last_error_message,
      maxConnections: info.max_connections,
      allowedUpdates: info.allowed_updates,
      state,
    };
  }

  /**
   * Non-destructive startup audit. If PUBLIC_BASE_URL changed, the mismatch is reported
   * and surfaced in the UI; re-registration stays an explicit admin action.
   */
  async auditWebhooks(): Promise<void> {
    const rows = await this.db.select().from(bots).where(eq(bots.enabled, true));
    for (const row of rows) {
      const expected = this.webhookUrlFor(row.id);
      if (row.webhookState === 'active' && row.webhookUrl && row.webhookUrl !== expected) {
        await this.db
          .update(bots)
          .set({
            webhookState: 'mismatch',
            webhookLastError: `Registered webhook URL (${row.webhookUrl}) does not match PUBLIC_BASE_URL (${expected}). Re-register the webhook to fix this.`,
          })
          .where(eq(bots.id, row.id));
        this.log.warn(
          { botId: row.id, registered: row.webhookUrl, expected },
          'Webhook URL mismatch detected; not changing it automatically',
        );
      }
    }
  }

  async markUpdateReceived(id: string): Promise<void> {
    await this.db.update(bots).set({ lastUpdateAt: new Date() }).where(eq(bots.id, id));
  }
}
