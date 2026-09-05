import type { Logger } from '../lib/logger.js';
import type { AuthService } from '../services/auth.js';
import type { DeliveryService } from '../services/deliveries.js';
import type { EventService } from '../services/events.js';

export interface CleanupConfig {
  eventRetentionDays: number;
  deliveryRetentionDays: number;
  intervalHours: number;
}

const DAY_MS = 86_400_000;

/**
 * Periodic retention job. Runs once shortly after boot and then on the configured
 * interval. A retention of 0 days disables pruning for that entity.
 */
export class CleanupJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly events: EventService,
    private readonly deliveries: DeliveryService,
    private readonly auth: AuthService,
    private readonly config: CleanupConfig,
    private readonly log: Logger,
  ) {}

  start(): void {
    const intervalMs = this.config.intervalHours * 3_600_000;
    // First sweep 60s after boot so it never competes with startup work.
    this.timer = setTimeout(() => {
      void this.runOnce();
      this.timer = setInterval(() => void this.runOnce(), intervalMs);
    }, 60_000);
  }

  async runOnce(): Promise<{ events: number; deliveries: number; sessions: number }> {
    const now = Date.now();
    let purgedEvents = 0;
    let purgedDeliveries = 0;
    let purgedSessions = 0;

    try {
      if (this.config.deliveryRetentionDays > 0) {
        purgedDeliveries = await this.deliveries.purgeOlderThan(
          new Date(now - this.config.deliveryRetentionDays * DAY_MS),
        );
      }
      if (this.config.eventRetentionDays > 0) {
        purgedEvents = await this.events.purgeOlderThan(
          new Date(now - this.config.eventRetentionDays * DAY_MS),
        );
      }
      purgedSessions = await this.auth.purgeExpired();

      if (purgedEvents + purgedDeliveries + purgedSessions > 0) {
        this.log.info(
          { events: purgedEvents, deliveries: purgedDeliveries, sessions: purgedSessions },
          'Retention cleanup completed',
        );
      }
    } catch (error) {
      this.log.error({ err: error }, 'Retention cleanup failed');
    }

    return { events: purgedEvents, deliveries: purgedDeliveries, sessions: purgedSessions };
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
