-include .env
export

.PHONY: help install dev build start lint typecheck test test-e2e db-migrate db-studio \
        secrets docker-up docker-down docker-logs docker-restart clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

## ── development ───────────────────────────────────────────────────────────

install: ## Install workspace dependencies
	pnpm install

dev: ## Run the API and the admin UI with hot reload
	pnpm dev

build: ## Build the admin UI and the server bundle
	pnpm build

start: ## Run the built server
	pnpm start

lint: ## Lint the workspace
	pnpm lint

typecheck: ## Type-check every package
	pnpm typecheck

test: ## Run the test suite
	pnpm test

test-e2e: ## Run browser tests
	pnpm test:e2e

db-migrate: ## Apply database migrations
	pnpm db:migrate

db-studio: ## Open Drizzle Studio
	pnpm db:studio

secrets: ## Generate APP_ENCRYPTION_KEY and SESSION_SECRET
	@pnpm secrets

## ── docker ────────────────────────────────────────────────────────────────

docker-up: ## Start the stack in the background
	docker compose up -d --build

docker-down: ## Stop the stack (the ./data volume is kept)
	docker compose down

docker-restart: ## Recreate the container with the current image
	docker compose up -d --force-recreate

docker-logs: ## Follow container logs
	docker compose logs -f --tail=100

clean: ## Remove build output and node_modules
	rm -rf backend/dist backend/public frontend/dist
	rm -rf node_modules backend/node_modules frontend/node_modules shared/node_modules
