# LotLogic - Unified Build & Deploy Commands
# Usage: make <target>

.PHONY: help build-frontend build-puller build-monitoring build-all \
        run-frontend run-puller run-monitoring \
        up down logs restart health \
        migrate status

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

# ── Docker Compose (recommended) ──────────────────────

up: ## Start all services (puller + monitoring)
	docker compose up -d --build

down: ## Stop all services
	docker compose down

restart: ## Restart all services
	docker compose restart

logs: ## Tail logs from all services
	docker compose logs -f

health: ## Check service health
	@docker compose ps
	@echo ""
	@echo "── Puller Health ──"
	@docker exec lotlogic-puller python /app/healthcheck.py 2>/dev/null || echo "Container not running"
	@echo ""
	@echo "── Camera Heartbeats ──"
	@curl -s -H "X-API-Key: $${LOTLOGIC_API_KEY}" "https://lotlogic-backend-production.up.railway.app/cameras?lot_id=$${LOT_ID}" 2>/dev/null | python3 -c "import sys,json;[print(f'  {c[\"name\"]}: {c.get(\"last_heartbeat\",\"never\")}') for c in json.load(sys.stdin)]" 2>/dev/null || echo "  (set LOTLOGIC_API_KEY and LOT_ID env vars)"

# ── Database ───────────────────────────────────────────

migrate: ## Run database migrations
	docker build -t lotlogic-migrate -f puller/Dockerfile.migrate puller/
	docker run --rm --env-file puller/.env lotlogic-migrate

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
