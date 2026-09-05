import type { SessionUserDto } from '@tg-gateway/shared';
import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions, users, type SessionRow, type UserRow } from '../db/schema.js';
import { hmacSha256Hex, randomToken } from '../lib/crypto.js';
import { AppError, UnauthenticatedError } from '../lib/errors.js';
import { newSessionId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { verifyPassword } from '../lib/passwords.js';
import type { UserService } from './users.js';

export const SESSION_COOKIE = 'tgw_session';
export const CSRF_COOKIE = 'tgw_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthenticatedSession {
  session: SessionRow;
  user: UserRow;
}

export interface LoginResult {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  user: SessionUserDto;
}

export function toSessionUserDto(row: UserRow): SessionUserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
  };
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly userService: UserService,
    private readonly sessionSecret: string,
    private readonly sessionTtlHours: number,
    private readonly log: Logger,
  ) {}

  /** The cookie carries a random token; only its keyed digest is persisted. */
  private digest(token: string): string {
    return hmacSha256Hex(this.sessionSecret, token);
  }

  async login(
    username: string,
    password: string,
    meta: { userAgent?: string; ipAddress?: string },
  ): Promise<LoginResult> {
    const user = await this.userService.findByUsername(username);

    // Always run a verification so a missing user and a wrong password cost the same.
    const referenceHash =
      user?.passwordHash ??
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';
    const passwordValid = await verifyPassword(referenceHash, password);

    if (!user || !passwordValid) {
      throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password', 401);
    }
    if (user.status === 'blocked') {
      throw new AppError(
        'ACCOUNT_BLOCKED',
        'This account has been blocked by an administrator',
        403,
      );
    }

    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 3_600_000);

    await this.db.insert(sessions).values({
      id: newSessionId(),
      userId: user.id,
      tokenHash: this.digest(token),
      csrfToken,
      userAgent: meta.userAgent?.slice(0, 256) ?? null,
      ipAddress: meta.ipAddress?.slice(0, 64) ?? null,
      expiresAt,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });
    await this.userService.touchLogin(user.id);

    this.log.info({ userId: user.id, username: user.username }, 'Admin login succeeded');
    return { token, csrfToken, expiresAt, user: toSessionUserDto(user) };
  }

  async resolve(token: string): Promise<AuthenticatedSession> {
    const rows = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, this.digest(token)))
      .limit(1);

    const found = rows[0];
    if (!found) throw new UnauthenticatedError('Session not found or expired');

    if (found.session.expiresAt.getTime() <= Date.now()) {
      await this.db.delete(sessions).where(eq(sessions.id, found.session.id));
      throw new UnauthenticatedError('Session expired');
    }
    if (found.user.status === 'blocked') {
      await this.db.delete(sessions).where(eq(sessions.userId, found.user.id));
      throw new AppError(
        'ACCOUNT_BLOCKED',
        'This account has been blocked by an administrator',
        403,
      );
    }

    // Cheap activity tracking: only write once per minute.
    if (Date.now() - found.session.lastSeenAt.getTime() > 60_000) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(sessions.id, found.session.id));
    }

    return { session: found.session, user: found.user };
  }

  async logout(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, this.digest(token)));
  }

  async logoutAllForUser(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async purgeExpired(): Promise<number> {
    const result = await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    return Number(result.rowsAffected ?? 0);
  }

  async countActiveSessions(userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId)));
    return rows.length;
  }
}
