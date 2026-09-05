import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadEnv } from '../src/config/env.js';
import {
  decryptSecret,
  encryptSecret,
  maskBotToken,
  maskTail,
  redactSecrets,
  safeEqual,
  signDeliveryBody,
  verifyDeliverySignature,
} from '../src/lib/crypto.js';
import { matchRoutes, routeMatches, type MatchableRoute } from '../src/router/match.js';
import { isPrivateAddress, assertSafeDestinationUrl } from '../src/security/ssrf.js';
import { classifyUpdate } from '../src/telegram/classifier.js';
import { decideRetry, isRetryableStatus, nextRetryDelay } from '../src/worker/retry.js';
import { TEST_ENCRYPTION_KEY, testEnv } from './helpers/env.js';

const KEY = Buffer.from(TEST_ENCRYPTION_KEY, 'hex');

describe('environment validation', () => {
  it('accepts a complete configuration and applies documented defaults', () => {
    const env = testEnv();
    expect(env.PORT).toBe(8080);
    expect(env.DELIVERY_MAX_ATTEMPTS).toBe(6);
    expect(env.DELIVERY_RETRY_DELAYS_MS).toEqual([1000, 5000, 30000, 120000, 600000]);
    expect(env.APP_ENCRYPTION_KEY).toHaveLength(32);
  });

  it('rejects an encryption key that does not decode to 32 bytes', () => {
    expect(() => testEnv({ APP_ENCRYPTION_KEY: 'abc123' })).toThrow(ConfigurationError);
    try {
      testEnv({ APP_ENCRYPTION_KEY: 'abc123' });
    } catch (error) {
      const issues = (error as ConfigurationError).issues.join(' ');
      expect(issues).toContain('APP_ENCRYPTION_KEY');
      expect(issues).toContain('32 bytes');
      // The rejected value must never appear in the error output.
      expect(issues).not.toContain('abc123');
    }
  });

  it('accepts a base64 encryption key of the right length', () => {
    const base64 = Buffer.from(TEST_ENCRYPTION_KEY, 'hex').toString('base64');
    expect(testEnv({ APP_ENCRYPTION_KEY: base64 }).APP_ENCRYPTION_KEY).toHaveLength(32);
  });

  it('requires PUBLIC_BASE_URL to be an absolute http(s) URL', () => {
    expect(() => testEnv({ PUBLIC_BASE_URL: 'telegram.example.com' })).toThrow(ConfigurationError);
    expect(() => testEnv({ PUBLIC_BASE_URL: 'ftp://example.com' })).toThrow(ConfigurationError);
  });

  it('reports every missing required variable at once', () => {
    try {
      loadEnv({} as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (error) {
      const issues = (error as ConfigurationError).issues.join('\n');
      expect(issues).toContain('PUBLIC_BASE_URL');
      expect(issues).toContain('ADMIN_PASSWORD');
      expect(issues).toContain('APP_ENCRYPTION_KEY');
      expect(issues).toContain('SESSION_SECRET');
    }
  });

  it('rejects a session secret shorter than 32 characters', () => {
    expect(() => testEnv({ SESSION_SECRET: 'too-short' })).toThrow(ConfigurationError);
  });
});

describe('secret encryption', () => {
  it('round-trips a value through AES-256-GCM', () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const sealed = encryptSecret(token, KEY);
    expect(sealed).not.toContain(token);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(decryptSecret(sealed, KEY)).toBe(token);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('refuses to decrypt with the wrong key', () => {
    const sealed = encryptSecret('secret', KEY);
    const otherKey = Buffer.alloc(32, 7);
    expect(() => decryptSecret(sealed, otherKey)).toThrow(/Unable to decrypt/);
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const sealed = encryptSecret('secret', KEY);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow(/Unable to decrypt/);
  });
});

describe('token redaction and masking', () => {
  it('masks a bot token for display without revealing the secret half', () => {
    const masked = maskBotToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    expect(masked).toBe('123456789:••••••Dsaw');
    expect(masked).not.toContain('AAHdqTcv');
  });

  it('masks arbitrary secrets down to their last characters', () => {
    expect(maskTail('supersecretvalue')).toBe('••••alue');
    expect(maskTail('ab')).toBe('••••');
  });

  it('strips bot tokens out of free-form log text', () => {
    const text = 'Telegram said: bad token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const redacted = redactSecrets(text);
    expect(redacted).toContain('123456789:[REDACTED]');
    expect(redacted).not.toContain('AAHdqTcv');
  });
});

describe('HMAC webhook signing', () => {
  const secret = 'destination-signing-secret';
  const timestamp = '1700000000';
  const body = JSON.stringify({ gateway: { deliveryId: 'dlv_1' }, update: { update_id: 1 } });

  it('produces a sha256-prefixed signature over "timestamp.body"', () => {
    const signature = signDeliveryBody(secret, timestamp, body);
    expect(signature.startsWith('sha256=')).toBe(true);
    expect(signature).toHaveLength('sha256='.length + 64);
  });

  it('verifies its own signature', () => {
    const signature = signDeliveryBody(secret, timestamp, body);
    expect(verifyDeliverySignature(secret, timestamp, body, signature)).toBe(true);
  });

  it('rejects a modified body, timestamp or secret', () => {
    const signature = signDeliveryBody(secret, timestamp, body);
    expect(verifyDeliverySignature(secret, timestamp, `${body} `, signature)).toBe(false);
    expect(verifyDeliverySignature(secret, '1700000001', body, signature)).toBe(false);
    expect(verifyDeliverySignature('other-secret', timestamp, body, signature)).toBe(false);
  });

  it('compares strings without leaking length mismatches as exceptions', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Telegram update classification', () => {
  it('classifies a plain message and extracts the chat id', () => {
    const result = classifyUpdate({
      update_id: 10,
      message: {
        message_id: 1,
        chat: { id: -100123, type: 'group' },
        from: { id: 55 },
        text: 'hi',
      },
    });
    expect(result.eventType).toBe('message');
    expect(result.updateId).toBe(10);
    expect(result.chatId).toBe('-100123');
    expect(result.userId).toBe('55');
    expect(result.isUnknownType).toBe(false);
  });

  it('classifies a callback query through its nested message', () => {
    const result = classifyUpdate({
      update_id: 11,
      callback_query: { id: 'cb1', from: { id: 7 }, message: { chat: { id: 99 } }, data: 'x' },
    });
    expect(result.eventType).toBe('callback_query');
    expect(result.chatId).toBe('99');
  });

  it.each([
    ['edited_message', { edited_message: { chat: { id: 1 } } }],
    ['channel_post', { channel_post: { chat: { id: 2 } } }],
    ['my_chat_member', { my_chat_member: { chat: { id: 3 } } }],
    ['chat_join_request', { chat_join_request: { chat: { id: 4 } } }],
    ['message_reaction', { message_reaction: { chat: { id: 5 } } }],
    ['poll_answer', { poll_answer: { poll_id: 'p', user: { id: 6 } } }],
    ['inline_query', { inline_query: { id: 'q', from: { id: 7 } } }],
  ])('classifies %s', (expected, body) => {
    expect(classifyUpdate({ update_id: 1, ...body }).eventType).toBe(expected);
  });

  it('does not crash on an unknown future update type', () => {
    const result = classifyUpdate({ update_id: 12, some_future_thing: { chat: { id: 5 } } });
    expect(result.eventType).toBe('unknown');
    expect(result.isUnknownType).toBe(true);
    expect(result.updateId).toBe(12);
  });

  it('does not crash on malformed payloads', () => {
    for (const payload of [null, undefined, 'string', 42, []]) {
      expect(() => classifyUpdate(payload)).not.toThrow();
    }
    expect(classifyUpdate(null).eventType).toBe('unknown');
  });
});

describe('route matching', () => {
  const base: MatchableRoute = {
    id: 'rte_1',
    enabled: true,
    updateTypes: ['message'],
    priority: 100,
    chatIdFilter: null,
    destinationId: 'dst_1',
    destinationEnabled: true,
  };

  it('matches on update type', () => {
    expect(routeMatches(base, { eventType: 'message', chatId: null })).toBe(true);
    expect(routeMatches(base, { eventType: 'callback_query', chatId: null })).toBe(false);
  });

  it('matches every type through the wildcard', () => {
    const wildcard = { ...base, updateTypes: ['*'] };
    expect(routeMatches(wildcard, { eventType: 'poll_answer', chatId: null })).toBe(true);
  });

  it('skips disabled routes and disabled destinations', () => {
    expect(routeMatches({ ...base, enabled: false }, { eventType: 'message', chatId: null })).toBe(
      false,
    );
    expect(
      routeMatches({ ...base, destinationEnabled: false }, { eventType: 'message', chatId: null }),
    ).toBe(false);
  });

  it('applies the chat id filter', () => {
    const filtered = { ...base, chatIdFilter: '123, 456' };
    expect(routeMatches(filtered, { eventType: 'message', chatId: '123' })).toBe(true);
    expect(routeMatches(filtered, { eventType: 'message', chatId: '789' })).toBe(false);
    expect(routeMatches(filtered, { eventType: 'message', chatId: null })).toBe(false);
  });

  it('returns all matches ordered by priority', () => {
    const routes: MatchableRoute[] = [
      { ...base, id: 'rte_b', priority: 200 },
      { ...base, id: 'rte_a', priority: 50 },
      { ...base, id: 'rte_c', updateTypes: ['callback_query'] },
    ];
    const matched = matchRoutes(routes, { eventType: 'message', chatId: null });
    expect(matched.map((route) => route.id)).toEqual(['rte_a', 'rte_b']);
  });
});

describe('retry scheduling', () => {
  const policy = { maxAttempts: 6, delaysMs: [1000, 5000, 30000, 120000, 600000] };

  it('walks the configured backoff schedule', () => {
    expect(nextRetryDelay(1, policy)).toBe(1000);
    expect(nextRetryDelay(2, policy)).toBe(5000);
    expect(nextRetryDelay(5, policy)).toBe(600000);
    // Schedule shorter than maxAttempts: the last delay repeats.
    expect(nextRetryDelay(9, policy)).toBe(600000);
  });

  it('retries transient failures and stops at the attempt limit', () => {
    const now = 1_000_000;
    const first = decideRetry({ attemptsMade: 1, responseStatus: 500, policy, now });
    expect(first.shouldRetry).toBe(true);
    expect(first.nextAttemptAt).toBe(now + 1000);

    const last = decideRetry({ attemptsMade: 6, responseStatus: 500, policy, now });
    expect(last.shouldRetry).toBe(false);
  });

  it('retries transport failures with no HTTP status', () => {
    expect(decideRetry({ attemptsMade: 1, responseStatus: null, policy }).shouldRetry).toBe(true);
  });

  it('does not retry permanent 4xx rejections', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(decideRetry({ attemptsMade: 1, responseStatus: status, policy }).shouldRetry).toBe(
        false,
      );
    }
  });

  it('does retry the transient 4xx statuses', () => {
    for (const status of [408, 425, 429]) {
      expect(isRetryableStatus(status)).toBe(true);
      expect(decideRetry({ attemptsMade: 1, responseStatus: status, policy }).shouldRetry).toBe(
        true,
      );
    }
  });
});

/* ------------------------------------------------------------ SSRF ------ */

describe('destination URL policy', () => {
  it('accepts http and https URLs', () => {
    expect(assertSafeDestinationUrl('http://python-worker:8000/events').hostname).toBe(
      'python-worker',
    );
    expect(assertSafeDestinationUrl('https://example.com/hook').protocol).toBe('https:');
  });

  it('rejects dangerous schemes', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com']) {
      expect(() => assertSafeDestinationUrl(url)).toThrow();
    }
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() => assertSafeDestinationUrl('https://user:pass@example.com/hook')).toThrow(
      /Credentials/,
    );
  });

  it('identifies private, loopback and link-local addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('treats public addresses as public', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});
