import type { EventDetailDto, EventDto, EventsQuery, Paginated } from '@tg-gateway/shared';
import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  bots,
  deliveries,
  destinations,
  telegramEvents,
  type BotRow,
  type TelegramEventRow,
  type UserRow,
} from '../db/schema.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { newDeliveryId, newEventId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { matchRoutes } from '../router/match.js';
import { classifyUpdate } from '../telegram/classifier.js';
import type { RouteService } from './routes.js';

export interface IngestResult {
  status: 'accepted' | 'duplicate' | 'no_routes';
  eventId: string | null;
  eventType: string;
  deliveriesCreated: number;
}

export interface EventServiceConfig {
  maxAttempts: number;
}

export class EventService {
  constructor(
    private readonly db: Database,
    private readonly routeService: RouteService,
    private readonly config: EventServiceConfig,
    private readonly log: Logger,
  ) {}

  /**
   * Persists an inbound Telegram update and enqueues one delivery per matching route.
   * Idempotent per (botId, update_id): a Telegram retry is acknowledged without
   * producing duplicate deliveries.
   */
  async ingest(
    bot: BotRow,
    update: unknown,
    options: { isTest?: boolean; onlyRouteId?: string } = {},
  ): Promise<IngestResult> {
    const classified = classifyUpdate(update);
    if (classified.isUnknownType) {
      this.log.info(
        { botId: bot.id, updateId: classified.updateId },
        'Received an update type this build does not know; storing it as "unknown"',
      );
    }

    const eventId = newEventId();
    const inserted = await this.db
      .insert(telegramEvents)
      .values({
        id: eventId,
        botId: bot.id,
        telegramUpdateId: classified.updateId,
        eventType: classified.eventType,
        chatId: classified.chatId,
        payload: JSON.stringify(update),
        isTest: options.isTest ?? false,
        receivedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: telegramEvents.id });

    if (inserted.length === 0) {
      this.log.debug(
        { botId: bot.id, updateId: classified.updateId },
        'Duplicate Telegram update ignored',
      );
      return {
        status: 'duplicate',
        eventId: null,
        eventType: classified.eventType,
        deliveriesCreated: 0,
      };
    }

    const created = await this.enqueueDeliveries({
      eventId,
      bot,
      eventType: classified.eventType,
      chatId: classified.chatId,
      isTest: options.isTest ?? false,
      ...(options.onlyRouteId ? { onlyRouteId: options.onlyRouteId } : {}),
    });

    return {
      status: created > 0 ? 'accepted' : 'no_routes',
      eventId,
      eventType: classified.eventType,
      deliveriesCreated: created,
    };
  }

