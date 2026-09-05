import type { CreateRouteInput, RouteDto, UpdateRouteInput } from '@tg-gateway/shared';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { destinations, routes, type RouteRow, type UserRow } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { newRouteId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import type { MatchableRoute } from '../router/match.js';
import type { BotService } from './bots.js';
import type { DestinationService } from './destinations.js';

function toDto(row: RouteRow, destination: { name: string; url: string }): RouteDto {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    enabled: row.enabled,
    updateTypes: row.updateTypes,
    destinationId: row.destinationId,
    destinationName: destination.name,
    destinationUrl: destination.url,
    priority: row.priority,
    chatIdFilter: row.chatIdFilter,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class RouteService {
  constructor(
    private readonly db: Database,
    private readonly botService: BotService,
    private readonly destinationService: DestinationService,
    private readonly log: Logger,
  ) {}

  async listForBot(botId: string, actor: UserRow): Promise<RouteDto[]> {
    await this.botService.getRowForActor(botId, actor);
    const rows = await this.db
      .select({ route: routes, destination: destinations })
      .from(routes)
      .innerJoin(destinations, eq(destinations.id, routes.destinationId))
      .where(eq(routes.botId, botId))
      .orderBy(asc(routes.priority), asc(routes.id));
    return rows.map((row) => toDto(row.route, row.destination));
  }

  /** Routes for the delivery path: no actor, joined with destination enablement. */
  async listMatchableForBot(botId: string): Promise<MatchableRoute[]> {
    const rows = await this.db
      .select({
        id: routes.id,
        enabled: routes.enabled,
        updateTypes: routes.updateTypes,
        priority: routes.priority,
        chatIdFilter: routes.chatIdFilter,
        destinationId: routes.destinationId,
        destinationEnabled: destinations.enabled,
      })
      .from(routes)
      .innerJoin(destinations, eq(destinations.id, routes.destinationId))
      .where(eq(routes.botId, botId));
    return rows;
  }

  async create(botId: string, input: CreateRouteInput, actor: UserRow): Promise<RouteDto> {
    await this.botService.getRowForActor(botId, actor);
    // A manager may only point a route at a destination they own.
    await this.destinationService.getRowForActor(input.destinationId, actor);

    if (input.updateTypes.length === 0) {
      throw new ValidationError('A route needs at least one update type');
    }

    const id = newRouteId();
    await this.db.insert(routes).values({
      id,
      botId,
      destinationId: input.destinationId,
      name: input.name,
      enabled: input.enabled,
      updateTypes: input.updateTypes,
      priority: input.priority,
      chatIdFilter: input.chatIdFilter?.trim() || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    this.log.info({ routeId: id, botId, updateTypes: input.updateTypes }, 'Route created');
    return this.get(id, actor);
  }

  async get(id: string, actor: UserRow): Promise<RouteDto> {
    const rows = await this.db
      .select({ route: routes, destination: destinations })
      .from(routes)
      .innerJoin(destinations, eq(destinations.id, routes.destinationId))
      .where(eq(routes.id, id))
      .limit(1);
    const found = rows[0];
    if (!found) throw new NotFoundError('Route');
    await this.botService.getRowForActor(found.route.botId, actor);
    return toDto(found.route, found.destination);
  }

  async update(id: string, input: UpdateRouteInput, actor: UserRow): Promise<RouteDto> {
    const existing = await this.get(id, actor);
    const patch: Partial<typeof routes.$inferInsert> = { updatedAt: new Date() };

    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.updateTypes !== undefined) patch.updateTypes = input.updateTypes;
    if (input.chatIdFilter !== undefined) patch.chatIdFilter = input.chatIdFilter.trim() || null;
    if (input.destinationId !== undefined && input.destinationId !== existing.destinationId) {
      await this.destinationService.getRowForActor(input.destinationId, actor);
      patch.destinationId = input.destinationId;
    }

    await this.db.update(routes).set(patch).where(eq(routes.id, id));
    this.log.info({ routeId: id, changes: Object.keys(patch) }, 'Route updated');
    return this.get(id, actor);
  }

  async remove(id: string, actor: UserRow): Promise<void> {
    await this.get(id, actor);
    await this.db.delete(routes).where(eq(routes.id, id));
    this.log.info({ routeId: id }, 'Route deleted');
  }
}
