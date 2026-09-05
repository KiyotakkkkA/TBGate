import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyDeliverySignature } from '../src/lib/crypto.js';
import { createTestHarness, login, type TestHarness } from './helpers/app.js';

const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

let harness: TestHarness;

async function setupBotWithRoute(auth: { headers: Record<string, string> }) {
  const botResponse = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/bots',
    headers: auth.headers,
    payload: { name: 'Support Bot', token: BOT_TOKEN, allowedUpdates: ['message'], enabled: true },
  });
  expect(botResponse.statusCode).toBe(201);
  const bot = botResponse.json() as { id: string; webhookUrl: string };

  const destinationResponse = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/destinations',
    headers: auth.headers,
    payload: {
      name: 'Python worker',
      url: 'http://python-worker:8000/events',
      method: 'POST',
      enabled: true,
      signingEnabled: true,
    },
  });
  expect(destinationResponse.statusCode).toBe(201);
  const destination = destinationResponse.json() as { id: string };

  const routeResponse = await harness.app.inject({
    method: 'POST',
    url: `/api/v1/bots/${bot.id}/routes`,
    headers: auth.headers,
    payload: {
      name: 'Messages to worker',
      destinationId: destination.id,
      updateTypes: ['message'],
      enabled: true,
      priority: 100,
    },
  });
  expect(routeResponse.statusCode).toBe(201);

  const row = await harness.ctx.services.bots.getRow(bot.id);
  return {
    bot,
    destination,
    route: routeResponse.json() as { id: string },
    webhookSecret: harness.ctx.services.bots.revealWebhookSecret(row),
  };
}

function telegramUpdate(updateId: number, text = 'hello') {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 42, is_bot: false, first_name: 'Ada' },
      chat: { id: 42, type: 'private' },
      date: 1700000000,
      text,
    },
  };
}

beforeEach(async () => {
  harness = await createTestHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('bot registration', () => {
  it('validates the token with getMe, encrypts it, and registers the webhook', async () => {
    const auth = await login(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/bots',
      headers: auth.headers,
      payload: { name: 'Support Bot', token: BOT_TOKEN, allowedUpdates: ['message'] },
    });

    expect(response.statusCode).toBe(201);
    const bot = response.json();

    expect(harness.telegramCalls.map((call) => call.method)).toEqual(['getMe', 'setWebhook']);
    expect(bot.telegramUsername).toBe('test_bot');
    expect(bot.webhookState).toBe('active');
    expect(bot.webhookUrl).toBe(`https://gateway.test/telegram/webhook/${bot.id}`);

    // setWebhook must carry a secret token and never put the bot token in the URL.
    const setWebhook = harness.telegramCalls[1]?.payload as {
      url: string;
      secret_token: string;
      allowed_updates: string[];
    };
    expect(setWebhook.secret_token).toBeTruthy();
    expect(setWebhook.url).not.toContain(BOT_TOKEN);
    expect(setWebhook.allowed_updates).toEqual(['message']);
  });

  it('never returns the bot token to the client, only a masked hint', async () => {
    const auth = await login(harness);
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/bots',
      headers: auth.headers,
      payload: { name: 'Support Bot', token: BOT_TOKEN },
    });
    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bots',
      headers: auth.headers,
    });

    for (const body of [created.body, listed.body]) {
      expect(body).not.toContain(BOT_TOKEN);
      expect(body).not.toContain('AAHdqTcv');
    }
    expect(created.json().tokenHint).toBe('123456789:••••••Dsaw');
    expect(created.json().tokenConfigured).toBe(true);
  });

  it('stores the token as ciphertext in the database', async () => {
    const auth = await login(harness);
    const bot = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/bots',
        headers: auth.headers,
        payload: { name: 'Support Bot', token: BOT_TOKEN },
      })
    ).json() as { id: string };

    const row = await harness.ctx.services.bots.getRow(bot.id);
    expect(row.encryptedToken).not.toContain(BOT_TOKEN);
    expect(row.encryptedToken.startsWith('v1.')).toBe(true);
    expect(harness.ctx.services.bots.revealToken(row)).toBe(BOT_TOKEN);
  });

  it('rejects a duplicate Telegram bot', async () => {
    const auth = await login(harness);
    const payload = { name: 'Support Bot', token: BOT_TOKEN };
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/bots',
      headers: auth.headers,
      payload,
    });
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/bots',
      headers: auth.headers,
      payload: { ...payload, name: 'Copy' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFLICT');
  });
});

