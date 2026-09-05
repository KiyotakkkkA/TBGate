# CLI

The gateway's command-line interface is a set of **pnpm scripts and Make targets** for
development, database maintenance and Docker operations. Run commands from the repository
root unless an example says otherwise.

Bot, route, destination and user management live in the admin panel and the
[HTTP API](API.md).

---

## Minimal walkthrough

Use Node.js 22+ and the pnpm version pinned in `package.json` (`12.3.4`). The shell examples
below use Bash; Make targets also need `make` and Unix command-line tools.

```bash
pnpm install
cp .env.example .env     # first setup only
pnpm secrets
```

Copy the generated values into `.env`, set `ADMIN_PASSWORD`, and use these local settings:

```ini
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:8080
DATABASE_URL=file:../data/gateway.sqlite
COOKIE_SECURE=false
```

Then:

```bash
pnpm db:migrate
pnpm dev
```

The API listens on port 8080 and the Vite dev server on port 5173. Open
`http://localhost:5173/admin` for the UI with hot reload. Vite proxies `/api`, `/health`
and `/ready` to the API. Stop both processes with `Ctrl+C`.

The server also applies migrations at startup, so the explicit migration step is useful
for checking the database before starting the application, but is not required at every boot.

---

## Development and builds

| Command                            | What it does                                       |
| ---------------------------------- | -------------------------------------------------- |
| `pnpm dev`                         | Run the API and admin UI together with hot reload  |
| `pnpm dev:api`                     | Run only the API with `tsx watch`                  |
| `pnpm dev:web`                     | Run only the Vite dev server                       |
| `pnpm build`                       | Build the frontend, then bundle the backend        |
| `pnpm start`                       | Run the built backend from `backend/dist/index.js` |
| `pnpm --filter ./frontend build`   | Build only the admin UI into `frontend/dist`       |
| `pnpm --filter ./backend build`    | Build only the server into `backend/dist`          |
| `pnpm --filter ./frontend preview` | Preview the built frontend with Vite               |

**Environment loading.** `pnpm dev:api` (including when started by `pnpm dev`) and
`pnpm db:migrate` explicitly load the root `.env`. `pnpm start` does not — supply the
environment through your process manager, Compose, or Node's `--env-file` option.

To run a local build with the root `.env`:

```bash
pnpm build
pnpm --filter ./backend exec node --env-file=../.env dist/index.js
```

The filtered command runs from `backend/`, so `../.env` points at the root file. Relative
`file:` database paths are resolved from that working directory too:
`file:../data/gateway.sqlite` points at the repository's `data/` directory.

If the API uses a different port, set Vite's proxy target in the shell:

```bash
VITE_DEV_API_URL=http://127.0.0.1:8090 pnpm dev:web
```

---

## Checks and formatting

| Command           | What it does                                                         |
| ----------------- | -------------------------------------------------------------------- |
| `pnpm typecheck`  | Type-check the workspace packages without emitting files             |
| `pnpm test`       | Run the backend Vitest suite once                                    |
| `pnpm test:watch` | Run Vitest in watch mode                                             |
| `pnpm lint`       | Invoke ESLint across the repository                                  |
| `pnpm lint:fix`   | Invoke ESLint and apply automatic fixes                              |
| `pnpm format`     | Rewrite supported files with Prettier                                |
| `pnpm test:e2e`   | Invoke `playwright test`; requires Playwright and browser-test setup |

To run one backend test file:

```bash
pnpm --filter ./backend exec vitest run test/unit.test.ts
```

To check a document's formatting without rewriting it:

```bash
pnpm exec prettier --check docs/CLI.md
```

---

## Database commands

| Command            | What it does                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `pnpm db:generate` | Generate SQL migrations from `backend/src/db/schema.ts` into `backend/drizzle` |
| `pnpm db:migrate`  | Apply pending migrations to `DATABASE_URL`                                     |
| `pnpm db:studio`   | Open Drizzle Studio against the configured database                            |

After changing the schema:

```bash
pnpm db:generate
# Review the generated SQL in backend/drizzle/.
pnpm db:migrate
```

`db:generate` and `db:studio` use `backend/drizzle.config.ts`, which reads `DATABASE_URL`
from the process environment and defaults to `file:../data/gateway.sqlite`. Their scripts
do not explicitly load the root `.env`. Pass the URL when inspecting a different database:

```bash
DATABASE_URL=file:/absolute/path/gateway.sqlite pnpm db:studio
```

`db:migrate` prints `Migration complete` on success and exits with a nonzero status on
failure. `MIGRATIONS_DIR` can point it at an alternative migration directory containing
`meta/_journal.json`.

For production backups and restores, see [Deployment → Backups](DEPLOYMENT.md#backups).

---

## Generating secrets

```bash
pnpm secrets
# Or, without pnpm:
node scripts/generate-secrets.mjs
```

Prints a fresh `APP_ENCRYPTION_KEY` (32 random bytes, hex encoded) and `SESSION_SECRET`
(48 random bytes, base64 encoded). It does not edit `.env` or update the running server.

Copy the values during initial setup and back up the encryption key. Replacing that key
on an existing installation makes stored secrets unreadable; see
[Security → The master key](SECURITY.md#the-master-key).

---

## Make shortcuts

`make help` lists the available targets. The Makefile reads the root `.env` and exports
its variables to child commands.

| Target            | Equivalent command |
| ----------------- | ------------------ |
| `make install`    | `pnpm install`     |
| `make dev`        | `pnpm dev`         |
| `make build`      | `pnpm build`       |
| `make start`      | `pnpm start`       |
| `make lint`       | `pnpm lint`        |
| `make typecheck`  | `pnpm typecheck`   |
| `make test`       | `pnpm test`        |
| `make test-e2e`   | `pnpm test:e2e`    |
| `make db-migrate` | `pnpm db:migrate`  |
| `make db-studio`  | `pnpm db:studio`   |
| `make secrets`    | `pnpm secrets`     |

`make clean` removes `backend/dist`, `backend/public`, `frontend/dist` and the root,
backend, frontend and shared `node_modules` directories. It keeps `.env` and `data/`.
Run `pnpm install` and `pnpm build` to restore dependencies and build output.

---

## Docker commands

| Target                | What it does                                                            |
| --------------------- | ----------------------------------------------------------------------- |
| `make docker-up`      | Run `docker compose up -d --build`                                      |
| `make docker-down`    | Run `docker compose down`; keep the bind-mounted `data/` directory      |
| `make docker-restart` | Recreate the container with `docker compose up -d --force-recreate`     |
| `make docker-logs`    | Follow Compose logs, starting with the last 100 lines                   |

```bash
make docker-up
make docker-logs
```

`docker-restart` recreates the container; use `docker-up` when source changes need an
image rebuild. For TLS, persistence and upgrade procedures, see [Deployment](DEPLOYMENT.md).
