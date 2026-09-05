# HTTP API

All endpoints live under `/api/v1`. Requests and responses are JSON.

## Authentication

Two mechanisms, both accepted on the read endpoints marked below:

**Session cookie** — used by the admin panel. `POST /api/v1/auth/login` sets an HttpOnly
`tgw_session` cookie plus a readable `tgw_csrf` cookie. Every `POST`/`PATCH`/`DELETE` must
echo the CSRF value in an `X-CSRF-Token` header.

**Gateway API key** — used by downstream services. Send it as
`Authorization: Bearer tgw_…` (or `X-API-Key: tgw_…`). Keys carry scopes and act as their
owner, so a manager's key only reaches that manager's bots.

| Scope              | Grants                                    |
| ------------------ | ----------------------------------------- |
| `bots:read`        | List and read bots                        |
| `telegram:send`    | Call the Telegram API through the gateway |
| `events:read`      | Read stored Telegram updates              |
| `deliveries:read`  | Read delivery records                     |
| `deliveries:retry` | Replay a delivery                         |

## Errors

Every failure returns the same shape, with the HTTP status matching the error class:

```json
{
  "error": {
    "code": "DESTINATION_UNREACHABLE",
    "message": "Destination request timed out",
    "requestId": "req_mtovesip3s54cd6znq",
    "details": { "issues": [{ "path": "url", "message": "Must be an absolute URL" }] }
  }
}
```

`details` is present only for validation errors. `requestId` also appears in the
`X-Request-Id` response header and in the server logs.

| Code                       | Status | Meaning                                                     |
| -------------------------- | ------ | ----------------------------------------------------------- |
| `VALIDATION_ERROR`         | 400    | Payload or query failed schema validation                   |
| `INVALID_CREDENTIALS`      | 401    | Wrong username or password                                  |
| `UNAUTHENTICATED`          | 401    | Missing, expired or unknown session / API key               |
| `ACCOUNT_BLOCKED`          | 403    | The account was blocked by an administrator                 |
| `FORBIDDEN`                | 403    | Authenticated, but not permitted (role, ownership or scope) |
| `CSRF_INVALID`             | 403    | Missing or wrong `X-CSRF-Token` on a mutating request       |
| `NOT_FOUND`                | 404    | No such resource                                            |
| `CONFLICT`                 | 409    | Duplicate bot, taken username, last remaining admin         |
| `RATE_LIMITED`             | 429    | Too many requests                                           |
| `TELEGRAM_TOKEN_INVALID`   | 400    | Telegram rejected the bot token                             |
| `TELEGRAM_API_ERROR`       | 502    | Telegram returned an error or was unreachable               |
| `DESTINATION_URL_REJECTED` | 502    | Destination URL violates the SSRF policy                    |
| `DESTINATION_UNREACHABLE`  | 502    | Destination host could not be resolved                      |
| `ENCRYPTION_ERROR`         | 500    | A stored secret could not be decrypted                      |
| `INTERNAL_ERROR`           | 500    | Unexpected failure (details are logged, not returned)       |

## Rate limiting

Enabled by `API_RATE_LIMIT_ENABLED`. `API_RATE_LIMIT_MAX` requests per
`API_RATE_LIMIT_WINDOW_MS`, counted per API key when one is present and per client IP
otherwise. Sign-in has its own tighter limit (`LOGIN_RATE_LIMIT_MAX` per minute). The
inbound Telegram webhook is always exempt, because Telegram bursts when draining a backlog.

---

# Endpoints

## Health

| Method | Path             | Auth | Description                                        |
| ------ | ---------------- | ---- | -------------------------------------------------- |
| `GET`  | `/health`        | none | Liveness. Always 200 while the process is running. |
| `GET`  | `/ready`         | none | Readiness. 503 if the database is unreachable.     |
| `GET`  | `/api/v1/health` | none | Same payload as `/health`.                         |

```json
{ "status": "ready", "checks": { "database": true, "worker": true }, "version": "1.0.0" }
```

## Authentication

| Method | Path                           | Auth    | Description                            |
| ------ | ------------------------------ | ------- | -------------------------------------- |
| `POST` | `/api/v1/auth/login`           | none    | Sign in; sets session and CSRF cookies |
| `POST` | `/api/v1/auth/logout`          | session | Destroy the current session            |
| `GET`  | `/api/v1/auth/me`              | session | Current user and CSRF token            |
| `POST` | `/api/v1/auth/change-password` | session | Change your own password               |

## Users (admin only)

