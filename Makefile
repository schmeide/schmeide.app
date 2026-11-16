# Apple's /usr/bin/make 3.81 ignores .SHELLFLAGS, so every recipe below would fail cryptically.
ifneq (,$(filter 3.% 2.%,$(MAKE_VERSION)))
$(error GNU make 4 or newer is required (this is $(MAKE_VERSION)). Install it with `brew install make`, then run `gmake` instead of `make`)
endif

SHELL := /usr/bin/env
.SHELLFLAGS = bash -e -o pipefail -c
.DEFAULT_GOAL := help
.NOTPARALLEL:
.SILENT:
.ONESHELL:

ifndef VERBOSE
MAKEFLAGS += --no-print-directory
endif

ifneq (,$(wildcard ./.env))
	include .env
	export
endif

JS_EXEC ?= npm
JS_INSTALL ?= install

OUT_DIR ?= ./dist

# Platform server (server/). Ports match compose.yaml.
PORT ?= 3100
DATABASE_URL ?= postgres://postgres:postgres@localhost:5440/schmeide
TEST_DATABASE_URL ?= postgres://postgres:postgres@localhost:5441/schmeide
TEMPORAL_ADDRESS ?= localhost:7233
SCHMEIDE_DATA_DIR ?= $(HOME)/.schmeide
SCHMEIDE_TEMPLATE ?= https://github.com/schmeide/template.git
SCHMEIDE_AGENT_MODEL ?= opus
export PORT DATABASE_URL TEMPORAL_ADDRESS SCHMEIDE_DATA_DIR SCHMEIDE_TEMPLATE SCHMEIDE_AGENT_MODEL

NODE_VERSION := $(shell cat .nvmrc 2>/dev/null)
NVM_DIR ?= $(HOME)/.nvm

# A non-interactive SSH shell never sources nvm.sh, so `node` is off PATH even
# when nvm installed it. Fall back to the nvm directory: the version in .nvmrc
# first, then the newest one present.
NODE_BIN ?= $(shell { \
	command -v node 2>/dev/null || true; \
	ls -1 $(NVM_DIR)/versions/node/v$(NODE_VERSION)*/bin/node 2>/dev/null | sort -V | tail -1 || true; \
	ls -1 $(NVM_DIR)/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1 || true; \
	} | head -1)

ifneq (,$(NODE_BIN))
export PATH := $(patsubst %/,%,$(dir $(NODE_BIN))):$(PATH)
endif

##@ Development Environment

.PHONY: setup
setup: setup/js ## Set up development environment

.PHONY: setup/js
setup/js: ## Install Node.js via nvm and project dependencies
	if ! [ -s "$$HOME/.nvm/nvm.sh" ]; then \
		curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash; \
	fi
	. $$HOME/.nvm/nvm.sh
	nvm install
	$(JS_EXEC) $(JS_INSTALL)
	touch node_modules/.installed

##@ Build

.PHONY: build
build: build/ts ## Build the deployable static site (what CI/CD ship)

.PHONY: build/ts
build/ts: ## Typecheck and bundle with Vite into ./dist
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run build

.PHONY: clean
clean: ## Clean build artifacts
	rm -rf \
		$(OUT_DIR) \
		./coverage \
		./node_modules/.vite \
		./node_modules/.tmp

.PHONY: serve
serve: infra/up node_modules ## Infra, migrations, the platform server on :3100, and Vite on :5173 (proxies /api)
	$(MAKE) db/migrate
	echo "App: http://localhost:5173  API: http://localhost:$(PORT)/api  Temporal UI: http://localhost:8233"
	$(JS_EXEC) exec concurrently -- -k -n server,web "$(JS_EXEC) run start -w server" "$(JS_EXEC) run dev"

.PHONY: serve/watch
serve/watch: infra/up node_modules ## Like serve, but the server reloads on code changes (a reload restarts a running build's step)
	$(MAKE) db/migrate
	echo "App: http://localhost:5173  API: http://localhost:$(PORT)/api  Temporal UI: http://localhost:8233"
	$(JS_EXEC) exec concurrently -- -k -n server,web "$(JS_EXEC) run dev -w server" "$(JS_EXEC) run dev"

.PHONY: serve/web
serve/web: node_modules ## Run only the Vite dev server
	$(JS_EXEC) run dev

.PHONY: serve/server
serve/server: node_modules ## Run only the platform server (API + Temporal worker), no reload
	$(JS_EXEC) run start -w server

.PHONY: serve/prod
serve/prod: build ## Serve the built static site locally
	$(JS_EXEC) run preview

##@ Infrastructure

.PHONY: infra/up
infra/up: docker/check ## Start Postgres (:5440) and the Temporal dev server (:7233, UI :8233)
	docker compose up -d --wait db temporal

.PHONY: infra/down
infra/down: docker/check ## Stop the infrastructure (the database volume is kept)
	docker compose --profile test down

