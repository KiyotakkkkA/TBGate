import { TELEGRAM_UPDATE_TYPES, UNKNOWN_UPDATE_TYPE, isKnownUpdateType } from '@tg-gateway/shared';

export interface ClassifiedUpdate {
  /** The Telegram update type, or `unknown` for a field this build does not know yet. */
  eventType: string;
  updateId: number | null;
  chatId: string | null;
  userId: string | null;
  /** True when the payload carried a field outside the known update-type list. */
  isUnknownType: boolean;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/**
 * Digs out a chat identifier from whatever shape the update carries. Different update
 * types nest the chat at different depths, so we probe the known locations in order.
 */
function extractChatId(payload: JsonObject): string | null {
  const candidates: unknown[] = [
    payload.chat,
    asObject(payload.message)?.chat,
    asObject(payload.reply_to_message)?.chat,
    payload.sender_chat,
  ];
  for (const candidate of candidates) {
    const chat = asObject(candidate);
    const id = chat?.id;
    if (typeof id === 'number' || typeof id === 'string') return String(id);
  }
  // message_reaction / chat_member / poll_answer style payloads use a flat chat object,
  // and inline queries have no chat at all.
  const flatChat = asObject(payload.chat);
  if (flatChat && (typeof flatChat.id === 'number' || typeof flatChat.id === 'string')) {
    return String(flatChat.id);
  }
  const voterChat = asObject(payload.voter_chat);
  if (voterChat && (typeof voterChat.id === 'number' || typeof voterChat.id === 'string')) {
    return String(voterChat.id);
  }
  return null;
}

function extractUserId(payload: JsonObject): string | null {
  const candidates: unknown[] = [payload.from, payload.user, asObject(payload.message)?.from];
  for (const candidate of candidates) {
    const user = asObject(candidate);
    const id = user?.id;
    if (typeof id === 'number' || typeof id === 'string') return String(id);
  }
  return null;
}

/**
 * Reusable classifier for any Telegram Update. Never throws: an unrecognised or malformed
 * payload is classified as `unknown` so a new Telegram feature cannot take the gateway down.
 */
export function classifyUpdate(update: unknown): ClassifiedUpdate {
  const root = asObject(update);
  if (!root) {
    return {
      eventType: UNKNOWN_UPDATE_TYPE,
      updateId: null,
      chatId: null,
      userId: null,
      isUnknownType: true,
    };
  }

  const updateId = typeof root.update_id === 'number' ? root.update_id : null;

  let eventType: string | null = null;
  let body: JsonObject | null = null;

  for (const type of TELEGRAM_UPDATE_TYPES) {
    if (root[type] !== undefined && root[type] !== null) {
      eventType = type;
      body = asObject(root[type]);
      break;
    }
  }

  if (!eventType) {
    // Unknown field: keep the raw key so operators can see what Telegram sent.
    const extraKey = Object.keys(root).find((key) => key !== 'update_id');
    if (extraKey && !isKnownUpdateType(extraKey)) {
      body = asObject(root[extraKey]);
    }
    return {
      eventType: UNKNOWN_UPDATE_TYPE,
      updateId,
      chatId: body ? extractChatId(body) : null,
      userId: body ? extractUserId(body) : null,
      isUnknownType: true,
    };
  }

  return {
    eventType,
    updateId,
    chatId: body ? extractChatId(body) : null,
    userId: body ? extractUserId(body) : null,
    isUnknownType: false,
  };
}
