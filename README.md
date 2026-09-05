# Telegram Bots Gateway (TBGateway)

A lightweight, self-hosted **Telegram Bot Gateway and webhook router** with a modern admin
panel. Point any number of Telegram bots at it, then fan their updates out to your own
services over signed HTTP — without any of those services ever holding a bot token.

```
Telegram  ──►  Gateway  ──►  message        ──►  http://support-service:3000/telegram
                         ──►  callback_query ──►  http://frontend:3001/callback
                         ──►  document       ──►  http://python-ocr:8000/document
                         ──►  voice          ──►  http://python-whisper:8000/voice
```

Ships as **one Docker container** with a SQLite database on a mounted volume. No Redis, no
message broker, no sidecars.

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Roles and users](#roles-and-users)
- [Gateway API](#gateway-api)
- [Webhook signing](#webhook-signing)
- [Project layout](#project-layout)

---

## Features

**Inbound routing**

- One webhook endpoint per bot: `POST /telegram/webhook/:botId` — the bot token never
  appears in the URL.
- Telegram `secret_token` generated per bot and verified on every request.
- Configurable `allowed_updates`, with support for all Telegram update types; unknown
  future types are stored rather than dropped, and never crash the process.
- Route rules map update types (and optionally chat IDs) to destinations. One update can
  fan out to several destinations; each gets its own delivery record.
- Idempotent ingest: a Telegram retry of the same `update_id` is acknowledged without
  producing duplicate work.

**Delivery**

- Database-backed queue with a configurable retry schedule, per-attempt history, response
  status, timing, captured response body and classified transport errors.
- Deliveries survive restarts. Pending work resumes where it left off.
- Manual replay of a delivery or an entire event — always as a _new_ record, never a
  rewrite of history.
- Test events: send a clearly-marked synthetic update through a single route.

**Security**

- Bot tokens and destination signing secrets are encrypted at rest with AES-256-GCM. The
  master key lives only in the environment.
- Outbound deliveries are signed with HMAC-SHA256 (`X-TG-Gateway-Signature`).
- Argon2id password hashing, HttpOnly session cookies, CSRF protection, security headers
  with a strict CSP, rate limiting, and configurable SSRF policy for destinations.
- The browser never receives a decrypted token — only `123456789:••••••wXyZ` style hints.

**Administration**

- Dashboard, bots, destinations, routes, events, deliveries, API keys, users, settings.
- Two roles: **admins** manage everything including user accounts; **managers** create and
  route their own bots and see only what they own.
- Dark mode, empty states, loading states, confirmation dialogs for destructive actions.

**Outbound API**

- `POST /api/v1/bots/:botId/sendMessage` and friends, plus a guarded generic Telegram
  proxy. Downstream services authenticate with scoped gateway API keys and never see a bot
  token.

---

## Architecture

One container, one Node process:

```
                   ┌──────────────────────── telegram-gateway ────────────────────────┐
Telegram  ─HTTPS─► │  Fastify                                                          │
                   │   ├─ /telegram/webhook/:botId   verify secret → persist → enqueue │
                   │   ├─ /api/v1/*                  admin API + gateway API           │
                   │   └─ /*                         pre-built admin SPA (static)      │
                   │  Delivery worker  ── claims due deliveries ── signs ── POSTs ─────┼──► your services
                   │  Cleanup job      ── retention pruning                            │
                   │  SQLite (libsql) on /app/data ─────────────────────────────────── │
                   └──────────────────────────────────────────────────────────────────┘
```

The admin panel is a **React SPA built at image build time** and served as static files by
the same Fastify process. That keeps the production model to a single process with no
process manager and no second runtime — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#production-process-model) for why this was
chosen over running Next.js alongside the API.

Full write-up: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
---

## Roles and users

| Capability                                            | Admin |            Manager            |
| ----------------------------------------------------- | :---: | :---------------------------: |
| Create / edit / delete own bots, destinations, routes |  ✅   |              ✅               |
| See other users' bots, events and deliveries          |  ✅   |              ❌               |
| Reassign resource ownership                           |  ✅   |              ❌               |
| Create, block, delete users; reset passwords          |  ✅   |              ❌               |
| Create API keys                                       |  ✅   | ✅ (scoped to their own bots) |
| Run retention cleanup                                 |  ✅   |              ❌               |

The first administrator is bootstrapped from `ADMIN_USERNAME` / `ADMIN_PASSWORD` and can
never be blocked or deleted. Blocking a user terminates their sessions immediately. An
admin-initiated password reset forces a password change at the user's next sign-in.

---

## Gateway API

Downstream services authenticate with a gateway API key (`Authorization: Bearer tgw_…`).
Keys are created in **API keys**, shown exactly once, stored only as a digest, and carry
scopes: `bots:read`, `telegram:send`, `events:read`, `deliveries:read`, `deliveries:retry`.

```bash
curl -X POST "https://telegram.example.com/api/v1/bots/$BOT_ID/sendMessage" \
  -H "Authorization: Bearer $TGW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": 123456789, "text": "Hello from my service"}'
```

```python
import os, requests

requests.post(
    f"{os.environ['TG_GATEWAY_URL']}/api/v1/bots/{os.environ['BOT_ID']}/sendMessage",
    headers={"Authorization": f"Bearer {os.environ['TGW_API_KEY']}"},
    json={"chat_id": 123456789, "text": "Hello from Python"},
    timeout=10,
).raise_for_status()
```

Errors are uniform, and every response carries an `X-Request-Id` that appears in the logs:

```json
{
  "error": {
    "code": "DESTINATION_UNREACHABLE",
    "message": "Destination request timed out",
    "requestId": "req_mtovesip3s54cd6znq"
  }
}
```

Full endpoint reference: [docs/API.md](docs/API.md).

---

## Webhook signing

Every delivery is a JSON POST that preserves the original Telegram update byte-for-byte
under `update`, with gateway metadata alongside it:

```json
{
  "gateway": {
    "deliveryId": "dlv_mtov…",
    "botId": "bot_mtov…",
    "botName": "Support Bot",
    "eventType": "message",
    "receivedAt": "2026-09-06T10:15:03.412Z",
    "routeId": "rte_mtov…",
    "destinationId": "dst_mtov…",
    "attempt": 1,
    "replay": false,
    "test": false
  },
  "update": { "update_id": 123456789, "message": { "…": "…" } }
}
```

Headers:

| Header                     | Meaning                                              |
| -------------------------- | ---------------------------------------------------- |
| `X-TG-Gateway-Signature`   | `sha256=<hex HMAC>` over `timestamp + "." + rawBody` |
| `X-TG-Gateway-Timestamp`   | Unix seconds, part of the signed string              |
| `X-TG-Gateway-Delivery-Id` | Stable delivery id — use it for your own idempotency |
| `X-TG-Gateway-Event-Type`  | Telegram update type                                 |
| `X-TG-Gateway-Attempt`     | 1-based attempt counter                              |
| `X-TG-Gateway-Test`        | `true` only for admin-generated test events          |

Reveal a destination's secret with the eye icon on the **Destinations** page.

### Verifying in Node.js

```js
import crypto from 'node:crypto';
import express from 'express';

const app = express();
const SECRET = process.env.TG_GATEWAY_SIGNING_SECRET;
const MAX_SKEW_SECONDS = 300;

// The signature covers the RAW body, so capture it before any JSON parsing.
app.post('/events', express.raw({ type: '*/*' }), (req, res) => {
  const timestamp = req.get('X-TG-Gateway-Timestamp');
  const signature = req.get('X-TG-Gateway-Signature');
  if (!timestamp || !signature) return res.status(400).send('missing signature');

  // Reject stale requests so a captured delivery cannot be replayed later.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return res.status(400).send('stale timestamp');
  }

  const rawBody = req.body.toString('utf8');
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send('invalid signature');
  }

  const { gateway, update } = JSON.parse(rawBody);
  console.log(`[${gateway.deliveryId}] ${gateway.eventType}`, update.message?.text);

  // Answer 2xx quickly; do the slow work asynchronously or the gateway will retry.
  res.status(200).json({ ok: true });
});

app.listen(3000);
```

### Verifying in Python (FastAPI)

```python
import hashlib
import hmac
import os
import time

from fastapi import FastAPI, HTTPException, Request

app = FastAPI()
SECRET = os.environ["TG_GATEWAY_SIGNING_SECRET"].encode()
MAX_SKEW_SECONDS = 300


@app.post("/events")
async def events(request: Request):
    timestamp = request.headers.get("x-tg-gateway-timestamp")
    signature = request.headers.get("x-tg-gateway-signature")
    if not timestamp or not signature:
        raise HTTPException(status_code=400, detail="missing signature")

    # Reject stale requests so a captured delivery cannot be replayed later.
    if abs(time.time() - float(timestamp)) > MAX_SKEW_SECONDS:
        raise HTTPException(status_code=400, detail="stale timestamp")

    # The signature covers the RAW body, so read bytes before parsing JSON.
    raw_body = await request.body()
    signed = f"{timestamp}.".encode() + raw_body
    expected = "sha256=" + hmac.new(SECRET, signed, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=401, detail="invalid signature")

    payload = await request.json()
    gateway, update = payload["gateway"], payload["update"]
    print(f"[{gateway['deliveryId']}] {gateway['eventType']}", update.get("message", {}).get("text"))

    # Answer 2xx quickly; do the slow work in a background task.
    return {"ok": True}
```

Both examples are also in [`examples/`](examples/) as runnable files. A Flask variant is in
[docs/SECURITY.md](docs/SECURITY.md#webhook-signature-verification).

**Retry semantics your handler should expect:** any 2xx is success. `408`, `425`, `429` and
all 5xx are retried on the configured backoff (default `1s, 5s, 30s, 2m, 10m`, six attempts
total). Other 4xx responses are treated as a permanent rejection and are **not** retried.
Telegram itself may redeliver an update, and a delivery may be replayed manually — so
deduplicate on `X-TG-Gateway-Delivery-Id` or on `update.update_id` if that matters to you.

---

## Project layout

```
backend/     Fastify API, Drizzle schema and migrations, delivery worker, Telegram client
frontend/    React + Vite + Tailwind admin panel (built to static assets)
shared/      Zod contracts, DTOs and constants shared by both sides
docker/      Reverse-proxy examples and deployment extras
docs/        Architecture, API, security and deployment guides
examples/    Runnable signature-verification receivers (Node.js, Python)
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — request flow, data model, design decisions
- [docs/API.md](docs/API.md) — full HTTP API reference
- [docs/CLI.md](docs/CLI.md) — pnpm scripts, Make targets and command-line workflows
- [docs/SECURITY.md](docs/SECURITY.md) — encryption, signing, auth, SSRF, secret management
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker, Compose, reverse proxies, upgrades

## License

[MIT](LICENSE)
