# Security

What this application protects, how, and what it deliberately leaves to the operator.

---

## Threat model in one paragraph

The gateway holds Telegram bot tokens — credentials that let anyone impersonate a bot,
read its messages and post as it. It also makes outbound HTTP requests to
administrator-supplied URLs. So the two assets that matter are **stored secrets** and
**the ability to make the server issue requests**. Everything below follows from those.

---

## Secret storage

### What is encrypted

| Secret                     | Storage                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| Telegram bot token         | AES-256-GCM ciphertext in `bots.encrypted_token`                        |
| Telegram `secret_token`    | AES-256-GCM ciphertext in `bots.encrypted_webhook_secret`               |
| Destination signing secret | AES-256-GCM ciphertext in `destinations.encrypted_signing_secret`       |
| Admin password             | Argon2id hash (19 MiB, t=2, p=1)                                        |
| Session token              | HMAC-SHA256 digest keyed with `SESSION_SECRET`                          |
| Gateway API key            | HMAC-SHA256 digest keyed with a value derived from `APP_ENCRYPTION_KEY` |

Passwords, session tokens and API keys are **never** recoverable — only digests are stored.
Bot tokens and signing secrets are reversible by design (the gateway must present them),
which is why they use authenticated encryption rather than hashing.

### Ciphertext format

```
v1.<iv base64url>.<auth tag base64url>.<ciphertext base64url>
```

A random 96-bit IV per encryption, and a GCM authentication tag that makes tampering
detectable: modifying any stored byte causes decryption to fail rather than silently
producing garbage. The version prefix leaves room for a future algorithm change.

### The master key

`APP_ENCRYPTION_KEY` must supply exactly 256 bits — 64 hex characters, or base64 decoding
to 32 bytes. It is validated at startup, and the process refuses to boot otherwise.

```bash
openssl rand -hex 32
```

The key lives only in the environment. **It is never written to the database**, so a
database dump on its own reveals no usable secrets.

> Back it up separately from the database. If you lose it, every stored bot token and
> signing secret is unrecoverable and must be re-entered by hand.

### Rotating the master key

There is no automated re-encryption. To rotate:

1. Note which bots and destinations exist.
2. Stop the container, back up `data/`.
3. Set the new `APP_ENCRYPTION_KEY`, start the container.
4. Re-enter each bot token (**Bot → Settings**) and rotate each destination signing secret
   (**Destinations → Edit → Rotate the signing secret**), updating your downstream services.

Requests touching a secret encrypted with the old key return `ENCRYPTION_ERROR` until it is
re-entered; nothing else breaks.

### Redaction

Token, password, secret, cookie and API-key fields are redacted at the Pino logger level,
so `log.info({ bot })` cannot leak a token even by accident. Free-form text (such as a
Telegram error message that echoes a URL) passes through a regex redactor that rewrites
`123456789:AA…` to `123456789:[REDACTED]`. The UI only ever shows masked hints
(`123456789:••••••wXyZ`), and no API response contains a token after creation.

---

## Admin authentication

- **Argon2id** password hashing with OWASP-recommended interactive parameters.
- Sign-in runs a verification even for an unknown username, so response timing does not
  reveal which accounts exist.
- Sessions are server-side. The cookie holds a 256-bit random token; only its keyed digest
  is stored, so a database dump cannot be used to forge a session.
- Cookies are `HttpOnly`, `SameSite` (`lax` by default) and `Secure` when
  `COOKIE_SECURE=true`. Sessions expire after `SESSION_TTL_HOURS` and expired rows are
  pruned by the cleanup job.
- **CSRF**: a double-submit token. The readable `tgw_csrf` cookie must be echoed as an
  `X-CSRF-Token` header on every `POST`/`PATCH`/`DELETE`; a mismatch returns
  `CSRF_INVALID`. The gateway API is exempt because bearer tokens are not ambient
  credentials.
- Sign-in attempts are rate limited per IP (`LOGIN_RATE_LIMIT_MAX` per minute).
- Blocking a user deletes their sessions immediately, and a blocked account is rejected on
  every subsequent request even if a cookie survives.

### Roles

