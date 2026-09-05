# Deployment

Target shape: **one container + a persistent volume + a reverse proxy that terminates
TLS.** Nothing else is required.

---

## Minimal walkthrough

```bash
mkdir telegram-gateway && cd telegram-gateway

# Copy docker-compose.yml and .env.example from the repository
cp .env.example .env
mkdir -p data

# Generate the two required secrets
openssl rand -hex 32      # → APP_ENCRYPTION_KEY
openssl rand -base64 48   # → SESSION_SECRET
```

Edit `.env` and set at least:

```ini
PUBLIC_BASE_URL=https://telegram.example.com
ADMIN_PASSWORD=<a strong password>
APP_ENCRYPTION_KEY=<the hex value you just generated>
SESSION_SECRET=<the base64 value you just generated>
TRUST_PROXY=true
```

Then:

```bash
docker compose up -d
docker compose logs -f
```

Wait for `Telegram Gateway is ready`, then open `https://telegram.example.com/admin`, sign
in as `ADMIN_USERNAME`, and change the password immediately.

---

## Using a published image

Drop the `build:` block from `docker-compose.yml` and pin an image:

```yaml
services:
  telegram-gateway:
    image: youruser/telegram-gateway:1.0.0
    restart: unless-stopped
    ports:
      - '8080:8080'
    env_file:
      - .env
    volumes:
      - ./data:/app/data
```

Pin an exact version in production rather than `latest`, so a redeploy is never a surprise
upgrade.

---

## Reverse proxy examples

The container serves plain HTTP on 8080. In every example below, set `TRUST_PROXY=true` and
do **not** publish port 8080 to the internet directly.

### Caddy (recommended)

```caddy
telegram.example.com {
    encode zstd gzip
    reverse_proxy telegram-gateway:8080
}
```

Certificates are obtained and renewed automatically. As a Compose service:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - gateway

  telegram-gateway:
    image: youruser/telegram-gateway:latest
    restart: unless-stopped
    env_file: [.env]
    volumes:
      - ./data:/app/data
    networks:
      - gateway
    # No `ports:` — only Caddy is reachable from outside.

volumes:
  caddy_data:
  caddy_config:

networks:
  gateway:
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name telegram.example.com;

    ssl_certificate     /etc/letsencrypt/live/telegram.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/telegram.example.com/privkey.pem;

    # Telegram updates are small; this is generous.
    client_max_body_size 2m;

    location / {
        proxy_pass http://telegram-gateway:8080;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 10s;
        proxy_read_timeout    60s;
    }
}

server {
    listen 80;
    server_name telegram.example.com;
    return 301 https://$host$request_uri;
}
```

Nginx forwards all headers it is not told to drop, so
`X-Telegram-Bot-Api-Secret-Token` passes through unchanged.

### Traefik

```yaml
services:
  telegram-gateway:
    image: youruser/telegram-gateway:latest
    restart: unless-stopped
    env_file: [.env]
    volumes:
      - ./data:/app/data
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.tgw.rule=Host(`telegram.example.com`)'
      - 'traefik.http.routers.tgw.entrypoints=websecure'
      - 'traefik.http.routers.tgw.tls.certresolver=letsencrypt'
      - 'traefik.http.services.tgw.loadbalancer.server.port=8080'
    networks:
      - proxy

networks:
  proxy:
    external: true
```

### Cloudflare Tunnel

No inbound ports at all:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
    networks: [gateway]

  telegram-gateway:
    image: youruser/telegram-gateway:latest
    restart: unless-stopped
    env_file: [.env]
    volumes:
      - ./data:/app/data
    networks: [gateway]

networks:
  gateway:
```

Route the tunnel hostname to `http://telegram-gateway:8080` and set `PUBLIC_BASE_URL` to
the public hostname.

---

## Routing to your own services

Destinations can address any container on a shared Docker network by service name:

```yaml
services:
  telegram-gateway:
    # …
    networks: [gateway]

  python-worker:
    image: your-org/python-worker:latest
    environment:
      TG_GATEWAY_SIGNING_SECRET: ${WORKER_SIGNING_SECRET}
    networks: [gateway]     # same network — this is what makes the name resolvable

networks:
  gateway:
```

Then create a destination with URL `http://python-worker:8000/events`. This requires
`DESTINATION_ALLOW_PRIVATE_NETWORKS=true` (the default), because container IPs are private.