| Method   | Path                               | Description                                    |
| -------- | ---------------------------------- | ---------------------------------------------- |
| `GET`    | `/api/v1/users`                    | List users with bot counts                     |
| `POST`   | `/api/v1/users`                    | Create a user (`username`, `password`, `role`) |
| `PATCH`  | `/api/v1/users/:id`                | Change `role`, `status` or `displayName`       |
| `POST`   | `/api/v1/users/:id/reset-password` | Set a temporary password; forces a change      |
| `DELETE` | `/api/v1/users/:id`                | Delete a user                                  |

The bootstrap administrator cannot be blocked, demoted or deleted, and no one can block,
demote or delete their own account.

## Bots

| Method   | Path                                | Auth                   | Description                                            |
| -------- | ----------------------------------- | ---------------------- | ------------------------------------------------------ |
| `GET`    | `/api/v1/bots`                      | session or `bots:read` | List accessible bots                                   |
| `POST`   | `/api/v1/bots`                      | session                | Create a bot (verifies the token with `getMe`)         |
| `GET`    | `/api/v1/bots/:botId`               | session or `bots:read` | Bot detail                                             |
| `PATCH`  | `/api/v1/bots/:botId`               | session                | Update name, token, `allowedUpdates`, `enabled`, owner |
| `DELETE` | `/api/v1/bots/:botId`               | session                | Delete the bot and its data                            |
| `POST`   | `/api/v1/bots/:botId/telegram/test` | session                | Call `getMe` and refresh stored identity               |
| `GET`    | `/api/v1/bots/:botId/webhook`       | session                | Live `getWebhookInfo` plus a computed state            |
| `POST`   | `/api/v1/bots/:botId/webhook`       | session                | Register / re-register the webhook                     |
| `DELETE` | `/api/v1/bots/:botId/webhook`       | session                | Remove the webhook at Telegram                         |

```jsonc
// POST /api/v1/bots
{
  "name": "Support Bot",
  "token": "123456789:AA…", // encrypted before storage, never returned
  "allowedUpdates": ["message", "callback_query"],
  "enabled": true,
}
```

Bot responses expose `tokenHint` (`"123456789:••••••wXyZ"`) and `tokenConfigured`. The
token itself is never returned by any endpoint after creation.

## Routes

| Method   | Path                           | Description                                 |
| -------- | ------------------------------ | ------------------------------------------- |
| `GET`    | `/api/v1/bots/:botId/routes`   | Routes for a bot, ordered by priority       |
| `POST`   | `/api/v1/bots/:botId/routes`   | Create a route                              |
| `PATCH`  | `/api/v1/routes/:routeId`      | Update a route                              |
| `DELETE` | `/api/v1/routes/:routeId`      | Delete a route                              |
| `POST`   | `/api/v1/routes/:routeId/test` | Send a synthetic, clearly-marked test event |

```jsonc
{
  "name": "Messages to worker",
  "destinationId": "dst_…",
  "updateTypes": ["message", "edited_message"], // or ["*"] for everything
  "enabled": true,
  "priority": 100, // lower runs first
  "chatIdFilter": "-1001234567890, 42", // optional, comma separated
}
```

## Destinations

| Method   | Path                                     | Description                                             |
| -------- | ---------------------------------------- | ------------------------------------------------------- |
| `GET`    | `/api/v1/destinations`                   | List accessible destinations                            |
| `POST`   | `/api/v1/destinations`                   | Create a destination                                    |
| `GET`    | `/api/v1/destinations/:id`               | Destination detail                                      |
| `PATCH`  | `/api/v1/destinations/:id`               | Update; `rotateSigningSecret: true` re-rolls the secret |
| `DELETE` | `/api/v1/destinations/:id`               | Delete (its routes go with it)                          |
| `POST`   | `/api/v1/destinations/:id/reveal-secret` | Return the signing secret in plaintext                  |

```jsonc
{
  "name": "Python worker",
  "url": "http://python-worker:8000/events", // http/https only, no embedded credentials
  "method": "POST",
  "enabled": true,
  "timeoutMs": 10000, // optional; falls back to DELIVERY_TIMEOUT_MS
  "headers": { "x-api-key": "…" }, // optional; signature headers cannot be overridden
  "signingEnabled": true,
  "signingSecret": "…", // optional; generated when omitted
}
```

Only `signingSecretHint` (last four characters) appears in list responses. Reveal is a
`POST` so the secret never lands in a URL, browser history or access log, and each reveal
is written to the audit log.

## Events

