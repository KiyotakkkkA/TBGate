export const USER_ROLES = ['admin', 'manager'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'blocked'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Scopes usable by gateway API keys. Admin-owned keys may hold any scope;
 * a manager's key is additionally constrained to that manager's own bots.
 */
export const API_SCOPES = [
  'bots:read',
  'telegram:send',
  'events:read',
  'deliveries:read',
  'deliveries:retry',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

export function isAdmin(role: UserRole): boolean {
  return role === 'admin';
}

/** Managers own their resources; admins may act on everything. */
export function canAccessOwned(role: UserRole, actorId: string, ownerId: string | null): boolean {
  if (role === 'admin') return true;
  return ownerId !== null && ownerId === actorId;
}
