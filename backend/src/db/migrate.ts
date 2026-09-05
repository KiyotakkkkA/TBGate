import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Database } from './client.js';
import type { Logger } from '../lib/logger.js';

const LOCK_KEY = 'schema_migration_lock';
const LOCK_TTL_MS = 60_000;

/**
 * Locates the generated SQL migrations. They sit next to the compiled bundle in the
 * Docker image (`/app/backend/drizzle`) and at `backend/drizzle` in development.
 */
export function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(here, '../drizzle'), // dist/index.js -> backend/drizzle
    resolve(here, '../../drizzle'), // src/db/migrate.ts -> backend/drizzle
    resolve(process.cwd(), 'drizzle'),
    resolve(process.cwd(), 'backend/drizzle'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'meta/_journal.json'))) return candidate;
  }
  throw new Error(
    `Could not locate database migrations. Looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

/**
 * Cooperative lock so that two containers pointed at the same volume cannot migrate
 * concurrently. SQLite already serialises writers; this turns a lock timeout into a
 * clear error instead of a partially applied migration.
 */
async function acquireLock(client: Client, owner: string, log: Logger): Promise<boolean> {
  await client.execute(
    'CREATE TABLE IF NOT EXISTS migration_lock (key TEXT PRIMARY KEY, owner TEXT NOT NULL, acquired_at INTEGER NOT NULL)',
  );
  const now = Date.now();
  const existing = await client.execute({
    sql: 'SELECT owner, acquired_at FROM migration_lock WHERE key = ?',
    args: [LOCK_KEY],
  });
  const row = existing.rows[0];
  if (row) {
    const acquiredAt = Number(row.acquired_at);
    if (now - acquiredAt < LOCK_TTL_MS) return false;
    log.warn({ staleOwner: String(row.owner) }, 'Reclaiming stale migration lock');
    await client.execute({ sql: 'DELETE FROM migration_lock WHERE key = ?', args: [LOCK_KEY] });
  }
  try {
    await client.execute({
      sql: 'INSERT INTO migration_lock (key, owner, acquired_at) VALUES (?, ?, ?)',
      args: [LOCK_KEY, owner, now],
    });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(client: Client, owner: string): Promise<void> {
  await client.execute({
    sql: 'DELETE FROM migration_lock WHERE key = ? AND owner = ?',
    args: [LOCK_KEY, owner],
  });
}

/**
 * Migrations run automatically at startup (see docs/ARCHITECTURE.md for the rationale):
 * the production deployment is `docker compose pull && up -d`, and requiring a separate
 * manual step there would leave the container running against an old schema.
 */
export async function runMigrations(
  db: Database,
  client: Client,
  log: Logger,
): Promise<{ applied: boolean }> {
  const folder = resolveMigrationsFolder();
  const owner = `${process.pid}-${Date.now()}`;

  const deadline = Date.now() + LOCK_TTL_MS;
  let locked = await acquireLock(client, owner, log);
  while (!locked && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    locked = await acquireLock(client, owner, log);
  }
  if (!locked) {
    throw new Error('Timed out waiting for the database migration lock');
  }

  try {
    log.info({ folder }, 'Applying database migrations');
    await migrate(db, { migrationsFolder: folder });
    log.info('Database migrations up to date');
    return { applied: true };
  } finally {
    await releaseLock(client, owner);
  }
}
