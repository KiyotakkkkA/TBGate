import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Short, URL-safe, sortable-enough identifiers: a base36 millisecond timestamp
 * followed by random characters. Prefixed per entity so IDs are self-describing in logs.
 */
export function generateId(prefix: string, randomLength = 12): string {
  const time = Date.now().toString(36);
  const bytes = randomBytes(randomLength);
  let random = '';
  for (let i = 0; i < randomLength; i += 1) {
    random += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return `${prefix}_${time}${random}`;
}

export const newBotId = () => generateId('bot');
export const newDestinationId = () => generateId('dst');
export const newRouteId = () => generateId('rte');
export const newEventId = () => generateId('evt');
export const newDeliveryId = () => generateId('dlv');
export const newAttemptId = () => generateId('att');
export const newUserId = () => generateId('usr');
export const newSessionId = () => generateId('ses');
export const newApiKeyId = () => generateId('key');
export const newRequestId = () => generateId('req', 10);