.PHONY: db/migrate
db/migrate: node_modules ## Apply server/drizzle migrations to DATABASE_URL
	$(JS_EXEC) run db:migrate -w server

.PHONY: db/generate
db/generate: node_modules ## Generate a migration from server/src/db/schema.ts (NAME=create_widgets to name it)
	$(JS_EXEC) run db:generate -w server $(if $(NAME),-- --name $(NAME))
	$(JS_EXEC) exec prettier -- --write server/drizzle >/dev/null

.PHONY: doctor
doctor: node_modules ## Check Docker, claude, git, node, the template, ports, and leftover app containers; print each fix
	bash server/scripts/doctor.sh

##@ Testing

.PHONY: test
test: docker/check node_modules ## Run all tests once (server tests against a throwaway Postgres on :5441)
	trap 'docker compose --profile test down test-db >/dev/null 2>&1' EXIT
	docker compose --profile test up -d --wait test-db
	$(JS_EXEC) run test
	$(MAKE) test/server DATABASE_URL=$(TEST_DATABASE_URL)

.PHONY: test/server
test/server: node_modules ## Migrate and run server tests against an existing DATABASE_URL (no Docker)
	$(MAKE) db/migrate
	$(JS_EXEC) run test -w server

.PHONY: e2e
e2e: node_modules ## Real Claude run of the to-do fixture against `make serve`, then delete it (KEEP=1 keeps it)
	$(JS_EXEC) run e2e -w server

E2E_FAKE_PORT ?= 3199

.PHONY: e2e/fake
e2e/fake: infra/up node_modules ## Fake-agent run on its own server (:3199): two projects at once plus a queued change; no Claude usage
	$(MAKE) db/migrate
	mkdir -p $(SCHMEIDE_DATA_DIR)/logs
	log=$(SCHMEIDE_DATA_DIR)/logs/e2e-fake-server.log
	(cd server && PORT=$(E2E_FAKE_PORT) SCHMEIDE_TASK_QUEUE=schmeide-fake \
		SCHMEIDE_AGENT_CMD=$(CURDIR)/server/e2e/fake-agent.sh exec node src/main.ts) >$$log 2>&1 &
	server=$$!
	trap 'kill $$server 2>/dev/null || true' EXIT
	until curl -sf localhost:$(E2E_FAKE_PORT)/api/healthz >/dev/null; do
		if ! kill -0 $$server 2>/dev/null; then echo "Error: the fake-agent server exited; see $$log"; exit 1; fi
		sleep 1
	done
	PORT=$(E2E_FAKE_PORT) E2E_CONCURRENT=1 $(JS_EXEC) run e2e -w server

.PHONY: test/watch
test/watch: ## Run tests in watch mode
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run test:watch

##@ Dependencies

.PHONY: deps
deps: ## Install dependencies
	$(JS_EXEC) $(JS_INSTALL)

.PHONY: upgrade
upgrade: upgrade/ts ## Upgrade all dependencies

.PHONY: upgrade/ts
upgrade/ts: ## Upgrade npm dependencies
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run check-updates
	$(JS_EXEC) $(JS_INSTALL)

##@ Code Quality

.PHONY: check
check: check/ts ## Check code quality

.PHONY: check/ts
check/ts: ## Check code quality (eslint, tsc, prettier, markdown)
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run lint

.PHONY: lint
lint: lint/ts ## Lint codebase

.PHONY: lint/ts
lint/ts: ## Lint TypeScript and React code
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run lint

.PHONY: format
format: format/ts ## Format code

.PHONY: format/ts
format/ts: ## Format code (Prettier)
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run fix:prettier

.PHONY: fix
fix: fix/ts ## Fix lint and format errors

.PHONY: fix/ts
fix/ts: ## Fix lint and format errors
	if ! [[ -d ./node_modules ]]; then \
		$(JS_EXEC) $(JS_INSTALL); \
	fi
	$(JS_EXEC) run fix

##@ Helpers

# Installs dependencies when node_modules is missing or older than any manifest
# or the lockfile, so a pulled change (a new workspace dependency such as
# drizzle-kit) is installed instead of failing with "command not found".
.PHONY: node_modules
node_modules: node_modules/.installed

node_modules/.installed: package.json package-lock.json server/package.json
	$(JS_EXEC) $(JS_INSTALL)
	touch node_modules/.installed

.PHONY: docker/check
docker/check:
	if ! command -v docker >/dev/null 2>&1; then \
		echo "Error: docker not found. Install Docker (https://docs.docker.com/get-docker/) and retry."; \
		exit 1; \
	fi
	if ! out=$$(docker info 2>&1 >/dev/null); then \
		echo "Error: cannot reach the Docker daemon. Is it running, and are you allowed to use it?"; \
		echo "$$out"; \
		exit 1; \
	fi

env-%: ## Check if env var is defined
	if [ -z "$($*)" ]; then \
		echo "Error: Environment variable '$*' is not set."; \
		exit 1; \
	fi

.PHONY: help
help: ## Display this help
	awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z0-9_\/-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)
