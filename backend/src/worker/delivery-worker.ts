import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { destinations, telegramEvents, type DeliveryRow } from '../db/schema.js';
import { signDeliveryBody } from '../lib/crypto.js';
import { generateId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { assertDestinationAllowed, type SsrfPolicy } from '../security/ssrf.js';
import type { DestinationService } from '../services/destinations.js';
import type { AttemptOutcome, ClaimedDelivery, DeliveryService } from '../services/deliveries.js';
import { decideRetry, type RetryPolicy } from './retry.js';

export interface GatewayEnvelope {
  gateway: {
    deliveryId: string;
    botId: string;
    botName: string;
    eventType: string;
    receivedAt: string;
    routeId: string | null;
    destinationId: string | null;
    attempt: number;
    replay: boolean;
    test: boolean;
  };
  update: unknown;
}

export interface DeliveryWorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  defaultTimeoutMs: number;
  maxResponseBodyBytes: number;
  retry: RetryPolicy;
  ssrf: SsrfPolicy;
  userAgent: string;
}

/**
 * Builds the outbound body. The original Telegram update is preserved byte-for-byte
 * under `update`; gateway metadata lives in a sibling `gateway` object.
 */
export function buildEnvelope(
  delivery: Pick<
    DeliveryRow,
    | 'id'
    | 'botId'
    | 'eventType'
    | 'routeId'
    | 'destinationId'
    | 'isReplay'
    | 'isTest'
    | 'attemptCount'
  >,
  botName: string,
  receivedAt: string,
  update: unknown,
): GatewayEnvelope {
  return {
    gateway: {
      deliveryId: delivery.id,
      botId: delivery.botId,
      botName,
      eventType: delivery.eventType,
      receivedAt,
      routeId: delivery.routeId,
      destinationId: delivery.destinationId,
      attempt: delivery.attemptCount + 1,
      replay: delivery.isReplay,
      test: delivery.isTest,
    },
    update,
  };
}

/**
 * Database-backed delivery queue. Pending work lives in the `deliveries` table, so a
 * restart resumes exactly where the previous process stopped - no external broker.
 */
export class DeliveryWorker {
  private readonly workerId = generateId('wrk', 8);
  private running = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private loopPromise: Promise<unknown> | null = null;