describe('inbound Telegram webhook', () => {
  it('rejects a request without the secret token header', async () => {
    const auth = await login(harness);
    const { bot } = await setupBotWithRoute(auth);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      payload: telegramUpdate(1),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a request with a wrong secret token', async () => {
    const auth = await login(harness);
    const { bot } = await setupBotWithRoute(auth);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': 'not-the-secret' },
      payload: telegramUpdate(1),
    });
    expect(response.statusCode).toBe(401);
  });

  it('persists the update and queues one delivery per matching route', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: telegramUpdate(101),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, status: 'accepted', deliveries: 1 });

    const events = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/events', headers: auth.headers })
    ).json();
    expect(events.total).toBe(1);
    expect(events.items[0]).toMatchObject({
      eventType: 'message',
      telegramUpdateId: 101,
      chatId: '42',
      deliveryCount: 1,
    });
  });

  it('is idempotent: a Telegram retry of the same update_id creates nothing new', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);
    const headers = { 'x-telegram-bot-api-secret-token': webhookSecret };

    const first = await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers,
      payload: telegramUpdate(202),
    });
    const second = await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers,
      payload: telegramUpdate(202),
    });

    expect(first.json().status).toBe('accepted');
    // A duplicate is acknowledged with 200 so Telegram stops retrying.
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('duplicate');

    const events = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/events', headers: auth.headers })
    ).json();
    expect(events.total).toBe(1);

    const deliveries = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/deliveries', headers: auth.headers })
    ).json();
    expect(deliveries.total).toBe(1);
  });

  it('accepts an unknown future update type without failing', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: { update_id: 303, some_future_update: { chat: { id: 1 } } },
    });

    expect(response.statusCode).toBe(200);
    const events = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/events', headers: auth.headers })
    ).json();
    expect(events.items[0].eventType).toBe('unknown');
  });
});