  async enqueueDeliveries(input: {
    eventId: string;
    bot: BotRow;
    eventType: string;
    chatId: string | null;
    isTest: boolean;
    isReplay?: boolean;
    replayOfDeliveryId?: string | null;
    onlyRouteId?: string;
  }): Promise<number> {
    const candidates = await this.routeService.listMatchableForBot(input.bot.id);
    const filtered = input.onlyRouteId
      ? candidates.filter((route) => route.id === input.onlyRouteId)
      : candidates;
    const matched = matchRoutes(filtered, {
      eventType: input.eventType,
      chatId: input.chatId,
    });

    if (matched.length === 0) return 0;

    const destinationRows = await this.db
      .select()
      .from(destinations)
      .where(
        inArray(
          destinations.id,
          matched.map((route) => route.destinationId),
        ),
      );
    const destinationById = new Map(destinationRows.map((row) => [row.id, row]));

    const values: (typeof deliveries.$inferInsert)[] = [];
    for (const route of matched) {
      const destination = destinationById.get(route.destinationId);
      if (!destination) continue;
      values.push({
        id: newDeliveryId(),
        eventId: input.eventId,
        botId: input.bot.id,
        routeId: route.id,
        destinationId: destination.id,
        destinationUrl: destination.url,
        destinationMethod: destination.method,
        eventType: input.eventType,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: this.config.maxAttempts,
        nextAttemptAt: new Date(),
        isReplay: input.isReplay ?? false,
        replayOfDeliveryId: input.replayOfDeliveryId ?? null,
        isTest: input.isTest,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    if (values.length === 0) return 0;
    await this.db.insert(deliveries).values(values);
    this.log.debug(
      { eventId: input.eventId, botId: input.bot.id, count: values.length },
      'Deliveries enqueued',
    );
    return values.length;
  }

  private async accessibleBotIds(actor: UserRow): Promise<string[] | null> {
    if (actor.role === 'admin') return null;
    const rows = await this.db.select({ id: bots.id }).from(bots).where(eq(bots.ownerId, actor.id));
    return rows.map((row) => row.id);
  }

  async list(query: EventsQuery, actor: UserRow): Promise<Paginated<EventDto>> {
    const conditions: SQL[] = [];
    const scope = await this.accessibleBotIds(actor);
    if (scope !== null) {
      if (scope.length === 0) {
        return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
      }
      conditions.push(inArray(telegramEvents.botId, scope));
    }
    if (query.botId) conditions.push(eq(telegramEvents.botId, query.botId));
    if (query.eventType) conditions.push(eq(telegramEvents.eventType, query.eventType));
    if (query.updateId !== undefined) {
      conditions.push(eq(telegramEvents.telegramUpdateId, query.updateId));
    }
    if (query.chatId) conditions.push(eq(telegramEvents.chatId, query.chatId));
    if (query.from) conditions.push(gte(telegramEvents.receivedAt, new Date(query.from)));
    if (query.to) conditions.push(lte(telegramEvents.receivedAt, new Date(query.to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalRow] = await this.db.select({ value: count() }).from(telegramEvents).where(where);

    const rows = await this.db
      .select({
        event: telegramEvents,
        botName: bots.name,
        deliveryCount: sql<number>`(SELECT COUNT(*) FROM ${deliveries} WHERE ${deliveries.eventId} = ${telegramEvents.id})`,
      })
      .from(telegramEvents)
      .innerJoin(bots, eq(bots.id, telegramEvents.botId))
      .where(where)
      .orderBy(desc(telegramEvents.receivedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: rows.map((row) => this.toDto(row.event, row.botName, Number(row.deliveryCount))),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(totalRow?.value ?? 0),
    };
  }

  private toDto(row: TelegramEventRow, botName: string, deliveryCount: number): EventDto {
    return {
      id: row.id,
      botId: row.botId,
      botName,
      telegramUpdateId: row.telegramUpdateId,
      eventType: row.eventType,
      chatId: row.chatId,
      receivedAt: row.receivedAt.toISOString(),
      deliveryCount,
      isTest: row.isTest,
    };
  }

  async get(id: string, actor: UserRow): Promise<EventDetailDto> {
    const rows = await this.db
      .select({ event: telegramEvents, bot: bots })
      .from(telegramEvents)
      .innerJoin(bots, eq(bots.id, telegramEvents.botId))
      .where(eq(telegramEvents.id, id))
      .limit(1);
    const found = rows[0];
    if (!found) throw new NotFoundError('Event');
    if (actor.role !== 'admin' && found.bot.ownerId !== actor.id) {
      throw new ForbiddenError('You do not have access to this event');
    }

    const [deliveryCount] = await this.db
      .select({ value: count() })
      .from(deliveries)
      .where(eq(deliveries.eventId, id));

    let payload: unknown;
    try {
      payload = JSON.parse(found.event.payload);
    } catch {
      payload = { raw: found.event.payload };
    }

    return {
      ...this.toDto(found.event, found.bot.name, Number(deliveryCount?.value ?? 0)),
      payload,
    };
  }

  async getRow(id: string): Promise<TelegramEventRow> {
    const rows = await this.db
      .select()
      .from(telegramEvents)
      .where(eq(telegramEvents.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('Event');
    return row;
  }

  /** Retention cleanup. Deliveries cascade with their event. */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(telegramEvents)
      .where(lte(telegramEvents.receivedAt, cutoff));
    return Number(result.rowsAffected ?? 0);
  }
}
