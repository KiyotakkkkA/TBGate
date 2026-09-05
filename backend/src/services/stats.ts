import type { DashboardStatsDto } from '@tg-gateway/shared';
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { bots, telegramEvents, type UserRow } from '../db/schema.js';
import { pingDatabase } from '../db/client.js';
import type { Client } from '@libsql/client';
import type { DeliveryService } from './deliveries.js';

export interface StatsServiceConfig {
  publicBaseUrl: string;
  version: string;
  startedAt: number;
}

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

export class StatsService {
  constructor(
    private readonly db: Database,
    private readonly client: Client,
    private readonly deliveries: DeliveryService,
    private readonly config: StatsServiceConfig,
  ) {}

  private async scopeBotIds(actor: UserRow): Promise<string[] | null> {
    if (actor.role === 'admin') return null;
    const rows = await this.db.select({ id: bots.id }).from(bots).where(eq(bots.ownerId, actor.id));
    return rows.map((row) => row.id);
  }

  async dashboard(actor: UserRow, workerRunning: boolean): Promise<DashboardStatsDto> {
    const scope = await this.scopeBotIds(actor);
    const since = startOfToday();

    const botScope = scope === null ? undefined : inArray(bots.id, scope);
    const [botTotals] = await this.db.select({ value: count() }).from(bots).where(botScope);
    const [botActive] = await this.db
      .select({ value: count() })
      .from(bots)
      .where(botScope ? and(eq(bots.enabled, true), botScope) : eq(bots.enabled, true));

    const eventScope =
      scope === null
        ? gte(telegramEvents.receivedAt, since)
        : and(gte(telegramEvents.receivedAt, since), inArray(telegramEvents.botId, scope));
    const [eventsToday] = await this.db
      .select({ value: count() })
      .from(telegramEvents)
      .where(eventScope);

    const deliveryStats = await this.deliveries.statsSince(since, scope);
    const pending = await this.deliveries.countPending();
    const recentFailures = await this.deliveries.recentFailures(actor, 5);
    const databaseOk = await pingDatabase(this.client);

    const finished = deliveryStats.succeeded + deliveryStats.failed;
    const successRate = finished > 0 ? deliveryStats.succeeded / finished : null;

    return {
      bots: { total: Number(botTotals?.value ?? 0), active: Number(botActive?.value ?? 0) },
      eventsToday: Number(eventsToday?.value ?? 0),
      deliveriesToday: deliveryStats.total,
      failedDeliveriesToday: deliveryStats.failed,
      pendingDeliveries: pending,
      successRate,
      recentFailures,
      health: {
        status: databaseOk ? 'ok' : 'degraded',
        database: databaseOk,
        worker: workerRunning,
        publicBaseUrl: this.config.publicBaseUrl,
        version: this.config.version,
        uptimeSeconds: Math.floor((Date.now() - this.config.startedAt) / 1000),
      },
    };
  }
}