describe('webhook delivery', () => {
  it('delivers a signed envelope that preserves the original update', async () => {
    const auth = await login(harness);
    const { bot, destination, webhookSecret } = await setupBotWithRoute(auth);

    await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: telegramUpdate(404, 'route me'),
    });

    expect(await harness.ctx.worker?.tick()).toBe(1);
    expect(harness.deliveryCalls).toHaveLength(1);

    const call = harness.deliveryCalls[0]!;
    expect(call.url).toBe('http://python-worker:8000/events');
    expect(call.method).toBe('POST');

    const envelope = JSON.parse(call.body);
    expect(envelope.update).toEqual(telegramUpdate(404, 'route me'));
    expect(envelope.gateway).toMatchObject({
      botId: bot.id,
      botName: 'Support Bot',
      eventType: 'message',
      destinationId: destination.id,
      attempt: 1,
      replay: false,
      test: false,
    });

    const secret = (
      await harness.app.inject({
        method: 'POST',
        url: `/api/v1/destinations/${destination.id}/reveal-secret`,
        headers: auth.headers,
      })
    ).json().signingSecret as string;

    expect(
      verifyDeliverySignature(
        secret,
        call.headers['x-tg-gateway-timestamp']!,
        call.body,
        call.headers['x-tg-gateway-signature']!,
      ),
    ).toBe(true);
    expect(call.headers['x-tg-gateway-delivery-id']).toMatch(/^dlv_/);
  });

  it('marks a 2xx response as success', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);
    await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: telegramUpdate(505),
    });

    await harness.ctx.worker?.tick();

    const deliveries = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/deliveries', headers: auth.headers })
    ).json();
    expect(deliveries.items[0]).toMatchObject({
      status: 'success',
      responseStatus: 200,
      attemptCount: 1,
    });
  });

  it('retries a 5xx failure and records every attempt', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);
    harness.destinationResponse.status = 503;
    harness.destinationResponse.body = 'upstream unavailable';

    await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: telegramUpdate(606),
    });

    await harness.ctx.worker?.tick();

    const deliveries = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/deliveries', headers: auth.headers })
    ).json();
    const delivery = deliveries.items[0];
    expect(delivery.status).toBe('retrying');
    expect(delivery.attemptCount).toBe(1);
    expect(delivery.responseStatus).toBe(503);
    expect(new Date(delivery.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());

    const detail = (
      await harness.app.inject({
        method: 'GET',
        url: `/api/v1/deliveries/${delivery.id}`,
        headers: auth.headers,
      })
    ).json();
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0].responseBody).toContain('upstream unavailable');
    // The signature header must never be persisted with the delivery record.
    expect(Object.keys(detail.requestHeaders)).not.toContain('x-tg-gateway-signature');
  });

  it('does not retry a permanent 4xx rejection', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);
    harness.destinationResponse.status = 404;

    await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: telegramUpdate(707),
    });
    await harness.ctx.worker?.tick();

    const deliveries = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/deliveries', headers: auth.headers })
    ).json();
    expect(deliveries.items[0].status).toBe('failed');
  });

  it('replays a failed delivery as a new record without rewriting history', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);
    harness.destinationResponse.status = 404;

    await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: telegramUpdate(808),
    });
    await harness.ctx.worker?.tick();

    const original = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/deliveries', headers: auth.headers })
    ).json().items[0];

    harness.destinationResponse.status = 200;
    const replay = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${original.id}/retry`,
      headers: auth.headers,
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      isReplay: true,
      replayOfDeliveryId: original.id,
      status: 'pending',
    });
    expect(replay.json().id).not.toBe(original.id);

    await harness.ctx.worker?.tick();

    const after = (
      await harness.app.inject({
        method: 'GET',
        url: `/api/v1/deliveries/${original.id}`,
        headers: auth.headers,
      })
    ).json();
    expect(after.status).toBe('failed');

    const replayed = (
      await harness.app.inject({
        method: 'GET',
        url: `/api/v1/deliveries/${replay.json().id}`,
        headers: auth.headers,
      })
    ).json();
    expect(replayed.status).toBe('success');
  });

  it('classifies a transport failure and keeps the delivery retryable', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);
    const error = new Error('connect ECONNREFUSED') as Error & { cause: { code: string } };
    error.cause = { code: 'ECONNREFUSED' };
    harness.destinationResponse.throwError = error;

    await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: telegramUpdate(909),
    });
    await harness.ctx.worker?.tick();

    const delivery = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/deliveries', headers: auth.headers })
    ).json().items[0];
    expect(delivery.status).toBe('retrying');
    expect(delivery.lastError).toContain('Connection refused');
  });

  it('does not run the same pending delivery twice concurrently', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);
    await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: telegramUpdate(1001),
    });

    const [a, b] = await Promise.all([
      harness.ctx.services.deliveries.claimDue('worker-a', 10),
      harness.ctx.services.deliveries.claimDue('worker-b', 10),
    ]);
    expect(a.length + b.length).toBe(1);
  });
});

describe('route testing', () => {
  it('sends a clearly marked synthetic event through one route', async () => {
    const auth = await login(harness);
    const { route } = await setupBotWithRoute(auth);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/routes/${route.id}/test`,
      headers: auth.headers,
      payload: { eventType: 'message' },
    });
    expect(response.json()).toMatchObject({ ok: true, deliveries: 1 });

    await harness.ctx.worker?.tick();
    const envelope = JSON.parse(harness.deliveryCalls[0]!.body);
    expect(envelope.gateway.test).toBe(true);
    expect(envelope.update.gateway_test).toBe(true);
    expect(harness.deliveryCalls[0]!.headers['x-tg-gateway-test']).toBe('true');
  });
});

/* --------------------------------------------------------- API keys ---- */

