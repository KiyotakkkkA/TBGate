import { z } from 'zod';

const bool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      if (typeof value === 'boolean') return value;
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
      ctx.addIssue({ code: 'custom', message: 'must be a boolean (true/false)' });
      return z.NEVER;
    });

const int = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

/** Accepts hex (64 chars) or base64/base64url (44 chars) and requires exactly 32 decoded bytes. */
const encryptionKey = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const raw = value.trim();
    let bytes: Buffer | null = null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      bytes = Buffer.from(raw, 'hex');
    } else if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(raw)) {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === 32) bytes = decoded;
    }
    if (!bytes || bytes.length !== 32) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must decode to exactly 32 bytes (256 bits). Generate with: openssl rand -hex 32 (or base64 32)',
      });
      return z.NEVER;
    }
    return bytes;
  });

const absoluteUrl = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be an absolute http/https URL' });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'must use the http:// or https:// scheme' });
    }
  });

const csvNumbers = (defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((value, ctx) => {
      const parts = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const numbers = parts.map((part) => Number(part));
      if (numbers.some((n) => !Number.isFinite(n) || n < 0)) {
        ctx.addIssue({ code: 'custom', message: 'must be a comma separated list of milliseconds' });
        return z.NEVER;
      }
      return numbers;
    });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  APP_NAME: z.string().trim().min(1).max(64).default('Telegram Gateway'),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: int(8080, 1, 65535),
  PUBLIC_BASE_URL: absoluteUrl,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(false),
  TRUST_PROXY: bool(false),

  DATABASE_URL: z.string().trim().min(1).default('file:/app/data/gateway.sqlite'),

  ADMIN_USERNAME: z.string().trim().min(1).max(64).default('admin'),
  ADMIN_PASSWORD: z.string().min(8, 'must be at least 8 characters').max(512),

  APP_ENCRYPTION_KEY: encryptionKey,
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),

  SESSION_TTL_HOURS: int(24, 1, 24 * 365),
  COOKIE_SECURE: bool(true),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  TELEGRAM_API_BASE_URL: absoluteUrl.default('https://api.telegram.org'),
  TELEGRAM_WEBHOOK_PATH: z
    .string()
    .trim()
    .default('/telegram/webhook')
    .refine(
      (v) => v.startsWith('/') && !v.endsWith('/'),
      'must start with "/" and not end with "/"',
    ),
  TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES: bool(false),
  TELEGRAM_API_TIMEOUT_MS: int(15_000, 1000, 120_000),

  DELIVERY_WORKER_ENABLED: bool(true),
  DELIVERY_WORKER_CONCURRENCY: int(5, 1, 100),
  DELIVERY_WORKER_POLL_INTERVAL_MS: int(1000, 100, 60_000),
  DELIVERY_TIMEOUT_MS: int(10_000, 500, 120_000),
  DELIVERY_MAX_ATTEMPTS: int(6, 1, 50),
  DELIVERY_RETRY_DELAYS_MS: csvNumbers('1000,5000,30000,120000,600000'),
  DELIVERY_MAX_RESPONSE_BODY_BYTES: int(2048, 0, 65_536),

  EVENT_RETENTION_DAYS: int(30, 0, 3650),
  DELIVERY_RETENTION_DAYS: int(30, 0, 3650),
  CLEANUP_INTERVAL_HOURS: int(24, 1, 24 * 30),

  MAX_REQUEST_BODY_BYTES: int(1_048_576, 1024, 64 * 1024 * 1024),
  API_RATE_LIMIT_ENABLED: bool(true),
  API_RATE_LIMIT_MAX: int(300, 1, 1_000_000),
  API_RATE_LIMIT_WINDOW_MS: int(60_000, 1000, 3_600_000),
  LOGIN_RATE_LIMIT_MAX: int(10, 1, 1000),

  DESTINATION_ALLOW_PRIVATE_NETWORKS: bool(true),

  /** Directory containing the built admin SPA. Resolved relative to the process cwd when relative. */
  STATIC_DIR: z.string().trim().default(''),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigurationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  * ${issue}`).join('\n')}`);
    this.name = 'ConfigurationError';
  }
}

/**
 * Parses and validates process env. Never echoes provided values back in errors,
 * so secrets cannot leak into logs through a validation failure.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const candidate: Record<string, unknown> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = source[key];
    if (value !== undefined && value !== '') candidate[key] = value;
  }

  const result = envSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `${key} ${issue.message}`;
    });
    throw new ConfigurationError(issues);
  }
  return result.data;
}

export function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}