Two roles, deliberately no teams or tenants. **Admins** manage everything, including user
accounts. **Managers** create and route their own bots and destinations and see only rows
they own; every service method filters by `owner_id` rather than relying on the UI to hide
things. Ownership is enforced server-side on read _and_ write, including through API keys —
a manager's key inherits exactly that manager's reach.

The bootstrap administrator is protected: it cannot be blocked, demoted or deleted, and the
last remaining active admin cannot be removed. No user can block, demote or delete
themselves.

### Recovering a lost administrator password

`ADMIN_PASSWORD` only seeds the first account; changing it later does nothing. To recover,
delete the bootstrap user so it is recreated from the environment on the next start:

```bash
docker compose stop telegram-gateway
cp data/gateway.sqlite data/gateway.sqlite.bak          # always take a backup first

# Requires sqlite3 on the host:
sqlite3 data/gateway.sqlite "DELETE FROM users WHERE is_bootstrap = 1;"

# Set a new ADMIN_PASSWORD in .env, then:
docker compose start telegram-gateway
```

Bots, routes, destinations and history are untouched — only the account is recreated. If
another admin account exists, use it to reset the password from the UI instead.

---

## Gateway API keys

Format `tgw_<prefix>_<secret>`, where the secret is 256 bits of randomness. Only a keyed
digest is stored; the plaintext appears exactly once, in the creation response, and the UI
states this plainly.

Keys carry explicit scopes (`bots:read`, `telegram:send`, `events:read`, `deliveries:read`,
`deliveries:retry`), are checked per endpoint, can be given an expiry, and can be revoked
instantly. A key belonging to a blocked or deleted user stops working immediately.

The generic Telegram proxy refuses `setWebhook`, `deleteWebhook`, `getWebhookInfo`,
`getUpdates`, `close` and `logout`: those manage gateway-owned state, and a compromised key
must not be able to redirect a bot's updates elsewhere.

---

## Inbound webhook authentication

Each bot gets a random `secret_token` which the gateway hands to Telegram via `setWebhook`
and then requires on every inbound request as `X-Telegram-Bot-Api-Secret-Token`. The
comparison is constant-time.

The bot token never appears in the webhook URL — the path carries an opaque gateway bot id.
This matters because URLs leak: proxy logs, browser history, `Referer` headers, error
reports.

Unknown bot ids return `404`, and a wrong secret returns `401` with the attempt logged.

---

## Webhook signature verification

Deliveries are signed with HMAC-SHA256 using a per-destination secret.

**Signed string:** `timestamp + "." + rawBody`
**Header:** `X-TG-Gateway-Signature: sha256=<hex digest>`
**Timestamp:** `X-TG-Gateway-Timestamp`, Unix seconds

Including the timestamp in the signed material is what makes replay detection possible:
reject anything older than a few minutes and a captured request stops being useful.

Your handler must hash the **raw request bytes**, exactly as received. Re-serialising the
parsed JSON changes key order and whitespace and will produce a different digest.