describe('gateway API keys', () => {
  it('returns the plaintext key exactly once and stores only a digest', async () => {
    const auth = await login(harness);
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: auth.headers,
      payload: { name: 'worker', scopes: ['telegram:send', 'bots:read'] },
    });

    expect(created.statusCode).toBe(201);
    const key = created.json() as { id: string; token: string; prefix: string };
    expect(key.token.startsWith('tgw_')).toBe(true);

    const listed = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: auth.headers })
    ).json();
    expect(listed[0].prefix).toBe(key.prefix);
    expect(JSON.stringify(listed)).not.toContain(key.token);
  });

  it('sends a Telegram message on behalf of a downstream service', async () => {
    const auth = await login(harness);
    const { bot } = await setupBotWithRoute(auth);
    const key = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: auth.headers,
        payload: { name: 'worker', scopes: ['telegram:send'] },
      })
    ).json() as { token: string };

    harness.telegramCalls.length = 0;
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/bots/${bot.id}/sendMessage`,
      headers: { authorization: `Bearer ${key.token}` },
      payload: { chat_id: 42, text: 'Hello from the worker' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.message_id).toBe(42);
    // The gateway used the stored token; the client never saw it.
    expect(harness.telegramCalls[0]).toMatchObject({ method: 'sendMessage', token: BOT_TOKEN });
    expect(response.body).not.toContain(BOT_TOKEN);
  });

  it('rejects a key that lacks the required scope', async () => {
    const auth = await login(harness);
    const { bot } = await setupBotWithRoute(auth);
    const key = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: auth.headers,
        payload: { name: 'read only', scopes: ['bots:read'] },
      })
    ).json() as { token: string };

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/bots/${bot.id}/sendMessage`,
      headers: { authorization: `Bearer ${key.token}` },
      payload: { chat_id: 42, text: 'nope' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain('telegram:send');
  });

  it('rejects an unknown or revoked key', async () => {
    const auth = await login(harness);
    const { bot } = await setupBotWithRoute(auth);
    const key = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: auth.headers,
        payload: { name: 'temp', scopes: ['telegram:send'] },
      })
    ).json() as { id: string; token: string };

    const unknown = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/bots/${bot.id}/sendMessage`,
      headers: { authorization: 'Bearer tgw_deadbeef_nope' },
      payload: { chat_id: 1, text: 'x' },
    });
    expect(unknown.statusCode).toBe(401);

    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/api-keys/${key.id}/revoke`,
      headers: auth.headers,
    });
    const revoked = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/bots/${bot.id}/sendMessage`,
      headers: { authorization: `Bearer ${key.token}` },
      payload: { chat_id: 1, text: 'x' },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it('refuses to proxy webhook management methods', async () => {
    const auth = await login(harness);
    const { bot } = await setupBotWithRoute(auth);
    const key = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: auth.headers,
        payload: { name: 'worker', scopes: ['telegram:send'] },
      })
    ).json() as { token: string };

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/bots/${bot.id}/telegram/setWebhook`,
      headers: { authorization: `Bearer ${key.token}` },
      payload: { url: 'https://evil.example.com' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('admin authentication and CSRF', () => {
  it('requires a session for admin endpoints', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/bots' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a mutating request without the CSRF header', async () => {
    const auth = await login(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/destinations',
      headers: { cookie: auth.cookie },
      payload: { name: 'x', url: 'https://example.com/hook' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_INVALID');
  });

  it('invalidates the session on logout', async () => {
    const auth = await login(harness);
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: auth.headers,
    });
    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: auth.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('sets an HttpOnly session cookie', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'admin-password' },
    });
    const session = response.cookies.find((cookie) => cookie.name === 'tgw_session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite?.toLowerCase()).toBe('lax');
  });
});