If a delivery fails with `DNS_ERROR`, the two containers are not on the same network.

---

## Persistence

```yaml
volumes:
  - ./data:/app/data      # → /app/data/gateway.sqlite
```

That single file holds bots, destinations, routes, events, deliveries, users and API keys.
Nothing else in the container is persistent. The rest of the filesystem is mounted
read-only, so there is nowhere else state could accidentally accumulate.

**Permissions.** The container runs as uid 1000. If you use a bind mount on Linux and hit
permission errors, run `sudo chown -R 1000:1000 ./data`. A named volume avoids the issue
entirely.

### Backups

```bash
# Consistent, a few seconds of downtime:
docker compose stop telegram-gateway
tar czf tgw-backup-$(date +%F).tar.gz data/
docker compose start telegram-gateway

# Or online, if sqlite3 is available on the host:
sqlite3 data/gateway.sqlite ".backup 'tgw-backup-$(date +%F).sqlite'"
```

A plain `cp` of a running WAL-mode database can miss recently committed data — use one of
the above.

**Back up `APP_ENCRYPTION_KEY` too, and store it separately.** The database is useless
without it. Restoring is the reverse: stop, replace `data/`, ensure the key matches, start.

---

## Upgrading

```bash
docker compose pull
docker compose up -d
docker compose logs -f
```

Migrations run automatically at boot under a lock, so a fresh image can safely start
against an existing volume. Pending deliveries survive the restart and resume.

To roll back, pin the previous image tag and restart. Schema migrations are additive, so an
older image generally starts against a newer database — but take a backup before upgrading
anyway.

**Zero-downtime.** Not supported by design: SQLite has a single writer, so two containers
must not share the volume. A restart is a few seconds, and Telegram retries anything it
could not deliver during the gap.

---

## Docker Hub publishing

```bash
docker login

docker build \
  -t $DOCKERHUB_USERNAME/telegram-gateway:1.0.0 \
  -t $DOCKERHUB_USERNAME/telegram-gateway:latest \
  .

docker push $DOCKERHUB_USERNAME/telegram-gateway:1.0.0
docker push $DOCKERHUB_USERNAME/telegram-gateway:latest
```

Multi-architecture (amd64 + arm64) in one step:

```bash
docker buildx create --use --name tgw-builder      # first time only

docker buildx build --platform linux/amd64,linux/arm64 \
  -t $DOCKERHUB_USERNAME/telegram-gateway:1.0.0 \
  -t $DOCKERHUB_USERNAME/telegram-gateway:latest \
  --push .
```

Or via the Makefile, which never hardcodes an account:

```bash
make docker-push DOCKERHUB_USERNAME=youruser
```

### Automated publishing

Push a `v*` tag and the `docker-publish` workflow builds and pushes for you:

```bash
git tag v1.0.0
git push origin v1.0.0
```

It needs two repository secrets: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub
**access token**, created under Account Settings → Security — not your account password).

---

## Health checks and monitoring

| Endpoint | Use |
| --- | --- |
| `/health` | Liveness. Cheap, always 200 while the process runs. |
| `/ready` | Readiness. 503 when the database is unreachable. |

The image ships a `HEALTHCHECK` against `/health`, so `docker ps` shows `(healthy)`. For an
external monitor, poll `/ready` — it is the one that actually verifies a dependency.

Logs are JSON on stdout, ready for any collector. Compose rotates them at 10 MB × 3 files.

---

## Operational checklist

Before exposing a deployment publicly:

- [ ] `APP_ENCRYPTION_KEY` and `SESSION_SECRET` are freshly generated, not copied from a
      guide, and backed up.
- [ ] `ADMIN_PASSWORD` was changed from the UI after the first sign-in.
- [ ] `PUBLIC_BASE_URL` exactly matches the public HTTPS URL.
- [ ] `COOKIE_SECURE=true` and TLS terminates in front of the container.
- [ ] `TRUST_PROXY=true` **and** port 8080 is not published directly to the internet.
- [ ] `./data` is on durable storage and included in your backup routine.
- [ ] Retention values suit your data-protection requirements.
- [ ] `DESTINATION_ALLOW_PRIVATE_NETWORKS` matches your topology (`true` only if you
      actually route to internal services).
- [ ] Each downstream service verifies the HMAC signature and rejects stale timestamps.
