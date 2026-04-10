# LotLogic - Unified Build & Deploy Commands
# Usage: make <target>

.PHONY: help build-frontend build-puller build-monitoring build-all \
        run-frontend run-puller run-monitoring \
        migrate logs status

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Build ──────────────────────────────────────────────

build-frontend: ## Build the frontend Docker image
	docker build -t lotlogic-frontend -f frontend/Dockerfile frontend/

build-puller: ## Build the snapshot puller Docker image
	docker build -t lotlogic-puller -f puller/Dockerfile puller/

build-monitoring: ## Build the monitoring agents Docker image
	docker build -t lotlogic-monitoring -f monitoring/Dockerfile monitoring/

build-all: build-frontend build-puller build-monitoring ## Build all Docker images

# ── Run Locally ────────────────────────────────────────

run-frontend: build-frontend ## Run frontend locally on port 8080
	docker run --rm -p 8080:8080 lotlogic-frontend

run-puller: build-puller ## Run snapshot puller locally
	docker run --rm --env-file puller/.env lotlogic-puller

run-monitoring: build-monitoring ## Run monitoring agents locally
	docker run --rm --env-file monitoring/.env lotlogic-monitoring

# ── Database ───────────────────────────────────────────

migrate: ## Run database migrations
	docker build -t lotlogic-migrate -f puller/Dockerfile.migrate puller/
	docker run --rm --env-file puller/.env lotlogic-migrate

# ── Lead Gen ───────────────────────────────────────────

run-leadgen: ## Run lead gen CLI (pass ARGS="stats" etc.)
	python -m leadgen.cli $(ARGS)

install-leadgen: ## Install lead gen Python dependencies
	pip install -r leadgen/requirements.txt

# ── Agent ──────────────────────────────────────────────

install-agent: ## Install agent Python dependencies
	pip install -r agent/requirements.txt -r leadgen/requirements.txt

run-agent-dry: ## Run the lead gen agent in dry-run mode (no emails, no writes)
	DRY_RUN=true python -m agent.run

run-agent: ## Run the lead gen agent (live mode)
	python -m agent.run

migrate-leadgen: ## Migrate local SQLite leads.db to Supabase
	python -m leadgen.db_migrate

build-agent: ## Build the agent Docker image
	docker build -t lotlogic-agent -f agent/Dockerfile .

# ── Status ─────────────────────────────────────────────

status: ## Show git status and branch info
	@echo "── Branch ──"
	@git branch --show-current
	@echo ""
	@echo "── Status ──"
	@git status --short
	@echo ""
	@echo "── Services ──"
	@echo "Frontend:   frontend/"
	@echo "Puller:     puller/"
	@echo "Monitoring: monitoring/"
	@echo "Backend:    backend/ (modules imported by external API)"
	@echo "Migrations: migrations/"