describe('roles and ownership', () => {
  async function createManager(auth: { headers: Record<string, string> }) {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: auth.headers,
      payload: { username: 'manager1', password: 'manager-password', role: 'manager' },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  it('lets an admin create a manager who can then sign in', async () => {
    const auth = await login(harness);
    await createManager(auth);
    const managerAuth = await login(harness, 'manager1', 'manager-password');
    expect(managerAuth.csrfToken).toBeTruthy();
  });

  it('forbids managers from managing users', async () => {
    const auth = await login(harness);
    await createManager(auth);
    const managerAuth = await login(harness, 'manager1', 'manager-password');

    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: managerAuth.headers,
    });
    expect(list.statusCode).toBe(403);
    expect(list.json().error.code).toBe('FORBIDDEN');
  });

  it('scopes a manager to their own bots', async () => {
    const auth = await login(harness);
    await createManager(auth);
    const { bot } = await setupBotWithRoute(auth); // owned by the admin
    const managerAuth = await login(harness, 'manager1', 'manager-password');

    const list = (
      await harness.app.inject({
        method: 'GET',
        url: '/api/v1/bots',
        headers: managerAuth.headers,
      })
    ).json();
    expect(list).toHaveLength(0);

    const direct = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/bots/${bot.id}`,
      headers: managerAuth.headers,
    });
    expect(direct.statusCode).toBe(403);
  });

  it('lets a manager create and see their own bot', async () => {
    const auth = await login(harness);
    await createManager(auth);
    const managerAuth = await login(harness, 'manager1', 'manager-password');

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/bots',
      headers: managerAuth.headers,
      payload: { name: 'Manager Bot', token: '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw' },
    });
    expect(created.statusCode).toBe(201);

    const list = (
      await harness.app.inject({
        method: 'GET',
        url: '/api/v1/bots',
        headers: managerAuth.headers,
      })
    ).json();
    expect(list).toHaveLength(1);

    const adminList = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/bots', headers: auth.headers })
    ).json();
    expect(adminList).toHaveLength(1);
  });

  it('blocks a user immediately and terminates their sessions', async () => {
    const auth = await login(harness);
    const manager = await createManager(auth);
    const managerAuth = await login(harness, 'manager1', 'manager-password');

    await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${manager.id}`,
      headers: auth.headers,
      payload: { status: 'blocked' },
    });

    const afterBlock = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: managerAuth.cookie },
    });
    expect(afterBlock.statusCode).toBe(401);

    const relogin = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'manager1', password: 'manager-password' },
    });
    expect(relogin.statusCode).toBe(403);
    expect(relogin.json().error.code).toBe('ACCOUNT_BLOCKED');
  });

  it('forces a password change after an admin reset', async () => {
    const auth = await login(harness);
    const manager = await createManager(auth);

    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/users/${manager.id}/reset-password`,
      headers: auth.headers,
      payload: { newPassword: 'brand-new-password' },
    });

    const relogin = await login(harness, 'manager1', 'brand-new-password');
    const me = (
      await harness.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: relogin.headers,
      })
    ).json();
    expect(me.user.mustChangePassword).toBe(true);

    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: relogin.headers,
      payload: { currentPassword: 'brand-new-password', newPassword: 'chosen-by-the-user' },
    });
    const after = (
      await harness.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: relogin.headers,
      })
    ).json();
    expect(after.user.mustChangePassword).toBe(false);
  });

  it('protects the bootstrap administrator', async () => {
    const auth = await login(harness);
    const users = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/users', headers: auth.headers })
    ).json() as Array<{ id: string; username: string }>;
    const admin = users.find((user) => user.username === 'admin')!;

    const blocked = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${admin.id}`,
      headers: auth.headers,
      payload: { status: 'blocked' },
    });
    expect(blocked.statusCode).toBe(403);

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${admin.id}`,
      headers: auth.headers,
    });
    expect(deleted.statusCode).toBe(403);
  });
});

describe('destination validation', () => {
  it('rejects a destination with a dangerous scheme', async () => {
    const auth = await login(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/destinations',
      headers: auth.headers,
      payload: { name: 'bad', url: 'file:///etc/passwd' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('blocks private destinations when the policy forbids them', async () => {
    const strict = await createTestHarness({ DESTINATION_ALLOW_PRIVATE_NETWORKS: 'false' });
    try {
      const auth = await login(strict);
      const response = await strict.app.inject({
        method: 'POST',
        url: '/api/v1/destinations',
        headers: auth.headers,
        payload: { name: 'internal', url: 'http://127.0.0.1:9000/hook' },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe('DESTINATION_URL_REJECTED');
    } finally {
      await strict.close();
    }
  });
});

describe('health and dashboard', () => {
  it('reports readiness with dependency checks', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json().checks.database).toBe(true);
  });

  it('aggregates dashboard statistics', async () => {
    const auth = await login(harness);
    const { bot, webhookSecret } = await setupBotWithRoute(auth);
    await harness.app.inject({
      method: 'POST',
      url: `/telegram/webhook/${bot.id}`,
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: telegramUpdate(2001),
    });
    await harness.ctx.worker?.tick();

    const dashboard = (
      await harness.app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: auth.headers })
    ).json();
    expect(dashboard.bots).toMatchObject({ total: 1, active: 1 });
    expect(dashboard.eventsToday).toBe(1);
    expect(dashboard.deliveriesToday).toBe(1);
    expect(dashboard.successRate).toBe(1);
  });
});