| Method | Path                            | Auth                     | Description                               |
| ------ | ------------------------------- | ------------------------ | ----------------------------------------- |
| `GET`  | `/api/v1/events`                | session or `events:read` | Paginated updates                         |
| `GET`  | `/api/v1/events/:id`            | session or `events:read` | Detail including the raw payload          |
| `GET`  | `/api/v1/events/:id/deliveries` | session                  | Deliveries produced by this event         |
| `POST` | `/api/v1/events/:id/replay`     | session                  | Re-run routing and enqueue new deliveries |

Query parameters: `page`, `pageSize` (max 200), `botId`, `eventType`, `updateId`, `chatId`,
`from`, `to` (ISO timestamps).

## Deliveries

| Method | Path                           | Auth                          | Description               |
| ------ | ------------------------------ | ----------------------------- | ------------------------- |
| `GET`  | `/api/v1/deliveries`           | session or `deliveries:read`  | Paginated deliveries      |
| `GET`  | `/api/v1/deliveries/:id`       | session or `deliveries:read`  | Detail with every attempt |
| `POST` | `/api/v1/deliveries/:id/retry` | session or `deliveries:retry` | Queue a replay            |

Query parameters: `page`, `pageSize`, `botId`, `routeId`, `destinationId`, `eventId`,
`status`, `from`, `to`. Status is one of `pending`, `processing`, `retrying`, `success`,
`failed`.

A retry creates a **new** delivery flagged `isReplay` with `replayOfDeliveryId` pointing at
the original, which is left untouched.

## API keys

| Method   | Path                          | Description                                               |
| -------- | ----------------------------- | --------------------------------------------------------- |
| `GET`    | `/api/v1/api-keys`            | List your keys (admins see all)                           |
| `POST`   | `/api/v1/api-keys`            | Create a key — the only response containing the plaintext |
| `POST`   | `/api/v1/api-keys/:id/revoke` | Revoke immediately, keeping the audit record              |
| `DELETE` | `/api/v1/api-keys/:id`        | Delete the record entirely                                |

## Settings and dashboard

| Method | Path                       | Description                                  |
| ------ | -------------------------- | -------------------------------------------- |
| `GET`  | `/api/v1/dashboard`        | Aggregated counters, recent failures, health |
| `GET`  | `/api/v1/settings`         | Non-sensitive runtime configuration          |
| `POST` | `/api/v1/settings/cleanup` | Run a retention sweep now (admin only)       |

---

# Outbound Telegram API

Let downstream services talk to Telegram without ever holding a bot token. All of these
require the `telegram:send` scope (or an admin session).

| Method | Path                                      |
| ------ | ----------------------------------------- |
| `POST` | `/api/v1/bots/:botId/sendMessage`         |
| `POST` | `/api/v1/bots/:botId/sendPhoto`           |
| `POST` | `/api/v1/bots/:botId/sendDocument`        |
| `POST` | `/api/v1/bots/:botId/editMessageText`     |
| `POST` | `/api/v1/bots/:botId/deleteMessage`       |
| `POST` | `/api/v1/bots/:botId/answerCallbackQuery` |
| `POST` | `/api/v1/bots/:botId/telegram/:method`    |

The body is forwarded to Telegram as-is, and the reply is wrapped:

```json
{ "ok": true, "result": { "message_id": 42, "date": 1788642596, "text": "Hello" } }
```

```bash
curl -X POST "https://telegram.example.com/api/v1/bots/$BOT_ID/sendMessage" \
  -H "Authorization: Bearer $TGW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": 123456789, "text": "Deployment finished", "parse_mode": "HTML"}'
```

**Generic proxy.** `/telegram/:method` forwards any other Bot API method, except those the
gateway owns: `setWebhook`, `deleteWebhook`, `getWebhookInfo`, `getUpdates`, `close` and
`logout` are refused with `403`. Letting a client change webhook wiring would break inbound
routing for everyone.

A disabled bot refuses outbound calls with `403`.

---

# Inbound Telegram webhook

```
POST {TELEGRAM_WEBHOOK_PATH}/:botId
X-Telegram-Bot-Api-Secret-Token: <per-bot secret>
```

Not part of the public API — this is the endpoint you register with Telegram. It is exempt
from rate limiting and authenticated solely by the secret token, compared in constant time.

| Response                                             | Meaning                                                  |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `200 {"ok":true,"status":"accepted","deliveries":N}` | Stored and queued                                        |
| `200 {"ok":true,"status":"duplicate"}`               | Same `update_id` already seen; acknowledged              |
| `200 {"ok":true,"status":"no_routes"}`               | Stored, but no route matched                             |
| `200 {"ok":true,"status":"disabled"}`                | Bot is disabled; acknowledged so Telegram stops retrying |
| `401`                                                | Missing or wrong secret token                            |
| `404`                                                | Unknown bot id                                           |
