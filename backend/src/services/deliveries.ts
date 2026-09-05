import type {
  DeliveriesQuery,
  DeliveryAttemptDto,
  DeliveryDetailDto,
  DeliveryDto,
  Paginated,
} from '@tg-gateway/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  bots,
  deliveries,
  deliveryAttempts,
  destinations,
  routes,
  telegramEvents,
  type DeliveryAttemptRow,
  type DeliveryRow,
  type UserRow,
} from '../db/schema.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { newAttemptId, newDeliveryId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';

export interface ClaimedDelivery {
  delivery: DeliveryRow;
  eventPayload: string;
  botName: string;
}

export interface AttemptOutcome {
  attempt: number;
  durationMs: number;
  responseStatus: number | null;
  responseBody: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  succeeded: boolean;
  requestHeaders: Record<string, string> | null;
}

/** A worker lease older than this is considered abandoned (process crash / restart). */
export const LOCK_TIMEOUT_MS = 120_000;

function toDto(
  row: DeliveryRow,
  extra: { botName: string; routeName: string | null; destinationName: string | null },
): DeliveryDto {
  return {
    id: row.id,
    eventId: row.eventId,
    botId: row.botId,
    botName: extra.botName,
    routeId: row.routeId,
    routeName: extra.routeName,
    destinationId: row.destinationId,
    destinationName: extra.destinationName,
    destinationUrl: row.destinationUrl,
    eventType: row.eventType,
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    responseStatus: row.responseStatus,
    durationMs: row.durationMs,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    isReplay: row.isReplay,
    replayOfDeliveryId: row.replayOfDeliveryId,
    isTest: row.isTest,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function attemptToDto(row: DeliveryAttemptRow): DeliveryAttemptDto {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    attempt: row.attempt,
    startedAt: row.startedAt.toISOString(),
    durationMs: row.durationMs,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    succeeded: row.succeeded,
  };
}

export class DeliveryService {
  constructor(
    private readonly db: Database,
    private readonly log: Logger,
  ) {}

  /* ------------------------------------------------------------- queue */

  /**
   * Leases up to `limit` due deliveries for one worker instance. The claim is a
   * conditional UPDATE, so two workers (or two processes sharing the volume) can never
   * run the same delivery concurrently. Stale leases are reclaimed after LOCK_TIMEOUT_MS.
   */
  async claimDue(workerId: string, limit: number, now = new Date()): Promise<ClaimedDelivery[]> {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);

    const candidates = await this.db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          inArray(deliveries.status, ['pending', 'retrying', 'processing']),
          lte(deliveries.nextAttemptAt, now),
          or(isNull(deliveries.lockedAt), lte(deliveries.lockedAt, staleBefore)),
        ),
      )
      .orderBy(asc(deliveries.nextAttemptAt), asc(deliveries.id))
      .limit(limit);

    const claimed: ClaimedDelivery[] = [];
    for (const candidate of candidates) {
      const result = await this.db
        .update(deliveries)
        .set({ status: 'processing', lockedAt: now, lockedBy: workerId, updatedAt: now })
        .where(
          and(
            eq(deliveries.id, candidate.id),
            or(isNull(deliveries.lockedAt), lte(deliveries.lockedAt, staleBefore)),
          ),
        );
      if (Number(result.rowsAffected ?? 0) === 0) continue;

      const rows = await this.db
        .select({ delivery: deliveries, payload: telegramEvents.payload, botName: bots.name })
        .from(deliveries)
        .innerJoin(telegramEvents, eq(telegramEvents.id, deliveries.eventId))
        .innerJoin(bots, eq(bots.id, deliveries.botId))
        .where(eq(deliveries.id, candidate.id))
        .limit(1);
      const found = rows[0];
      if (found) {
        claimed.push({
          delivery: found.delivery,
          eventPayload: found.payload,
          botName: found.botName,
        });
      }
    }
    return claimed;
  }

  /** Releases leases held by this worker on shutdown so nothing waits for the lock TTL. */
  async releaseWorkerLeases(workerId: string): Promise<void> {
    await this.db
      .update(deliveries)
      .set({ status: 'pending', lockedAt: null, lockedBy: null })
      .where(and(eq(deliveries.lockedBy, workerId), eq(deliveries.status, 'processing')));
  }

  async recordAttempt(
    deliveryId: string,
    outcome: AttemptOutcome,
    next: { status: DeliveryRow['status']; nextAttemptAt: Date | null },
  ): Promise<void> {
    const now = new Date();
    await this.db.insert(deliveryAttempts).values({
      id: newAttemptId(),
      deliveryId,
      attempt: outcome.attempt,
      startedAt: new Date(now.getTime() - outcome.durationMs),
      durationMs: outcome.durationMs,
      responseStatus: outcome.responseStatus,
      responseBody: outcome.responseBody,
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage,
      succeeded: outcome.succeeded,
    });

    await this.db
      .update(deliveries)
      .set({
        status: next.status,
        attemptCount: outcome.attempt,
        responseStatus: outcome.responseStatus,
        durationMs: outcome.durationMs,
        lastError: outcome.errorMessage,
        requestHeaders: outcome.requestHeaders,
        nextAttemptAt: next.nextAttemptAt ?? new Date(),
        lockedAt: null,
        lockedBy: null,
        completedAt: next.status === 'success' || next.status === 'failed' ? now : null,
        updatedAt: now,
      })
      .where(eq(deliveries.id, deliveryId));
  }

  async countPending(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(deliveries)
      .where(inArray(deliveries.status, ['pending', 'retrying', 'processing']));
    return Number(row?.value ?? 0);
  }

  /* --------------------------------------------------------------- api */

  private async accessibleBotIds(actor: UserRow): Promise<string[] | null> {
    if (actor.role === 'admin') return null;
    const rows = await this.db.select({ id: bots.id }).from(bots).where(eq(bots.ownerId, actor.id));
    return rows.map((row) => row.id);
  }

  async list(query: DeliveriesQuery, actor: UserRow): Promise<Paginated<DeliveryDto>> {
    const conditions: SQL[] = [];
    const scope = await this.accessibleBotIds(actor);
    if (scope !== null) {
      if (scope.length === 0) {
        return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
      }
      conditions.push(inArray(deliveries.botId, scope));
    }
    if (query.botId) conditions.push(eq(deliveries.botId, query.botId));
    if (query.routeId) conditions.push(eq(deliveries.routeId, query.routeId));
    if (query.destinationId) conditions.push(eq(deliveries.destinationId, query.destinationId));
    if (query.status) conditions.push(eq(deliveries.status, query.status));
    if (query.eventId) conditions.push(eq(deliveries.eventId, query.eventId));
    if (query.from) conditions.push(gte(deliveries.createdAt, new Date(query.from)));
    if (query.to) conditions.push(lte(deliveries.createdAt, new Date(query.to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalRow] = await this.db.select({ value: count() }).from(deliveries).where(where);

    const rows = await this.db
      .select({
        delivery: deliveries,
        botName: bots.name,
        routeName: routes.name,
        destinationName: destinations.name,
      })
      .from(deliveries)
      .innerJoin(bots, eq(bots.id, deliveries.botId))
      .leftJoin(routes, eq(routes.id, deliveries.routeId))
      .leftJoin(destinations, eq(destinations.id, deliveries.destinationId))
      .where(where)
      .orderBy(desc(deliveries.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: rows.map((row) =>
        toDto(row.delivery, {
          botName: row.botName,
          routeName: row.routeName,
          destinationName: row.destinationName,
        }),
      ),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(totalRow?.value ?? 0),
    };
  }

  async get(id: string, actor: UserRow): Promise<DeliveryDetailDto> {
    const rows = await this.db
      .select({
        delivery: deliveries,
        bot: bots,
        routeName: routes.name,
        destinationName: destinations.name,
      })
      .from(deliveries)
      .innerJoin(bots, eq(bots.id, deliveries.botId))
      .leftJoin(routes, eq(routes.id, deliveries.routeId))
      .leftJoin(destinations, eq(destinations.id, deliveries.destinationId))
      .where(eq(deliveries.id, id))
      .limit(1);

    const found = rows[0];
    if (!found) throw new NotFoundError('Delivery');
    if (actor.role !== 'admin' && found.bot.ownerId !== actor.id) {
      throw new ForbiddenError('You do not have access to this delivery');
    }

    const attempts = await this.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, id))
      .orderBy(asc(deliveryAttempts.attempt));

    return {
      ...toDto(found.delivery, {
        botName: found.bot.name,
        routeName: found.routeName,
        destinationName: found.destinationName,
      }),
      attempts: attempts.map(attemptToDto),
      requestHeaders: found.delivery.requestHeaders ?? null,
    };
  }

  async getRow(id: string): Promise<DeliveryRow> {
    const rows = await this.db.select().from(deliveries).where(eq(deliveries.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('Delivery');
    return row;
  }

  /**
   * Replays a delivery by creating a NEW delivery row that points at the same event.
   * History is never rewritten; the replay is flagged and links back to its origin.
   */
  async replay(id: string, actor: UserRow): Promise<DeliveryDto> {
    const original = await this.getRow(id);
    const [bot] = await this.db.select().from(bots).where(eq(bots.id, original.botId)).limit(1);
    if (!bot) throw new NotFoundError('Bot');
    if (actor.role !== 'admin' && bot.ownerId !== actor.id) {
      throw new ForbiddenError('You do not have access to this delivery');
    }

    // Re-read the destination so a corrected URL is picked up by the replay.
    let url = original.destinationUrl;
    let method = original.destinationMethod;
    if (original.destinationId) {
      const [destination] = await this.db
        .select()
        .from(destinations)
        .where(eq(destinations.id, original.destinationId))
        .limit(1);
      if (destination) {
        url = destination.url;
        method = destination.method;
      }
    }

    const newId = newDeliveryId();
    await this.db.insert(deliveries).values({
      id: newId,
      eventId: original.eventId,
      botId: original.botId,
      routeId: original.routeId,
      destinationId: original.destinationId,
      destinationUrl: url,
      destinationMethod: method,
      eventType: original.eventType,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: original.maxAttempts,
      nextAttemptAt: new Date(),
      isReplay: true,
      replayOfDeliveryId: original.id,
      isTest: original.isTest,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    this.log.info({ deliveryId: newId, replayOf: id }, 'Delivery replay queued');
    return this.get(newId, actor);
  }

  async recentFailures(actor: UserRow, limit = 5): Promise<DeliveryDto[]> {
    const scope = await this.accessibleBotIds(actor);
    const conditions: SQL[] = [eq(deliveries.status, 'failed')];
    if (scope !== null) {
      if (scope.length === 0) return [];
      conditions.push(inArray(deliveries.botId, scope));
    }

    const rows = await this.db
      .select({
        delivery: deliveries,
        botName: bots.name,
        routeName: routes.name,
        destinationName: destinations.name,
      })
      .from(deliveries)
      .innerJoin(bots, eq(bots.id, deliveries.botId))
      .leftJoin(routes, eq(routes.id, deliveries.routeId))
      .leftJoin(destinations, eq(destinations.id, deliveries.destinationId))
      .where(and(...conditions))
      .orderBy(desc(deliveries.createdAt))
      .limit(limit);

    return rows.map((row) =>
      toDto(row.delivery, {
        botName: row.botName,
        routeName: row.routeName,
        destinationName: row.destinationName,
      }),
    );
  }

  /** Retention cleanup for completed deliveries whose event is still within retention. */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db
      .delete(deliveries)
      .where(
        and(inArray(deliveries.status, ['success', 'failed']), lte(deliveries.createdAt, cutoff)),
      );
    return Number(result.rowsAffected ?? 0);
  }

  async statsSince(since: Date, botIds: string[] | null) {
    const scoped = botIds === null ? undefined : inArray(deliveries.botId, botIds);
    const [row] = await this.db
      .select({
        total: count(),
        failed: sql<number>`SUM(CASE WHEN ${deliveries.status} = 'failed' THEN 1 ELSE 0 END)`,
        succeeded: sql<number>`SUM(CASE WHEN ${deliveries.status} = 'success' THEN 1 ELSE 0 END)`,
      })
      .from(deliveries)
      .where(
        scoped ? and(gte(deliveries.createdAt, since), scoped) : gte(deliveries.createdAt, since),
      );

    return {
      total: Number(row?.total ?? 0),
      failed: Number(row?.failed ?? 0),
      succeeded: Number(row?.succeeded ?? 0),
    };
  }
}
