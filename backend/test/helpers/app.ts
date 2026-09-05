import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { createAppContext, type AppContext } from '../../src/app-context.js';
import type { Env } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';
import { testEnv } from './env.js';

export interface TelegramCall {
  method: string;
  token: string;
  payload: unknown;
}

export interface DeliveryCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface TestHarness {
  ctx: AppContext;
  app: FastifyInstance;
  env: Env;
  telegramCalls: TelegramCall[];
  deliveryCalls: DeliveryCall[];
  /** Controls what the fake destination responds with for the next requests. */
  destinationResponse: { status: number; body: string; throwError?: Error | null };
  close: () => Promise<void>;
}

/**
 * Builds a fully wired application against an in-memory SQLite database with the
 * Telegram API and destination HTTP client replaced by fakes. No test ever performs
 * real network I/O.
 */
export async function createTestHarness(
  overrides: Record<string, string> = {},
): Promise<TestHarness> {
  const env = testEnv(overrides);
  const telegramCalls: TelegramCall[] = [];
  const deliveryCalls: DeliveryCall[] = [];
  const destinationResponse = {
    status: 200,
    body: '{"ok":true}',
    throwError: null as Error | null,
  };

  const telegramFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = /\/bot([^/]+)\/(\w+)$/.exec(url);
    const token = match?.[1] ?? '';
    const method = match?.[2] ?? '';
    const payload = init?.body ? JSON.parse(init.body as string) : {};
    telegramCalls.push({ method, token, payload });

    const results: Record<string, unknown> = {
      getMe: {
        id: Number(token.split(':')[0] ?? 1),
        is_bot: true,
        first_name: 'Test Bot',
        username: 'test_bot',
      },
      setWebhook: true,
      deleteWebhook: true,
      getWebhookInfo: {
        url: `${env.PUBLIC_BASE_URL}${env.TELEGRAM_WEBHOOK_PATH}/unknown`,
        has_custom_certificate: false,
        pending_update_count: 0,
      },
      sendMessage: { message_id: 42, text: (payload as { text?: string }).text ?? '' },
    };

    const result = results[method] ?? { ok: true };
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const deliveryFetch: typeof fetch = async (input, init) => {
    if (destinationResponse.throwError) throw destinationResponse.throwError;
    deliveryCalls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'POST',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: (init?.body as string) ?? '',
    });
    return new Response(destinationResponse.body, { status: destinationResponse.status });
  };

  const ctx = await createAppContext(env, {
    logger: pino({ level: 'silent' }),
    telegramFetch,
    deliveryFetch,
    startWorker: true, // constructed, but never auto-started: tests drive tick() explicitly
  });

  await ctx.services.users.bootstrapAdmin(env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
  const app = await buildServer(ctx);
  await app.ready();

  return {
    ctx,
    app,
    env,
    telegramCalls,
    deliveryCalls,
    destinationResponse,
    close: async () => {
      await app.close();
      await ctx.close();
    },
  };
}

/** Signs in and returns the cookie header plus CSRF token for authenticated requests. */
export async function login(
  harness: TestHarness,
  username = 'admin',
  password = 'admin-password',
): Promise<{ cookie: string; csrfToken: string; headers: Record<string, string> }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
  }
  const cookies = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrfToken = (JSON.parse(response.body) as { csrfToken: string }).csrfToken;
  return {
    cookie: cookies,
    csrfToken,
    headers: { cookie: cookies, 'x-csrf-token': csrfToken },
  };
}
