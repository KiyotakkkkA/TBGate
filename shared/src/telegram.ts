/**
 * Canonical list of Telegram update types the gateway knows how to classify and route.
 * Unknown/new types are still accepted at runtime and classified as `unknown`.
 */
export const TELEGRAM_UPDATE_TYPES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'message_reaction',
  'message_reaction_count',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'purchased_paid_media',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
] as const;

export type TelegramUpdateType = (typeof TELEGRAM_UPDATE_TYPES)[number];

/** Pseudo update type used when Telegram ships a field we do not know yet. */
export const UNKNOWN_UPDATE_TYPE = 'unknown';

/** Wildcard accepted in a route's `updateTypes` to match every event. */
export const WILDCARD_UPDATE_TYPE = '*';

export const TELEGRAM_UPDATE_TYPE_SET: ReadonlySet<string> = new Set(TELEGRAM_UPDATE_TYPES);

export function isKnownUpdateType(value: string): value is TelegramUpdateType {
  return TELEGRAM_UPDATE_TYPE_SET.has(value);
}

/** Telegram Bot API methods exposed through the typed outbound endpoints. */
export const TELEGRAM_SEND_METHODS = [
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'editMessageText',
  'deleteMessage',
  'answerCallbackQuery',
] as const;

export type TelegramSendMethod = (typeof TELEGRAM_SEND_METHODS)[number];

/**
 * Methods the generic proxy (`/api/v1/bots/:botId/telegram/:method`) refuses to forward,
 * because they would let an API client take over webhook wiring or leak the token setup.
 */
export const TELEGRAM_PROXY_DENYLIST: ReadonlySet<string> = new Set([
  'setwebhook',
  'deletewebhook',
  'getwebhookinfo',
  'getupdates',
  'close',
  'logout',
]);
