# Convenience targets. Everything here is also available as a pnpm script;
# the Makefile mainly wraps the Docker workflow.
#
# The Docker Hub account is never hardcoded - set DOCKERHUB_USERNAME in .env or
# pass it on the command line:  make docker-push DOCKERHUB_USERNAME=youruser

-include .env
export

IMAGE_NAME ?= telegram-gateway
IMAGE_TAG  ?= latest
VERSION    ?= $(shell node -p "require('./package.json').version")
PLATFORMS  ?= linux/amd64,linux/arm64

ifdef DOCKERHUB_USERNAME
IMAGE := $(DOCKERHUB_USERNAME)/$(IMAGE_NAME)
else
IMAGE := $(IMAGE_NAME)
endif

.PHONY: help install dev build start lint typecheck test test-e2e db-migrate db-studio \
        secrets docker-build docker-buildx docker-push docker-up docker-down docker-logs \
        docker-restart clean

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

docker-build: ## Build the production image locally
	docker build -t $(IMAGE):$(IMAGE_TAG) -t $(IMAGE):$(VERSION) .

docker-buildx: ## Build a multi-architecture image (requires buildx)
	docker buildx build --platform $(PLATFORMS) -t $(IMAGE):$(IMAGE_TAG) -t $(IMAGE):$(VERSION) .

docker-push: ## Build and push :latest and :$(VERSION) to Docker Hub
ifndef DOCKERHUB_USERNAME
	$(error DOCKERHUB_USERNAME is not set. Add it to .env or pass DOCKERHUB_USERNAME=youruser)
endif
	docker buildx build --platform $(PLATFORMS) \
		-t $(IMAGE):$(VERSION) -t $(IMAGE):$(IMAGE_TAG) --push .

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
