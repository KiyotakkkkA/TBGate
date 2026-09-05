import type { ApiKeyDto, ApiScope, CreateApiKeyInput, CreatedApiKeyDto } from '@tg-gateway/shared';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { apiKeys, users, type ApiKeyRow, type UserRow } from '../db/schema.js';
import { hmacSha256Hex, randomToken } from '../lib/crypto.js';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../lib/errors.js';
import { newApiKeyId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';

const KEY_PREFIX = 'tgw';

export interface ApiKeyPrincipal {
  keyId: string;
  keyName: string;
  scopes: ApiScope[];
  ownerId: string | null;
  ownerRole: 'admin' | 'manager' | null;
}

function toDto(row: ApiKeyRow, ownerUsername: string | null): ApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as ApiScope[],
    ownerId: row.ownerId,
    ownerUsername,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class ApiKeyService {
  constructor(
    private readonly db: Database,
    /** Server-side pepper, derived from APP_ENCRYPTION_KEY. */
    private readonly pepper: string,
    private readonly log: Logger,
  ) {}

  private digest(token: string): string {
    return hmacSha256Hex(this.pepper, token);
  }

  async list(actor: UserRow): Promise<ApiKeyDto[]> {
    const rows = await this.db
      .select({ key: apiKeys, ownerUsername: users.username })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.ownerId))
      .orderBy(apiKeys.createdAt);

    return rows
      .filter((row) => actor.role === 'admin' || row.key.ownerId === actor.id)
      .map((row) => toDto(row.key, row.ownerUsername));
  }

  /**
   * Generates `tgw_<prefix>_<secret>`. Only the digest is stored, so the plaintext key
   * exists exactly once - in the response to this call.
   */
  async create(input: CreateApiKeyInput, actor: UserRow): Promise<CreatedApiKeyDto> {
    const publicPart = randomToken(6)
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8)
      .toLowerCase();
    const secretPart = randomToken(32);
    const prefix = `${KEY_PREFIX}_${publicPart}`;
    const token = `${prefix}_${secretPart}`;

    const row: typeof apiKeys.$inferInsert = {
      id: newApiKeyId(),
      name: input.name,
      ownerId: actor.id,
      prefix,
      tokenHash: this.digest(token),
      scopes: input.scopes,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdAt: new Date(),
    };
    const [created] = await this.db.insert(apiKeys).values(row).returning();
    if (!created) throw new Error('Failed to create API key');

    this.log.info({ apiKeyId: created.id, scopes: input.scopes }, 'API key created');
    return { ...toDto(created, actor.username), token };
  }

  async revoke(id: string, actor: UserRow): Promise<void> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('API key');
    if (actor.role !== 'admin' && row.ownerId !== actor.id) {
      throw new ForbiddenError('You can only revoke your own API keys');
    }
    await this.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
    this.log.info({ apiKeyId: id }, 'API key revoked');
  }

  async remove(id: string, actor: UserRow): Promise<void> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('API key');
    if (actor.role !== 'admin' && row.ownerId !== actor.id) {
      throw new ForbiddenError('You can only delete your own API keys');
    }
    await this.db.delete(apiKeys).where(eq(apiKeys.id, id));
  }

  async authenticate(token: string): Promise<ApiKeyPrincipal> {
    if (!token.startsWith(`${KEY_PREFIX}_`)) {
      throw new UnauthenticatedError('Invalid API key');
    }
    const rows = await this.db
      .select({ key: apiKeys, owner: users })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.ownerId))
      .where(and(eq(apiKeys.tokenHash, this.digest(token)), isNull(apiKeys.revokedAt)))
      .limit(1);

    const found = rows[0];
    if (!found) throw new UnauthenticatedError('Invalid API key');
    if (found.key.expiresAt && found.key.expiresAt.getTime() <= Date.now()) {
      throw new UnauthenticatedError('API key has expired');
    }
    if (found.owner && found.owner.status === 'blocked') {
      throw new ForbiddenError('The owner of this API key is blocked');
    }

    // Best-effort usage tracking; failures here must not break the request.
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, found.key.id))
      .catch(() => undefined);

    return {
      keyId: found.key.id,
      keyName: found.key.name,
      scopes: found.key.scopes as ApiScope[],
      ownerId: found.key.ownerId,
      ownerRole: found.owner ? found.owner.role : null,
    };
  }

  static assertScope(principal: ApiKeyPrincipal, scope: ApiScope): void {
    if (!principal.scopes.includes(scope)) {
      throw new ForbiddenError(`This API key is missing the "${scope}" scope`);
    }
  }

  async purgeStale(before: Date): Promise<number> {
    const result = await this.db
      .delete(apiKeys)
      .where(or(lt(apiKeys.revokedAt, before), lt(apiKeys.expiresAt, before)));
    return Number(result.rowsAffected ?? 0);
  }
}
