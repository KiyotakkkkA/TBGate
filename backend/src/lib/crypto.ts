import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const CIPHERTEXT_VERSION = 'v1';

export interface SealedSecret {
  /** `v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>` */
  ciphertext: string;
}

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/**
 * Authenticated encryption for values that must never be readable from a database dump.
 * The master key lives only in the environment; the database stores version, IV, tag and
 * ciphertext packed into a single opaque string.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new EncryptionError('Encryption key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHERTEXT_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(packed: string, key: Buffer): string {
  if (key.length !== 32) throw new EncryptionError('Encryption key must be 32 bytes');
  const parts = packed.split('.');
  if (parts.length !== 4 || parts[0] !== CIPHERTEXT_VERSION) {
    throw new EncryptionError('Malformed ciphertext');
  }
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // Wrong master key or tampered row - never surface the underlying detail.
    throw new EncryptionError('Unable to decrypt stored secret (wrong APP_ENCRYPTION_KEY?)');
  }
}

/* ------------------------------------------------------------------ HMAC */

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Signature over `${timestamp}.${rawBody}` using the per-destination secret.
 * Documented in docs/SECURITY.md and mirrored by the Node/Python verification samples.
 */
export function buildSignaturePayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function signDeliveryBody(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${hmacSha256Hex(secret, buildSignaturePayload(timestamp, rawBody))}`;
}

export function verifyDeliverySignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  return safeEqual(signDeliveryBody(secret, timestamp, rawBody), signature);
}

export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/* ---------------------------------------------------------------- tokens */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHmac('sha256', 'tg-gateway-digest').update(value, 'utf8').digest('hex');
}

/* ------------------------------------------------------------- redaction */

const BOT_TOKEN_PATTERN = /\b(\d{6,12}):([A-Za-z0-9_-]{20,})\b/g;

/** Masks a Telegram bot token for display: `123456789:AAE...XYZ` -> `123456789:••••XYZ`. */
export function maskBotToken(token: string): string {
  const [id, secret] = token.split(':');
  if (!id || !secret) return '••••';
  const tail = secret.slice(-4);
  return `${id}:••••••${tail}`;
}

export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return '••••';
  return `••••${value.slice(-visible)}`;
}

/** Strips anything that looks like a bot token out of arbitrary text before it is logged. */
export function redactSecrets(input: string): string {
  return input.replace(BOT_TOKEN_PATTERN, (_match, id: string) => `${id}:[REDACTED]`);
}
