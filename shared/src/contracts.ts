import { z } from 'zod';
import { API_SCOPES, USER_ROLES } from './roles.js';
import { TELEGRAM_UPDATE_TYPES, WILDCARD_UPDATE_TYPE } from './telegram.js';

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const updateTypeSchema = z.enum([WILDCARD_UPDATE_TYPE, ...TELEGRAM_UPDATE_TYPES]);

/** http/https only, no embedded credentials. Network-level SSRF policy is enforced server side. */
export const destinationUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Must be an absolute URL' });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'Only http:// and https:// URLs are allowed' });
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({ code: 'custom', message: 'Credentials in the URL are not allowed' });
    }
  });

export const headersSchema = z
  .record(z.string().trim().min(1).max(128), z.string().max(2048))
  .refine((headers) => Object.keys(headers).length <= 25, 'At most 25 headers');

/* ------------------------------------------------------------------ auth */

export const loginSchema = z.object({
  username: trimmed(1, 64),
  password: z.string().min(1).max(512),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(10, 'Password must be at least 10 characters').max(512),
});

/* ----------------------------------------------------------------- users */

export const createUserSchema = z.object({
  username: trimmed(3, 64).regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dot, underscore, hyphen'),
  password: z.string().min(10, 'Password must be at least 10 characters').max(512),
  role: z.enum(USER_ROLES).default('manager'),
  displayName: trimmed(0, 120).optional(),
});

export const updateUserSchema = z.object({
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(['active', 'blocked']).optional(),
  displayName: trimmed(0, 120).optional(),
});

export const resetUserPasswordSchema = z.object({
  newPassword: z.string().min(10, 'Password must be at least 10 characters').max(512),
});

/* ------------------------------------------------------------------ bots */

export const createBotSchema = z.object({
  name: trimmed(1, 120),
  token: trimmed(10, 200),
  allowedUpdates: z.array(z.enum(TELEGRAM_UPDATE_TYPES)).max(40).default([]),
  enabled: z.boolean().default(true),
});

export const updateBotSchema = z.object({
  name: trimmed(1, 120).optional(),
  token: trimmed(10, 200).optional(),
  allowedUpdates: z.array(z.enum(TELEGRAM_UPDATE_TYPES)).max(40).optional(),
  enabled: z.boolean().optional(),
  ownerId: z.string().min(1).nullable().optional(),
});

/* ---------------------------------------------------------- destinations */

export const createDestinationSchema = z.object({
  name: trimmed(1, 120),
  url: destinationUrlSchema,
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(500).max(120_000).optional(),
  headers: headersSchema.optional(),
  signingEnabled: z.boolean().default(true),
  /** Provide to set an explicit signing secret; omit to auto-generate one. */
  signingSecret: z.string().min(16).max(256).optional(),
});

export const updateDestinationSchema = createDestinationSchema.partial().extend({
  rotateSigningSecret: z.boolean().optional(),
  ownerId: z.string().min(1).nullable().optional(),
});

/* ---------------------------------------------------------------- routes */

export const createRouteSchema = z.object({
  name: trimmed(1, 120),
  destinationId: z.string().min(1),
  updateTypes: z.array(updateTypeSchema).min(1, 'Select at least one update type').max(40),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10_000).default(100),
  /** Optional additional filter on the chat id of the incoming update. */
  chatIdFilter: z.string().trim().max(64).optional(),
});

export const updateRouteSchema = createRouteSchema.partial();

/* -------------------------------------------------------------- api keys */

export const createApiKeySchema = z.object({
  name: trimmed(1, 120),
  scopes: z.array(z.enum(API_SCOPES)).min(1, 'Select at least one scope'),
  expiresAt: z.string().datetime().nullable().optional(),
});

/* ------------------------------------------------------------- telegram out */

export const sendMessageSchema = z
  .object({
    chat_id: z.union([z.string().min(1), z.number()]),
    text: z.string().min(1).max(4096),
  })
  .loose();

/* --------------------------------------------------------------- queries */

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const eventsQuerySchema = listQuerySchema.extend({
  botId: z.string().optional(),
  eventType: z.string().optional(),
  updateId: z.coerce.number().int().optional(),
  chatId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const deliveriesQuerySchema = listQuerySchema.extend({
  botId: z.string().optional(),
  routeId: z.string().optional(),
  destinationId: z.string().optional(),
  status: z.enum(['pending', 'processing', 'success', 'failed', 'retrying']).optional(),
  eventId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type CreateBotInput = z.infer<typeof createBotSchema>;
export type UpdateBotInput = z.infer<typeof updateBotSchema>;
export type CreateDestinationInput = z.infer<typeof createDestinationSchema>;
export type UpdateDestinationInput = z.infer<typeof updateDestinationSchema>;
export type CreateRouteInput = z.infer<typeof createRouteSchema>;
export type UpdateRouteInput = z.infer<typeof updateRouteSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
export type DeliveriesQuery = z.infer<typeof deliveriesQuerySchema>;
