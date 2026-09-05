import { TelegramApiError } from '../lib/errors.js';
import { redactSecrets } from '../lib/crypto.js';

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export interface SetWebhookOptions {
  url: string;
  secretToken: string;
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
  maxConnections?: number;
}

export interface TelegramClientOptions {
  apiBaseUrl: string;
  timeoutMs: number;
  /** Injected in tests so no test ever touches the real Telegram API. */
  fetchImpl?: typeof fetch;
}

/**
 * The single place in the codebase that speaks HTTP to the Telegram Bot API.
 * Tokens are passed per call and never stored on the instance or logged.
 */
export class TelegramClient {
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<T>(token: string, method: string, payload?: unknown): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${token}/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: payload === undefined ? '{}' : JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new TelegramApiError(
        aborted
          ? `Telegram API request timed out after ${this.timeoutMs}ms (${method})`
          : `Telegram API request failed (${method}): ${redactSecrets(reason)}`,
        null,
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    let body: TelegramResponse<T>;
    try {
      body = (await response.json()) as TelegramResponse<T>;
    } catch {
      throw new TelegramApiError(
        `Telegram API returned a non-JSON response (${method}, HTTP ${response.status})`,
        response.status,
        null,
      );
    }

    if (!body.ok || body.result === undefined) {
      const description = body.description ?? `HTTP ${response.status}`;
      throw new TelegramApiError(
        `Telegram API error (${method}): ${redactSecrets(description)}`,
        body.error_code ?? response.status,
        description,
      );
    }
    return body.result;
  }

  getMe(token: string): Promise<TelegramUser> {
    return this.call<TelegramUser>(token, 'getMe');
  }

  setWebhook(token: string, options: SetWebhookOptions): Promise<boolean> {
    return this.call<boolean>(token, 'setWebhook', {
      url: options.url,
      secret_token: options.secretToken,
      ...(options.allowedUpdates && options.allowedUpdates.length > 0
        ? { allowed_updates: options.allowedUpdates }
        : {}),
      ...(options.dropPendingUpdates ? { drop_pending_updates: true } : {}),
      ...(options.maxConnections ? { max_connections: options.maxConnections } : {}),
    });
  }

  deleteWebhook(token: string, dropPendingUpdates = false): Promise<boolean> {
    return this.call<boolean>(token, 'deleteWebhook', {
      drop_pending_updates: dropPendingUpdates,
    });
  }

  getWebhookInfo(token: string): Promise<TelegramWebhookInfo> {
    return this.call<TelegramWebhookInfo>(token, 'getWebhookInfo');
  }

  sendMessage(token: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.call(token, 'sendMessage', payload);
  }

  sendPhoto(token: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.call(token, 'sendPhoto', payload);
  }

  sendDocument(token: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.call(token, 'sendDocument', payload);
  }

  editMessageText(token: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.call(token, 'editMessageText', payload);
  }

  deleteMessage(token: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.call(token, 'deleteMessage', payload);
  }

  answerCallbackQuery(token: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.call(token, 'answerCallbackQuery', payload);
  }
}
