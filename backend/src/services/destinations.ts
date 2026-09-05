import type {
  CreateDestinationInput,
  DestinationDto,
  UpdateDestinationInput,
} from '@tg-gateway/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { destinations, routes, users, type DestinationRow, type UserRow } from '../db/schema.js';
import { decryptSecret, encryptSecret, maskTail, randomToken } from '../lib/crypto.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { newDestinationId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { assertDestinationAllowed, type SsrfPolicy } from '../security/ssrf.js';

export interface DestinationServiceConfig {
  encryptionKey: Buffer;
  ssrf: SsrfPolicy;
}

/** Headers the gateway sets itself and that a destination config may not override. */
const RESERVED_HEADERS = new Set([
  'content-type',
  'content-length',
  'host',
  'x-tg-gateway-signature',
  'x-tg-gateway-timestamp',
  'x-tg-gateway-delivery-id',
]);

function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!headers) return null;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim().toLowerCase();
    if (!name || RESERVED_HEADERS.has(name)) continue;
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    result[name] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export class DestinationService {
  constructor(
    private readonly db: Database,
    private readonly config: DestinationServiceConfig,
    private readonly log: Logger,
  ) {}

  toDto(
    row: DestinationRow,
    extra: { ownerUsername: string | null; routeCount: number },
  ): DestinationDto {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      method: row.method,
      enabled: row.enabled,
      timeoutMs: row.timeoutMs,
      headers: row.headers ?? null,
      signingEnabled: row.signingEnabled,
      signingSecretConfigured: Boolean(row.encryptedSigningSecret),
      signingSecretHint: row.signingSecretHint,
      ownerId: row.ownerId,
      ownerUsername: extra.ownerUsername,
      routeCount: extra.routeCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  revealSigningSecret(row: DestinationRow): string | null {
    if (!row.encryptedSigningSecret) return null;
    return decryptSecret(row.encryptedSigningSecret, this.config.encryptionKey);
  }

  private assertAccess(row: DestinationRow, actor: UserRow): void {
    if (actor.role === 'admin') return;
    if (row.ownerId !== actor.id) {
      throw new ForbiddenError('You do not have access to this destination');
    }
  }

  async getRow(id: string): Promise<DestinationRow> {
    const rows = await this.db.select().from(destinations).where(eq(destinations.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('Destination');
    return row;
  }

  async getRowForActor(id: string, actor: UserRow): Promise<DestinationRow> {
    const row = await this.getRow(id);
    this.assertAccess(row, actor);
    return row;
  }

  async list(actor: UserRow): Promise<DestinationDto[]> {
    const rows = await this.db
      .select({
        destination: destinations,
        ownerUsername: users.username,
        routeCount: sql<number>`(SELECT COUNT(*) FROM ${routes} WHERE ${routes.destinationId} = ${destinations.id})`,
      })
      .from(destinations)
      .leftJoin(users, eq(users.id, destinations.ownerId))
      .orderBy(desc(destinations.createdAt));

    return rows
      .filter((row) => actor.role === 'admin' || row.destination.ownerId === actor.id)
      .map((row) =>
        this.toDto(row.destination, {
          ownerUsername: row.ownerUsername,
          routeCount: Number(row.routeCount),
        }),
      );
  }

  async get(id: string, actor: UserRow): Promise<DestinationDto> {
    const row = await this.getRowForActor(id, actor);
    const [extra] = await this.db
      .select({
        ownerUsername: users.username,
        routeCount: sql<number>`(SELECT COUNT(*) FROM ${routes} WHERE ${routes.destinationId} = ${destinations.id})`,
      })
      .from(destinations)
      .leftJoin(users, eq(users.id, destinations.ownerId))
      .where(eq(destinations.id, id));
    return this.toDto(row, {
      ownerUsername: extra?.ownerUsername ?? null,
      routeCount: Number(extra?.routeCount ?? 0),
    });
  }

  async create(input: CreateDestinationInput, actor: UserRow): Promise<DestinationDto> {
    await assertDestinationAllowed(input.url, this.config.ssrf);

    const secret = input.signingEnabled ? (input.signingSecret ?? randomToken(32)) : null;
    const id = newDestinationId();
    await this.db.insert(destinations).values({
      id,
      name: input.name,
      ownerId: actor.id,
      url: input.url,
      method: input.method,
      enabled: input.enabled,
      timeoutMs: input.timeoutMs ?? null,
      headers: sanitizeHeaders(input.headers),
      signingEnabled: input.signingEnabled,
      encryptedSigningSecret: secret ? encryptSecret(secret, this.config.encryptionKey) : null,
      signingSecretHint: secret ? maskTail(secret) : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    this.log.info({ destinationId: id, url: input.url }, 'Destination created');
    return this.get(id, actor);
  }

  async update(id: string, input: UpdateDestinationInput, actor: UserRow): Promise<DestinationDto> {
    const row = await this.getRowForActor(id, actor);
    const patch: Partial<typeof destinations.$inferInsert> = { updatedAt: new Date() };

    if (input.url !== undefined) {
      await assertDestinationAllowed(input.url, this.config.ssrf);
      patch.url = input.url;
    }
    if (input.name !== undefined) patch.name = input.name;
    if (input.method !== undefined) patch.method = input.method;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.timeoutMs !== undefined) patch.timeoutMs = input.timeoutMs ?? null;
    if (input.headers !== undefined) patch.headers = sanitizeHeaders(input.headers);

    if (input.ownerId !== undefined) {
      if (actor.role !== 'admin') {
        throw new ForbiddenError('Only an administrator can reassign destination ownership');
      }
      patch.ownerId = input.ownerId;
    }

    const signingEnabled = input.signingEnabled ?? row.signingEnabled;
    const wantsNewSecret =
      input.rotateSigningSecret === true ||
      input.signingSecret !== undefined ||
      (signingEnabled && !row.encryptedSigningSecret);

    if (input.signingEnabled !== undefined) patch.signingEnabled = input.signingEnabled;
    if (signingEnabled && wantsNewSecret) {
      const secret = input.signingSecret ?? randomToken(32);
      patch.encryptedSigningSecret = encryptSecret(secret, this.config.encryptionKey);
      patch.signingSecretHint = maskTail(secret);
    }

    await this.db.update(destinations).set(patch).where(eq(destinations.id, id));
    this.log.info({ destinationId: id, changes: Object.keys(patch) }, 'Destination updated');
    return this.get(id, actor);
  }

  async remove(id: string, actor: UserRow): Promise<void> {
    await this.getRowForActor(id, actor);
    await this.db.delete(destinations).where(eq(destinations.id, id));
    this.log.info({ destinationId: id }, 'Destination deleted');
  }

  /**
   * Returns the signing secret in plaintext exactly once, for the operator to copy into
   * the downstream service. Guarded by the same ownership rules as the rest of the API.
   */
  async revealSecretForActor(id: string, actor: UserRow): Promise<string | null> {
    const row = await this.getRowForActor(id, actor);
    return this.revealSigningSecret(row);
  }
}
