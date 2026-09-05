/**
 * Standalone migration entry point: `pnpm db:migrate`.
 * The server also migrates on boot; this exists for local development and CI.
 */
import { applyPragmas, createDatabase } from './client.js';
import { runMigrations } from './migrate.js';
import { createLogger } from '../lib/logger.js';

const databaseUrl = process.env.DATABASE_URL ?? 'file:../data/gateway.sqlite';
const log = createLogger({ LOG_LEVEL: 'info', LOG_PRETTY: true, APP_NAME: 'migrate' });

const handle = createDatabase(databaseUrl);
try {
  await applyPragmas(handle.client);
  await runMigrations(handle.db, handle.client, log);
  log.info({ database: handle.filePath ?? databaseUrl }, 'Migration complete');
} catch (error) {
  log.error({ err: error }, 'Migration failed');
  process.exitCode = 1;
} finally {
  handle.close();
}
