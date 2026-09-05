# Architecture

## Goal

Receive Telegram updates for any number of bots, persist them, and fan them out to
administrator-configured HTTP endpoints reliably — in one container, with one process and
one SQLite file.

---

## Request flow

```
  Telegram
     │  POST /telegram/webhook/:botId
     │  X-Telegram-Bot-Api-Secret-Token: <per-bot secret>
     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Authenticate    constant-time compare against the decrypted bot secret   │
│ 2. Classify        update → event type, update_id, chat id                  │
│ 3. Persist         INSERT INTO telegram_events … ON CONFLICT DO NOTHING     │
│                    (unique on bot_id + telegram_update_id → idempotent)     │
│ 4. Match routes    enabled routes whose updateTypes and chat filter match   │
│ 5. Enqueue         one `deliveries` row per matching route, status=pending  │
│ 6. Acknowledge     200 OK — total work is a handful of local SQLite writes  │
└─────────────────────────────────────────────────────────────────────────────┘
     │
     │  (asynchronously, in the same process)
     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Delivery worker — polls every DELIVERY_WORKER_POLL_INTERVAL_MS              │
│                                                                             │
│ claim   conditional UPDATE takes a lease on due rows (never two workers)    │
│ build   { gateway: {...}, update: <original Telegram JSON> }                │
│ sign    HMAC-SHA256 over `timestamp + "." + rawBody`                        │
│ send    POST with a per-destination timeout                                 │
│ record  delivery_attempts row + updated delivery status                     │
│ retry   backoff schedule, or mark failed permanently                        │
└─────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
  your service (Node, Python, Go, anything that speaks HTTP)
```

The webhook handler never waits on a downstream service. Telegram sees only the cost of
persisting the update, which keeps its delivery queue healthy even when a destination is
down.

---

## Data model

```
users ──┬──< bots ──< routes >── destinations
        ├──< destinations              │
        └──< api_keys                  │
                                       │
        telegram_events ──< deliveries ┘
                                 └──< delivery_attempts
        sessions, app_settings
```

| Table               | Purpose                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `users`             | Admin and manager accounts. Argon2id hashes; `is_bootstrap` marks the protected first admin. |
| `sessions`          | Server-side sessions. Stores a keyed digest of the cookie value, never the token.            |
| `bots`              | Encrypted token, encrypted Telegram `secret_token`, allowed update types, webhook state.     |
| `destinations`      | URL, method, timeout, custom headers, encrypted HMAC signing secret.                         |
| `routes`            | Per bot: update types (or `*`), destination, priority, optional chat filter.                 |
| `telegram_events`   | Raw update JSON plus classification. Unique on `(bot_id, telegram_update_id)`.               |
| `deliveries`        | Queue and history in one table. Status, attempt counters, lease columns, replay links.       |
| `delivery_attempts` | One row per HTTP attempt: status, duration, truncated body, error code.                      |
| `api_keys`          | Digest, prefix, scopes, owner, expiry and revocation.                                        |
| `app_settings`      | Reserved for future persisted runtime settings.                                              |

Ownership is a nullable `owner_id` on `bots`, `destinations` and `api_keys`. Managers are
filtered to rows they own; admins see everything. Deleting a user leaves their bots in
place but unassigned, so history is never destroyed by an account change.

Indexes cover the paths that actually run hot: the queue scan
(`status, next_attempt_at`), event listing (`bot_id, received_at`), delivery listing
(`bot_id, created_at`), and every foreign key used for filtering.

---

## Key design decisions

### Database-backed queue instead of Redis

Pending deliveries live in the `deliveries` table. This keeps the deployment to a single
container, and it means a crash or a `docker compose up -d` loses nothing — on restart the
worker simply finds the same due rows.

Concurrency safety comes from a **conditional UPDATE lease**: a worker claims a row only if
`locked_at IS NULL OR locked_at <= now - 120s`, and checks `rowsAffected` before acting. A
process that dies mid-flight releases its rows after the lease expires; a clean shutdown
releases them immediately.

### Fan-out at ingest, not at delivery

Route matching happens once, when the update arrives, and produces one delivery row per
matching route. Each destination then retries independently — a slow OCR service cannot
delay messages headed for the support service — and the delivery record captures which
route produced it even if that route is later edited or deleted.

### Envelope, not transformation

The original Telegram update is stored verbatim and forwarded byte-for-byte under
`update`. Gateway metadata lives in a sibling `gateway` object. Downstream code written
against the Telegram Bot API keeps working unchanged, and a new Telegram field never needs
a gateway release.

### Classification that cannot break

`classifyUpdate()` probes the known update-type fields in order and falls back to
`unknown`, extracting a chat id from whichever shape the payload happens to use. It never
throws — a malformed or future payload is stored and visible in the UI rather than
rejected. Routes can subscribe to `*` to receive everything, including types this build
does not know about.

### Retry policy

