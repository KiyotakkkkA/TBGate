# Telegram Gateway

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
- [Screenshots](#screenshots)
- [Prerequisites](#prerequisites)
- [Quick start (Docker)](#quick-start-docker)
- [Local development](#local-development)
- [Environment configuration](#environment-configuration)
- [Generating secrets](#generating-secrets)
- [Reverse proxy and HTTPS](#reverse-proxy-and-https)
- [Telegram webhook requirements](#telegram-webhook-requirements)
- [Roles and users](#roles-and-users)
- [Gateway API](#gateway-api)
- [Webhook signing](#webhook-signing)
- [Database persistence and backups](#database-persistence-and-backups)
- [Docker Hub publishing](#docker-hub-publishing)
- [CI/CD](#cicd)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)
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
- Manual replay of a delivery or an entire event — always as a *new* record, never a
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

## Screenshots

> Screenshots are not committed yet. Capture them at `/admin`, `/admin/bots/:id` and
> `/admin/deliveries` and drop them in `docs/images/`.

| Dashboard | Bot detail | Deliveries |
| --------- | ---------- | ---------- |
| _`docs/images/dashboard.png`_ | _`docs/images/bot-detail.png`_ | _`docs/images/deliveries.png`_ |

---

## Prerequisites

**To deploy:** Docker and Docker Compose. Nothing else — Node.js is not needed on the host.

**To develop:** Node.js 22+ and pnpm 10+.

**To receive Telegram updates:** a publicly reachable HTTPS URL. Telegram will not deliver
to plain HTTP or to a self-signed certificate it cannot verify.

---

## Quick start (Docker)

```bash
mkdir telegram-gateway && cd telegram-gateway

# Copy docker-compose.yml and .env.example from this repository, then:
cp .env.example .env
mkdir -p data

# Fill in the two required secrets (see "Generating secrets" below)
openssl rand -hex 32      # → APP_ENCRYPTION_KEY
openssl rand -base64 48   # → SESSION_SECRET

# Also set PUBLIC_BASE_URL and ADMIN_PASSWORD in .env, then:
docker compose up -d --build
```

Point your reverse proxy at the container and open:

```
https://telegram.example.com/admin
```

Sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`, then **change the password immediately**
from the user menu. After that, `ADMIN_PASSWORD` is no longer used for anything.

Then, in the admin panel:

1. **Bots → Add bot** — paste the token from [@BotFather](https://t.me/BotFather). The
   gateway calls `getMe` to verify it, encrypts it, and registers the Telegram webhook.
2. **Destinations → Add destination** — e.g. `http://python-worker:8000/events`.
3. **Bot → Routes → Add route** — `message` → that destination.
4. **Send test** on the route to confirm the wiring, then message your bot for real.

---

## Local development

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

`pnpm dev` runs the API on <http://127.0.0.1:8080> and the Vite dev server on
<http://127.0.0.1:5173> (which proxies `/api` to the API). Open the Vite URL for hot
reloading, or build the SPA once (`pnpm --filter ./frontend build`) and use port 8080 to
exercise the exact production setup.

For local development set these in `.env`:

```ini
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:8080
DATABASE_URL=file:../data/gateway.sqlite   # relative to backend/, i.e. <repo>/data
COOKIE_SECURE=false                        # otherwise the session cookie is dropped over plain HTTP
LOG_PRETTY=true
```

### Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | API + admin UI with hot reload |
| `pnpm build` | Build the SPA and bundle the server |
| `pnpm start` | Run the built server |
| `pnpm lint` / `pnpm typecheck` | Lint / type-check the workspace |
| `pnpm test` | Vitest unit + integration suite |
| `pnpm test:e2e` | Playwright browser tests |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm secrets` | Print freshly generated secrets |

A `Makefile` wraps the same commands plus the Docker workflow (`make help`).

---

## Environment configuration

Every supported variable is documented — with defaults, format and security notes — in
[`.env.example`](.env.example). The configuration is validated at startup, and the process
exits with a readable summary if anything is missing or malformed (secret **values** are
never echoed):

```
Invalid configuration:
  * APP_ENCRYPTION_KEY must decode to exactly 32 bytes (256 bits). Generate with: openssl rand -hex 32
  * PUBLIC_BASE_URL must be an absolute http/https URL
```

**Required:** `PUBLIC_BASE_URL`, `ADMIN_PASSWORD`, `APP_ENCRYPTION_KEY`, `SESSION_SECRET`.
Everything else has a production-suitable default.

### Generating secrets

```bash
openssl rand -hex 32      # APP_ENCRYPTION_KEY — 64 hex chars (32 bytes / 256 bits)
openssl rand -base64 48   # SESSION_SECRET     — any string of at least 32 characters
```

`APP_ENCRYPTION_KEY` also accepts base64 that decodes to exactly 32 bytes. Or run
`pnpm secrets` / `make secrets` to print both at once.

> **Back up `APP_ENCRYPTION_KEY`.** It is never stored in the database. Lose it and every
> stored bot token and signing secret becomes unrecoverable and must be re-entered.

### Admin password reset

`ADMIN_PASSWORD` is used **only** to create the first account. Changing it later does not
touch the stored password. To recover a lost administrator password, see
[docs/SECURITY.md](docs/SECURITY.md#recovering-a-lost-administrator-password).

---

## Reverse proxy and HTTPS

The gateway listens on plain HTTP inside the container. Terminate TLS in front of it and
set `TRUST_PROXY=true` so client IPs and protocol are read from the forwarded headers.

**Caddy** (`Caddyfile`):

```caddy
telegram.example.com {
    encode zstd gzip
    reverse_proxy telegram-gateway:8080
}
```

That is the whole configuration — Caddy obtains and renews the certificate automatically.

Nginx, Traefik and Cloudflare Tunnel examples are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#reverse-proxy-examples).

---

## Telegram webhook requirements

- The URL must be **HTTPS** on port 443, 80, 88 or 8443, with a certificate Telegram can
  verify. `PUBLIC_BASE_URL` must match exactly what the outside world reaches.
- Webhook URLs are derived as `<PUBLIC_BASE_URL><TELEGRAM_WEBHOOK_PATH>/<botId>`, where
  `botId` is an opaque gateway identifier — **not** the bot token.
- Requests are authenticated with the per-bot Telegram `secret_token`, checked against the
  `X-Telegram-Bot-Api-Secret-Token` header in constant time.
- If `PUBLIC_BASE_URL` changes, the gateway detects the mismatch at startup and flags the
  affected bots as **URL mismatch** in the UI. It never silently re-registers — use
  **Bot → Telegram → Re-register webhook** when you are ready.

---

## Roles and users

| Capability | Admin | Manager |
| --- | :---: | :---: |
| Create / edit / delete own bots, destinations, routes | ✅ | ✅ |
| See other users' bots, events and deliveries | ✅ | ❌ |
| Reassign resource ownership | ✅ | ❌ |
| Create, block, delete users; reset passwords | ✅ | ❌ |
| Create API keys | ✅ | ✅ (scoped to their own bots) |
| Run retention cleanup | ✅ | ❌ |

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

| Header | Meaning |
| --- | --- |
| `X-TG-Gateway-Signature` | `sha256=<hex HMAC>` over `timestamp + "." + rawBody` |
| `X-TG-Gateway-Timestamp` | Unix seconds, part of the signed string |
| `X-TG-Gateway-Delivery-Id` | Stable delivery id — use it for your own idempotency |
| `X-TG-Gateway-Event-Type` | Telegram update type |
| `X-TG-Gateway-Attempt` | 1-based attempt counter |
| `X-TG-Gateway-Test` | `true` only for admin-generated test events |

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

## Database persistence and backups

All state lives in a single SQLite file on the mounted volume:

```yaml
volumes:
  - ./data:/app/data     # → /app/data/gateway.sqlite
```

Nothing else in the container is persistent, so replacing it loses nothing. Migrations run
automatically at startup behind a lock, which makes `docker compose pull && up -d` safe.

**Backups.** The database runs in WAL mode, so a plain `cp` of the `.sqlite` file while the
container is running can miss committed data still in the write-ahead log. Either stop the
container briefly, or use `sqlite3`'s online backup:

```bash
# Simplest: a few seconds of downtime, guaranteed consistent.
docker compose stop telegram-gateway
tar czf backup-$(date +%F).tar.gz data/
docker compose start telegram-gateway

# Or, with sqlite3 installed on the host, no downtime:
sqlite3 data/gateway.sqlite ".backup 'backup-$(date +%F).sqlite'"
```

Back up `APP_ENCRYPTION_KEY` separately and just as carefully — the database is useless
without it.

---

## Docker Hub publishing

The Docker Hub account is never hardcoded; it comes from an environment variable or a
command-line argument.

```bash
docker login

# Versioned + latest, in one build:
docker build \
  -t $DOCKERHUB_USERNAME/telegram-gateway:1.0.0 \
  -t $DOCKERHUB_USERNAME/telegram-gateway:latest \
  .

docker push $DOCKERHUB_USERNAME/telegram-gateway:1.0.0
docker push $DOCKERHUB_USERNAME/telegram-gateway:latest
```

Or, with the Makefile (multi-architecture via buildx):

```bash
make docker-push DOCKERHUB_USERNAME=youruser
```

Local build only:

```bash
docker build -t telegram-gateway:local .
docker compose up -d
```

---

## CI/CD

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) — on pull requests and pushes to
`main`: install, lint, type-check, test, build, and build the Docker image without pushing.

[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) — on a `v*`
tag: run the tests, then build a multi-architecture image with Buildx and push
`:MAJOR.MINOR.PATCH`, `:MAJOR.MINOR` and `:latest` to Docker Hub.

Add two repository secrets — `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub
access token, not your password). No credentials appear in the workflow files.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

---

## Upgrading

```bash
docker compose pull
docker compose up -d
```

Migrations apply automatically on boot. The `./data` volume carries bots, routes, events
and pending deliveries across the replacement. Keep the same `APP_ENCRYPTION_KEY`, or
stored tokens cannot be decrypted.

---

## Troubleshooting

**The container exits immediately with "Invalid configuration".**
A required variable is missing or malformed. The message lists exactly which ones; check
`docker compose logs telegram-gateway`.

**Sign-in appears to succeed but immediately bounces back to the login page.**
`COOKIE_SECURE=true` over plain HTTP — the browser drops the cookie. Use HTTPS, or set
`COOKIE_SECURE=false` for local development only.

**Telegram never delivers updates.**
Open **Bot → Telegram**; the live `getWebhookInfo` panel shows Telegram's own error text.
Common causes: `PUBLIC_BASE_URL` does not match the public URL, TLS certificate not
verifiable, or the reverse proxy not forwarding `/telegram/webhook/*`.

**Webhook state shows "URL mismatch".**
`PUBLIC_BASE_URL` changed. Nothing is broken automatically — click **Re-register webhook**.

**Deliveries fail with `DESTINATION_URL_REJECTED`.**
The destination resolves to a private address while
`DESTINATION_ALLOW_PRIVATE_NETWORKS=false`. Set it to `true` for Docker service-name
routing (`http://python-worker:8000/...`).

**Deliveries fail with `DNS_ERROR` or `CONNECTION_REFUSED` for a container name.**
The gateway and the target must share a Docker network. Add both services to the same
`networks:` entry in `docker-compose.yml`.

**Downstream returns 401 "invalid signature".**
Your handler is almost certainly verifying against a re-serialised body. Sign the **raw**
request bytes, exactly as received, prefixed with `timestamp + "."`.

**"A stored secret could not be decrypted."**
`APP_ENCRYPTION_KEY` does not match the one used when the data was written. Restore the
original key, or delete and re-add the affected bots and destinations.

**Lost the admin password.**
See [docs/SECURITY.md](docs/SECURITY.md#recovering-a-lost-administrator-password).

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
- [docs/SECURITY.md](docs/SECURITY.md) — encryption, signing, auth, SSRF, secret management
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker, Compose, reverse proxies, upgrades

## License

MIT