Node.js and FastAPI examples are in the [README](../README.md#verifying-in-nodejs) and as
runnable files in [`examples/`](../examples). A Flask version:

```python
import hashlib
import hmac
import os
import time

from flask import Flask, request, abort

app = Flask(__name__)
SECRET = os.environ["TG_GATEWAY_SIGNING_SECRET"].encode()
MAX_SKEW_SECONDS = 300


@app.post("/events")
def events():
    timestamp = request.headers.get("X-TG-Gateway-Timestamp")
    signature = request.headers.get("X-TG-Gateway-Signature")
    if not timestamp or not signature:
        abort(400, "missing signature")
    if abs(time.time() - float(timestamp)) > MAX_SKEW_SECONDS:
        abort(400, "stale timestamp")

    # get_data() returns the raw bytes; do not use request.json here.
    signed = f"{timestamp}.".encode() + request.get_data()
    expected = "sha256=" + hmac.new(SECRET, signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        abort(401, "invalid signature")

    payload = request.get_json()
    print(payload["gateway"]["deliveryId"], payload["gateway"]["eventType"])
    return {"ok": True}
```

Rotate a secret from **Destinations → Edit → Rotate the signing secret**. The old secret
stops working the moment you save, so deploy the new one to the receiver first, or accept
either value briefly during the changeover.

---

## SSRF considerations

This application makes HTTP requests to URLs an administrator supplies. That is its
purpose, so it cannot simply block internal addresses — Docker service-name routing
(`http://python-worker:8000/events`) is an explicit requirement.

**Always enforced:**

- Only `http://` and `https://`. `file://`, `gopher://` and everything else are rejected.
- No credentials in the URL (`https://user:pass@host/…`) — use a custom header instead.
- Redirects are not followed (`redirect: 'manual'`), so a destination cannot bounce the
  gateway to an internal address after the check.
- Per-request timeouts bound how long any single target can hold a worker slot.
- Destination-supplied headers cannot override `content-type`, `host` or any
  `x-tg-gateway-*` signature header.

**Policy-controlled** (`DESTINATION_ALLOW_PRIVATE_NETWORKS`):

- `true` (default) — private targets are allowed. Required for container-to-container
  routing.
- `false` — the hostname is resolved and every returned address must be public. Blocks
  loopback, RFC 1918, CGNAT, link-local (including `169.254.169.254`, the cloud metadata
  endpoint), and their IPv6 equivalents.

**Known limitation.** With the policy disabled, the check is check-then-connect, so it does
not defeat a determined DNS-rebinding attack: a hostname could resolve to a public address
during validation and a private one during the request. Closing that gap requires pinning
the resolved address at connect time. The mitigating factor is that only authenticated
administrators and managers can create destinations. If you run untrusted managers, set
`DESTINATION_ALLOW_PRIVATE_NETWORKS=false` **and** place the container on a network with no
route to anything sensitive.

---

## HTTP hardening

Security headers come from `@fastify/helmet`:

| Header                      | Value                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options`    | `nosniff`                                                                                                                                                                                           |
| `X-Frame-Options`           | `SAMEORIGIN` (plus `frame-ancestors 'none'`)                                                                                                                                                        |
| `Referrer-Policy`           | `same-origin`                                                                                                                                                                                       |
| `Strict-Transport-Security` | one year, when `COOKIE_SECURE=true`                                                                                                                                                                 |

`script-src` is strictly `'self'` — no inline scripts, no CDN. `style-src` allows inline
styles because React sets element styles at runtime; that is a far weaker exposure than
inline script, and the policy is not relaxed further just because the panel is internal.

Request bodies are capped at `MAX_REQUEST_BODY_BYTES` (1 MiB default). Every payload and
query string is validated with Zod at the HTTP boundary — TypeScript types are never
treated as a runtime guarantee.

---

## Reverse proxy considerations

The gateway speaks plain HTTP inside the container and expects TLS termination in front.

Set `TRUST_PROXY=true` **only** when it really is behind a proxy you control. With it
enabled, Fastify believes `X-Forwarded-For` and `X-Forwarded-Proto`; if the port is exposed
directly to the internet, a client can then forge its own source IP and defeat per-IP rate
limiting.

Your proxy should terminate TLS with a certificate Telegram can verify, forward the
original `Host`, and set `X-Forwarded-Proto`. Do not strip
`X-Telegram-Bot-Api-Secret-Token`. Never expose the container port publicly at the same
time as trusting proxy headers.

---

## Container hardening

- Runs as the unprivileged `node` user (uid 1000), never root.
- `read_only: true` in Compose: the only writable paths are `/app/data` and a tmpfs `/tmp`.
- `no-new-privileges:true` blocks setuid escalation.
- `tini` as PID 1 reaps zombies and forwards `SIGTERM` for a clean shutdown.
- Multi-stage build: no compilers, package manager caches or source in the final image.

---

## Data retention

Events and deliveries are pruned on the schedule set by `EVENT_RETENTION_DAYS`,
`DELIVERY_RETENTION_DAYS` and `CLEANUP_INTERVAL_HOURS`. Raw update payloads contain
message text and user identifiers, so shorten these if you handle personal data — set a
retention of `0` only if you truly want unbounded growth. Response bodies captured from
destinations are truncated to `DELIVERY_MAX_RESPONSE_BODY_BYTES` (2 KiB default), and
signature headers are stripped before a delivery's request headers are recorded.

---

## Reporting a vulnerability

Please report security issues privately to the repository maintainer rather than opening a
public issue.