The first attempt is immediate; failures then follow `DELIVERY_RETRY_DELAYS_MS`
(default `1s, 5s, 30s, 2m, 10m`) up to `DELIVERY_MAX_ATTEMPTS`. If the schedule is shorter
than the attempt limit, the last delay repeats.

5xx, `408`, `425`, `429` and transport-level failures are retried. Other 4xx responses mean
the destination understood and rejected the request, so retrying only produces noise —
those are marked `failed` immediately.

### Replay creates, never rewrites

Replaying a delivery inserts a **new** delivery row flagged `is_replay` and linked back via
`replay_of_delivery_id`. Replaying an event re-runs route matching and enqueues fresh
deliveries. Historical records are immutable, so an audit trail always reflects what
actually happened.

### Migrations run at startup

Production deployment is `docker compose pull && docker compose up -d`. Requiring a
separate migration command there would leave a new binary running against an old schema
during the gap. So migrations run on boot, guarded by a lock row with a 60-second TTL so
two containers sharing a volume cannot race, and a failure aborts startup loudly rather
than serving traffic against a half-migrated database.

Migrations are still **generated** explicitly (`pnpm db:generate`) and committed — there is
no automatic schema synchronisation.

### Production process model

The admin panel is a React SPA compiled to static assets at image build time and served by
the same Fastify instance that serves the API.

The brief called for Next.js. A separate Next.js server would mean two Node processes in
one container (needing a supervisor), or two containers — against the stated goal of one
lightweight container with no process manager. The admin panel is a fully authenticated,
client-rendered dashboard: it gains nothing from SSR, SSG, or React Server Components, and
every route is behind a session check. Dropping the Next.js runtime removes a process, a
supervisor, and a large dependency tree while producing exactly the same UI, so the SPA is
served as static files instead. React, TypeScript, Tailwind and the accessible component
patterns are all unchanged.

The single process runs:

- the Fastify HTTP server (API, Telegram webhooks, static assets),
- the delivery worker, on a timer,
- the retention cleanup job, on a longer timer.

### SQLite via libsql

`@libsql/client` speaks the `file:` URL form used by `DATABASE_URL`, ships prebuilt
binaries for glibc and musl, and is driven through Drizzle ORM. WAL mode plus a
5-second busy timeout keeps the HTTP path and the worker from blocking each other.

Because all database access goes through Drizzle and a thin service layer, moving to
PostgreSQL later means swapping the driver and the schema dialect — no business logic
changes. No raw SQL is scattered through the codebase.

---

## Code layout

```
backend/src/
  config/env.ts          Zod-validated environment, fail-fast at boot
  lib/                   crypto, password hashing, ids, logger, domain errors
  db/                    Drizzle schema, client, migration runner
  telegram/              Bot API client, update classifier, sample payload builder
  router/match.ts        pure route-matching logic
  security/ssrf.ts       destination URL policy
  services/              users, auth, bots, destinations, routes, events, deliveries, …
  worker/                delivery worker, retry policy, retention cleanup
  http/                  Fastify server, plugins (auth, errors), route modules
  app-context.ts         explicit dependency wiring
  index.ts               startup and shutdown lifecycle
```

Boundaries are deliberate: HTTP handlers validate and delegate; services own database
access and business rules; `lib/` and `router/` are pure and directly unit-testable;
cryptography exists in exactly one module. Dependencies are constructed explicitly in
`app-context.ts` rather than through a DI container — the graph is small enough that
plain constructor arguments are clearer, and tests substitute individual pieces by passing
different arguments.

---

## Lifecycle

**Startup**

1. Validate the environment; exit code 78 with a readable summary if invalid.
2. Open SQLite, creating the data directory if needed; apply WAL pragmas.
3. Run migrations under a lock.
4. Bootstrap the administrator if no account exists yet.
5. Audit webhook URLs; report mismatches without changing anything.
6. Start the delivery worker and the cleanup job.
7. Listen, and report readiness on `/ready`.

**Shutdown** (`SIGTERM` / `SIGINT`)

1. Stop accepting new connections and drain in-flight requests (`app.close()`).
2. Stop claiming new deliveries; wait up to 15s for active attempts.
3. Release held leases so another instance can pick the work up immediately.
4. Close the database. A 30-second watchdog forces exit if anything hangs.

---

## Observability

Structured Pino logs carry `requestId`, and where relevant `botId`, `eventId`,
`deliveryId`, `routeId`, `destinationId`, `responseStatus` and `durationMs`. Token,
password, secret and cookie fields are redacted at the logger level, so an accidental
`log.info({ bot })` cannot print a token; free-form text passes through a regex redactor
before being logged.

Every HTTP response carries `X-Request-Id`, and the admin UI surfaces it on error screens,
so a user-reported failure maps directly to a log line.

Dashboard metrics are plain SQL aggregates. Nothing in the design prevents adding a
`/metrics` endpoint later — the counters would come from the same queries.
