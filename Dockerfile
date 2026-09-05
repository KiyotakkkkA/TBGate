# syntax=docker/dockerfile:1.7
###############################################################################
# Telegram Gateway - production image
#
# Multi-stage build:
#   deps    installs the full workspace (dev dependencies included)
#   build   compiles the admin SPA and bundles the Fastify server
#   runtime slim Alpine image with production dependencies and a non-root user
#
# The result is a single container: one Node process serves both the HTTP API
# and the pre-built admin panel, with SQLite on a mounted volume at /app/data.
###############################################################################

ARG NODE_VERSION=22-alpine

# ─────────────────────────────────────────────────────────────── deps ──────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# Corepack pins pnpm to the version in package.json's `packageManager` field.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# ────────────────────────────────────────────────────────────── build ──────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend

# The admin SPA is compiled to static assets; the server bundles to a single ESM file.
RUN pnpm --filter ./frontend build && \
    pnpm --filter ./backend build && \
    cp -r frontend/dist backend/public

# Production-only dependency tree for the runtime stage.
RUN pnpm --filter ./backend --prod deploy --legacy /app/deploy

# ──────────────────────────────────────────────────────────── runtime ──────
FROM node:${NODE_VERSION} AS runtime

LABEL org.opencontainers.image.title="Telegram Gateway" \
      org.opencontainers.image.description="Self-hosted Telegram Bot Gateway and webhook router with an admin panel" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/OWNER/telegram-gateway" \
      org.opencontainers.image.documentation="https://github.com/OWNER/telegram-gateway#readme"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_URL=file:/app/data/gateway.sqlite

WORKDIR /app

# wget backs the HEALTHCHECK; tini reaps zombies and forwards SIGTERM for a clean shutdown.
RUN apk add --no-cache tini wget

# node:alpine already ships an unprivileged `node` user (uid 1000).
COPY --from=build --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /app/deploy/package.json ./package.json
COPY --from=build --chown=node:node /app/backend/dist ./dist
COPY --from=build --chown=node:node /app/backend/drizzle ./drizzle
COPY --from=build --chown=node:node /app/backend/public ./public

# Mount point for the SQLite database. Owned by `node` so the volume is writable.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

ENV STATIC_DIR=/app/public \
    MIGRATIONS_DIR=/app/drizzle

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
