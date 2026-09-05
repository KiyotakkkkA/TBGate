import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

export type Database = LibSQLDatabase<typeof schema> & { $client: Client };

export interface DatabaseHandle {
  db: Database;
  client: Client;
  /** Filesystem path for local `file:` databases, otherwise null (e.g. remote libsql). */
  filePath: string | null;
  close: () => void;
}

/**
 * Extracts a filesystem path from a `file:` DATABASE_URL. Supports both the
 * `file:relative/path.sqlite` and `file:/absolute/path.sqlite` spellings.
 */
export function resolveSqlitePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  const raw = databaseUrl.slice('file:'.length).replace(/^\/\//, '/');
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
  const filePath = resolveSqlitePath(databaseUrl);
  if (filePath) {
    // The data directory is a mounted volume in production; create it on first boot.
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const client = createClient({ url: filePath ? `file:${filePath}` : databaseUrl });
  const db = drizzle(client, { schema }) as Database;
  return {
    db,
    client,
    filePath,
    close: () => client.close(),
  };
}

/** WAL + a generous busy timeout keeps the HTTP path and the delivery worker from colliding. */
export async function applyPragmas(client: Client): Promise<void> {
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute('PRAGMA busy_timeout = 5000');
  await client.execute('PRAGMA synchronous = NORMAL');
}

export async function pingDatabase(client: Client): Promise<boolean> {
  try {
    await client.execute('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export { schema };