  constructor(
    private readonly db: Database,
    private readonly deliveryService: DeliveryService,
    private readonly destinationService: DestinationService,
    private readonly config: DeliveryWorkerConfig,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get id(): string {
    return this.workerId;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.log.info({ workerId: this.workerId }, 'Delivery worker started');
    this.scheduleNextTick(0);
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.loopPromise = this.tick()
        .catch((error: unknown) => {
          this.log.error({ err: error }, 'Delivery worker tick failed');
        })
        .finally(() => {
          this.scheduleNextTick(this.config.pollIntervalMs);
        });
    }, delayMs);
  }

  /** Public for tests: process one batch of due deliveries. */
  async tick(): Promise<number> {
    const capacity = this.config.concurrency - this.inFlight;
    if (capacity <= 0) return 0;

    const claimed = await this.deliveryService.claimDue(this.workerId, capacity);
    if (claimed.length === 0) return 0;

    this.inFlight += claimed.length;
    try {
      await Promise.all(claimed.map((item) => this.process(item)));
    } finally {
      this.inFlight -= claimed.length;
    }
    return claimed.length;
  }

  private async process(item: ClaimedDelivery): Promise<void> {
    const { delivery } = item;
    const attempt = delivery.attemptCount + 1;
    const log = this.log.child({
      deliveryId: delivery.id,
      botId: delivery.botId,
      routeId: delivery.routeId,
      destinationId: delivery.destinationId,
      attempt,
    });

    const [eventRow] = await this.db
      .select({ receivedAt: telegramEvents.receivedAt })
      .from(telegramEvents)
      .where(eq(telegramEvents.id, delivery.eventId))
      .limit(1);

    let update: unknown;
    try {
      update = JSON.parse(item.eventPayload);
    } catch {
      update = { raw: item.eventPayload };
    }

    const envelope = buildEnvelope(
      delivery,
      item.botName,
      (eventRow?.receivedAt ?? new Date()).toISOString(),
      update,
    );
    const rawBody = JSON.stringify(envelope);

    const destinationRow = delivery.destinationId
      ? (
          await this.db
            .select()
            .from(destinations)
            .where(eq(destinations.id, delivery.destinationId))
            .limit(1)
        )[0]
      : undefined;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': this.config.userAgent,
      accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      'x-tg-gateway-delivery-id': delivery.id,
      'x-tg-gateway-timestamp': timestamp,
      'x-tg-gateway-event-type': delivery.eventType,
      'x-tg-gateway-bot-id': delivery.botId,
      'x-tg-gateway-attempt': String(attempt),
    };
    if (delivery.isTest) headers['x-tg-gateway-test'] = 'true';
    for (const [key, value] of Object.entries(destinationRow?.headers ?? {})) {
      headers[key] = value;
    }

    if (destinationRow?.signingEnabled) {
      const secret = this.destinationService.revealSigningSecret(destinationRow);
      if (secret) {
        headers['x-tg-gateway-signature'] = signDeliveryBody(secret, timestamp, rawBody);
      }
    }

    const timeoutMs = destinationRow?.timeoutMs ?? this.config.defaultTimeoutMs;
    const url = destinationRow?.url ?? delivery.destinationUrl;
    const method = destinationRow?.method ?? delivery.destinationMethod;

    const startedAt = Date.now();
    const outcome = await this.send({ url, method, headers, body: rawBody, timeoutMs, attempt });
    outcome.durationMs = Date.now() - startedAt;

    // Signature and auth headers must never reach the delivery log.
    const loggedHeaders = { ...headers };
    delete loggedHeaders['x-tg-gateway-signature'];
    for (const key of Object.keys(loggedHeaders)) {
      if (key === 'authorization' || key.endsWith('-key') || key.endsWith('-token')) {
        loggedHeaders[key] = '[REDACTED]';
      }
    }
    outcome.requestHeaders = loggedHeaders;

    if (outcome.succeeded) {
      await this.deliveryService.recordAttempt(delivery.id, outcome, {
        status: 'success',
        nextAttemptAt: null,
      });
      log.info(
        { responseStatus: outcome.responseStatus, durationMs: outcome.durationMs },
        'Delivery succeeded',
      );
      return;
    }

    const decision = decideRetry({
      attemptsMade: attempt,
      responseStatus: outcome.responseStatus,
      policy: { maxAttempts: delivery.maxAttempts, delaysMs: this.config.retry.delaysMs },
    });

    await this.deliveryService.recordAttempt(delivery.id, outcome, {
      status: decision.shouldRetry ? 'retrying' : 'failed',
      nextAttemptAt: decision.shouldRetry ? new Date(decision.nextAttemptAt) : null,
    });

    log.warn(
      {
        responseStatus: outcome.responseStatus,
        durationMs: outcome.durationMs,
        errorCode: outcome.errorCode,
        willRetry: decision.shouldRetry,
        retryInMs: decision.delayMs,
      },
      decision.shouldRetry ? 'Delivery failed, scheduled for retry' : 'Delivery failed permanently',
    );
  }

  private async send(input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    attempt: number;
  }): Promise<AttemptOutcome> {
    const base: AttemptOutcome = {
      attempt: input.attempt,
      durationMs: 0,
      responseStatus: null,
      responseBody: null,
      errorCode: null,
      errorMessage: null,
      succeeded: false,
      requestHeaders: null,
    };

    try {
      await assertDestinationAllowed(input.url, this.config.ssrf);
    } catch (error) {
      return {
        ...base,
        errorCode: 'DESTINATION_URL_REJECTED',
        errorMessage: error instanceof Error ? error.message : 'Destination URL rejected',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await this.fetchImpl(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: controller.signal,
        redirect: 'manual',
      });

      const body = await this.readBody(response);
      const succeeded = response.status >= 200 && response.status < 300;
      return {
        ...base,
        responseStatus: response.status,
        responseBody: body,
        succeeded,
        errorCode: succeeded ? null : 'HTTP_ERROR',
        errorMessage: succeeded ? null : `Destination responded with HTTP ${response.status}`,
      };
    } catch (error) {
      return { ...base, ...classifyTransportError(error, input.timeoutMs) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBody(response: Response): Promise<string | null> {
    if (this.config.maxResponseBodyBytes === 0) return null;
    try {
      const text = await response.text();
      if (text.length === 0) return null;
      return text.length > this.config.maxResponseBodyBytes
        ? `${text.slice(0, this.config.maxResponseBodyBytes)}...[truncated]`
        : text;
    } catch {
      return null;
    }
  }

  /** Graceful shutdown: stop claiming, let in-flight attempts finish, release leases. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);

    const deadline = Date.now() + 15_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.deliveryService.releaseWorkerLeases(this.workerId).catch(() => undefined);
    this.log.info({ workerId: this.workerId }, 'Delivery worker stopped');
  }
}

interface TransportFailure {
  errorCode: string;
  errorMessage: string;
}

/** Maps fetch/undici failures onto stable, operator-readable error codes. */
export function classifyTransportError(error: unknown, timeoutMs: number): TransportFailure {
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      errorCode: 'TIMEOUT',
      errorMessage: `Destination request timed out after ${timeoutMs}ms`,
    };
  }

  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: string } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);

  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { errorCode: 'DNS_ERROR', errorMessage: `DNS lookup failed: ${message}` };
    case 'ECONNREFUSED':
      return { errorCode: 'CONNECTION_REFUSED', errorMessage: `Connection refused: ${message}` };
    case 'ECONNRESET':
      return { errorCode: 'CONNECTION_RESET', errorMessage: `Connection reset: ${message}` };
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return { errorCode: 'TIMEOUT', errorMessage: `Connection timed out: ${message}` };
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return { errorCode: 'TLS_ERROR', errorMessage: `TLS verification failed: ${message}` };
    default:
      return { errorCode: 'CONNECTION_ERROR', errorMessage: message };
  }
}
