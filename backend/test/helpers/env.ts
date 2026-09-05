import type { Env } from '../../src/config/env.js';
import { loadEnv } from '../../src/config/env.js';

export const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** Minimal valid environment for tests, with overrides applied on top. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://gateway.test',
    DATABASE_URL: ':memory:',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-password',
    APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    SESSION_SECRET: 'session-secret-that-is-long-enough-for-tests',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'silent',
    DELIVERY_WORKER_ENABLED: 'false',
    API_RATE_LIMIT_ENABLED: 'false',
    ...overrides,
  } as NodeJS.ProcessEnv);
}
