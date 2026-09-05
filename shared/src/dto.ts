import type { ApiScope, UserRole, UserStatus } from './roles.js';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface SessionUserDto {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
}

export interface UserDto extends SessionUserDto {
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  botCount: number;
}

export type WebhookState = 'not_configured' | 'active' | 'mismatch' | 'error' | 'unknown';

export interface BotDto {
  id: string;
  name: string;
  enabled: boolean;
  ownerId: string | null;
  ownerUsername: string | null;
  telegramBotId: string | null;
  telegramUsername: string | null;
  /** Masked hint only - the real token is never returned to any client. */
  tokenHint: string | null;
  tokenConfigured: boolean;
  allowedUpdates: string[];
  webhookUrl: string;
  webhookState: WebhookState;
  webhookLastError: string | null;
  webhookLastSetAt: string | null;
  routeCount: number;
  eventCount: number;
  lastUpdateAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DestinationDto {
  id: string;
  name: string;
  url: string;
  method: string;
  enabled: boolean;
  timeoutMs: number | null;
  headers: Record<string, string> | null;
  signingEnabled: boolean;
  signingSecretConfigured: boolean;
  /** Last 4 characters of the signing secret, for identification only. */
  signingSecretHint: string | null;
  ownerId: string | null;
  ownerUsername: string | null;
  routeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RouteDto {
  id: string;
  botId: string;
  name: string;
  enabled: boolean;
  updateTypes: string[];
  destinationId: string;
  destinationName: string;
  destinationUrl: string;
  priority: number;
  chatIdFilter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventDto {
  id: string;
  botId: string;
  botName: string;
  telegramUpdateId: number | null;
  eventType: string;
  chatId: string | null;
  receivedAt: string;
  deliveryCount: number;
  isTest: boolean;
}

export interface EventDetailDto extends EventDto {
  payload: unknown;
}

export type DeliveryStatus = 'pending' | 'processing' | 'success' | 'failed' | 'retrying';

export interface DeliveryDto {
  id: string;
  eventId: string;
  botId: string;
  botName: string;
  routeId: string | null;
  routeName: string | null;
  destinationId: string | null;
  destinationName: string | null;
  destinationUrl: string | null;
  eventType: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  responseStatus: number | null;
  durationMs: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  isReplay: boolean;
  replayOfDeliveryId: string | null;
  isTest: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface DeliveryAttemptDto {
  id: string;
  deliveryId: string;
  attempt: number;
  startedAt: string;
  durationMs: number | null;
  responseStatus: number | null;
  responseBody: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  succeeded: boolean;
}

export interface DeliveryDetailDto extends DeliveryDto {
  attempts: DeliveryAttemptDto[];
  requestHeaders: Record<string, string> | null;
}

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  ownerId: string | null;
  ownerUsername: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKeyDto extends ApiKeyDto {
  /** Returned exactly once, at creation time. */
  token: string;
}

export interface DashboardStatsDto {
  bots: { total: number; active: number };
  eventsToday: number;
  deliveriesToday: number;
  failedDeliveriesToday: number;
  pendingDeliveries: number;
  successRate: number | null;
  recentFailures: DeliveryDto[];
  health: {
    status: 'ok' | 'degraded';
    database: boolean;
    worker: boolean;
    publicBaseUrl: string;
    version: string;
    uptimeSeconds: number;
  };
}

export interface SettingsDto {
  appName: string;
  version: string;
  nodeEnv: string;
  publicBaseUrl: string;
  webhookPath: string;
  trustProxy: boolean;
  telegramApiBaseUrl: string;
  database: { driver: string; path: string };
  worker: {
    enabled: boolean;
    concurrency: number;
    timeoutMs: number;
    maxAttempts: number;
    retryDelaysMs: number[];
  };
  retention: { eventDays: number; deliveryDays: number; cleanupIntervalHours: number };
  security: {
    cookieSecure: boolean;
    cookieSameSite: string;
    sessionTtlHours: number;
    allowPrivateDestinations: boolean;
    rateLimitEnabled: boolean;
  };
  uptimeSeconds: number;
}

export interface WebhookInfoDto {
  url: string;
  expectedUrl: string;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
  ipAddress?: string;
  lastErrorDate?: number;
  lastErrorMessage?: string;
  maxConnections?: number;
  allowedUpdates?: string[];
  state: WebhookState;
}
