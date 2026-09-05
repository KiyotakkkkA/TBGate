export interface RetryPolicy {
  maxAttempts: number;
  /** Backoff steps in milliseconds, applied after attempt 1, 2, 3, ... */
  delaysMs: number[];
}

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  nextAttemptAt: number;
}

/**
 * Backoff for the attempt that just failed. The first attempt runs immediately; the
 * configured delays are then applied in order, with the last delay repeating if the
 * schedule is shorter than `maxAttempts`.
 */
export function nextRetryDelay(attemptsMade: number, policy: RetryPolicy): number {
  if (policy.delaysMs.length === 0) return 0;
  const index = Math.min(attemptsMade - 1, policy.delaysMs.length - 1);
  return policy.delaysMs[Math.max(index, 0)] ?? 0;
}

/** HTTP statuses worth retrying: transient server errors, throttling and timeouts. */
export function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return status === 408 || status === 425 || status === 429;
}

export interface FailureContext {
  attemptsMade: number;
  /** HTTP status of the failed attempt, or null for a transport-level failure. */
  responseStatus: number | null;
  policy: RetryPolicy;
  now?: number;
}

/**
 * Decides whether a failed delivery is retried. Permanent 4xx responses (other than the
 * retryable ones) are treated as a rejection by the destination and are not retried -
 * retrying a 404 or a 401 forever only produces noise.
 */
export function decideRetry(context: FailureContext): RetryDecision {
  const now = context.now ?? Date.now();
  const exhausted = context.attemptsMade >= context.policy.maxAttempts;

  const permanent =
    context.responseStatus !== null &&
    context.responseStatus >= 400 &&
    context.responseStatus < 500 &&
    !isRetryableStatus(context.responseStatus);

  if (exhausted || permanent) {
    return { shouldRetry: false, delayMs: 0, nextAttemptAt: now };
  }

  const delayMs = nextRetryDelay(context.attemptsMade, context.policy);
  return { shouldRetry: true, delayMs, nextAttemptAt: now + delayMs };
}
