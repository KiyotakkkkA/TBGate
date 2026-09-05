import type { CreateUserInput, UpdateUserInput, UserDto, UserRole } from '@tg-gateway/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { bots, sessions, users, type UserRow } from '../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { newUserId } from '../lib/ids.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import type { Logger } from '../lib/logger.js';

export function toUserDto(row: UserRow, botCount = 0): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    botCount,
  };
}

export class UserService {
  constructor(
    private readonly db: Database,
    private readonly log: Logger,
  ) {}

  async findById(id: string): Promise<UserRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByUsername(username: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username.toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(): Promise<UserDto[]> {
    const rows = await this.db
      .select({
        user: users,
        botCount: sql<number>`(SELECT COUNT(*) FROM ${bots} WHERE ${bots.ownerId} = ${users.id})`,
      })
      .from(users)
      .orderBy(users.username);
    return rows.map((row) => toUserDto(row.user, Number(row.botCount)));
  }

  async create(input: CreateUserInput): Promise<UserDto> {
    const username = input.username.toLowerCase();
    const existing = await this.findByUsername(username);
    if (existing) throw new ConflictError(`Username "${username}" is already taken`);

    const row: typeof users.$inferInsert = {
      id: newUserId(),
      username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      status: 'active',
      displayName: input.displayName?.trim() || null,
      mustChangePassword: false,
      isBootstrap: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const [created] = await this.db.insert(users).values(row).returning();
    if (!created) throw new Error('Failed to create user');
    this.log.info({ userId: created.id, role: created.role }, 'User created');
    return toUserDto(created);
  }

  async update(id: string, input: UpdateUserInput, actorId: string): Promise<UserDto> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundError('User');

    if (existing.isBootstrap) {
      if (input.status === 'blocked') {
        throw new ForbiddenError('The bootstrap administrator cannot be blocked');
      }
      if (input.role && input.role !== 'admin') {
        throw new ForbiddenError('The bootstrap administrator must remain an admin');
      }
    }
    if (id === actorId && input.status === 'blocked') {
      throw new ForbiddenError('You cannot block your own account');
    }
    if (id === actorId && input.role && input.role !== existing.role) {
      throw new ForbiddenError('You cannot change your own role');
    }

    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (input.role !== undefined) patch.role = input.role;
    if (input.status !== undefined) patch.status = input.status;
    if (input.displayName !== undefined) patch.displayName = input.displayName.trim() || null;

    const [updated] = await this.db.update(users).set(patch).where(eq(users.id, id)).returning();
    if (!updated) throw new NotFoundError('User');

    // Blocking a user must take effect immediately, not at session expiry.
    if (input.status === 'blocked') {
      await this.db.delete(sessions).where(eq(sessions.userId, id));
    }
    this.log.info({ userId: id, changes: Object.keys(patch) }, 'User updated');
    return toUserDto(updated);
  }

  /** Admin-driven reset. Forces a password change on the user's next login. */
  async resetPassword(id: string, newPassword: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundError('User');
    await this.db
      .update(users)
      .set({
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
    await this.db.delete(sessions).where(eq(sessions.userId, id));
    this.log.info({ userId: id }, 'User password reset by administrator');
  }

  /** Self-service password change; clears the forced-change flag. */
  async changeOwnPassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundError('User');
    const valid = await verifyPassword(existing.passwordHash, currentPassword);
    if (!valid) throw new ForbiddenError('Current password is incorrect');

    await this.db
      .update(users)
      .set({
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
    this.log.info({ userId: id }, 'User changed their password');
  }

  async remove(id: string, actorId: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundError('User');
    if (existing.isBootstrap) {
      throw new ForbiddenError('The bootstrap administrator cannot be deleted');
    }
    if (id === actorId) throw new ForbiddenError('You cannot delete your own account');

    const [remainingAdmins] = await this.db
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
    if (existing.role === 'admin' && Number(remainingAdmins?.value ?? 0) <= 1) {
      throw new ConflictError('At least one active administrator must remain');
    }

    await this.db.delete(users).where(eq(users.id, id));
    this.log.info({ userId: id }, 'User deleted');
  }

  async touchLogin(id: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
  }

  /**
   * Creates the administrator from ADMIN_USERNAME/ADMIN_PASSWORD on first boot only.
   * Changing ADMIN_PASSWORD later never overwrites a stored password - see docs/SECURITY.md
   * for the documented reset procedure.
   */
  async bootstrapAdmin(username: string, password: string): Promise<{ created: boolean }> {
    const normalized = username.toLowerCase();
    const existingBootstrap = await this.db
      .select()
      .from(users)
      .where(eq(users.isBootstrap, true))
      .limit(1);
    if (existingBootstrap.length > 0) {
      const current = existingBootstrap[0] as UserRow;
      if (current.username !== normalized) {
        this.log.warn(
          { configured: normalized, existing: current.username },
          'ADMIN_USERNAME differs from the bootstrapped administrator; the stored account is kept',
        );
      }
      return { created: false };
    }

    const clash = await this.findByUsername(normalized);
    if (clash) {
      await this.db
        .update(users)
        .set({ isBootstrap: true, role: 'admin', updatedAt: new Date() })
        .where(eq(users.id, clash.id));
      return { created: false };
    }

    await this.db.insert(users).values({
      id: newUserId(),
      username: normalized,
      passwordHash: await hashPassword(password),
      role: 'admin' as UserRole,
      status: 'active',
      displayName: 'Administrator',
      mustChangePassword: false,
      isBootstrap: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    this.log.info({ username: normalized }, 'Bootstrapped administrator account');
    return { created: true };
  }
}
