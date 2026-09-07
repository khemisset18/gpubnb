#!/usr/bin/env bash
# Real recovery-scenario harness: kills the real agent process mid-session and
# proves the system recovers safely. See recovery-agent-restart.cjs and README.md.
# Uses its own disposable resource names/ports (gpubnb-recovery-*, 15532/16479/18887)
# so it can run independently of run.sh. Workspace cleanup is limited to
# GPUbnb-owned resources that did not exist when this harness started.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
API_DIR="../apps/api"
CONFIG_DIR="$(pwd)/.agent-config"
PG_PORT=15532
REDIS_PORT=16479
API_PORT=18887
DATABASE_URL="postgresql://gpubnb:gpubnb@localhost:${PG_PORT}/gpubnb?schema=public"
REDIS_URL="redis://:change-me@localhost:${REDIS_PORT}"

BASELINE_CONTAINERS="$(mktemp)"
BASELINE_VOLUMES="$(mktemp)"
BASELINE_NETWORKS="$(mktemp)"

snapshot_gpu_workspace_resources() {
  (docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^gpubnb-dev-' | sort > "$BASELINE_CONTAINERS") || true
  (docker volume ls --format '{{.Name}}' 2>/dev/null | grep '^gpubnb-workspace-' | sort > "$BASELINE_VOLUMES") || true
  (docker network ls --format '{{.Name}}' 2>/dev/null | grep '^gpubnb-workspace-internal-' | sort > "$BASELINE_NETWORKS") || true
}

remove_new_gpu_workspace_resources() {
  local name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! grep -Fxq -- "$name" "$BASELINE_CONTAINERS"; then
      docker rm -f "$name" >/dev/null 2>&1 || true
    fi
  done < <((docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^gpubnb-dev-') || true)

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! grep -Fxq -- "$name" "$BASELINE_VOLUMES"; then
      docker volume rm -f "$name" >/dev/null 2>&1 || true
    fi
  done < <((docker volume ls --format '{{.Name}}' 2>/dev/null | grep '^gpubnb-workspace-') || true)

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! grep -Fxq -- "$name" "$BASELINE_NETWORKS"; then
      docker network rm "$name" >/dev/null 2>&1 || true
    fi
  done < <((docker network ls --format '{{.Name}}' 2>/dev/null | grep '^gpubnb-workspace-internal-') || true)
}

snapshot_gpu_workspace_resources

cleanup() {
  echo "--- cleanup ---"
  if [ -n "${API_PID:-}" ]; then
    taskkill //F //T //PID "$API_PID" 2>/dev/null || kill "$API_PID" 2>/dev/null || true
  fi
  GPUBNB_CONFIG_DIR="$CONFIG_DIR" gpubnb-agent stop 2>/dev/null || true
  remove_new_gpu_workspace_resources
  docker rm -f gpubnb-recovery-pg gpubnb-recovery-redis 2>/dev/null || true
  rm -f "$BASELINE_CONTAINERS" "$BASELINE_VOLUMES" "$BASELINE_NETWORKS"
}
trap cleanup EXIT

echo "--- 1. disposable infrastructure ---"
docker rm -f gpubnb-recovery-pg gpubnb-recovery-redis 2>/dev/null || true
docker run -d --name gpubnb-recovery-pg -e POSTGRES_USER=gpubnb -e POSTGRES_PASSWORD=gpubnb -e POSTGRES_DB=gpubnb -p "${PG_PORT}:5432" postgres:17 >/dev/null
docker run -d --name gpubnb-recovery-redis -p "${REDIS_PORT}:6379" redis:7 redis-server --requirepass change-me >/dev/null
for i in $(seq 1 30); do docker exec gpubnb-recovery-pg pg_isready -U gpubnb >/dev/null 2>&1 && break; sleep 1; done

echo "--- 2. schema + build ---"
(cd "$API_DIR" && DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy >/dev/null)
(cd "$API_DIR" && npm run build >/dev/null)

echo "--- 3. real API server ---"
(cd "$API_DIR" && DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" PORT="$API_PORT" nohup npx tsx src/server.ts > /tmp/gpubnb-recovery-api.log 2>&1 &)
for i in $(seq 1 30); do curl -sf "http://localhost:${API_PORT}/ready" >/dev/null 2>&1 && break; sleep 1; done
API_PID=$(netstat -ano 2>/dev/null | grep ":${API_PORT}" | grep LISTENING | awk '{print $NF}' | head -1 || true)
curl -sf "http://localhost:${API_PORT}/ready" || { echo "API never became ready — see /tmp/gpubnb-recovery-api.log"; exit 1; }

echo "--- 4. real isolated agent ---"
rm -rf "$CONFIG_DIR" && mkdir -p "$CONFIG_DIR"
export GPUBNB_CONFIG_DIR="$CONFIG_DIR"
gpubnb-agent setup --api-url "http://localhost:${API_PORT}" >/dev/null || true

echo "--- 5. real recovery scenario ---"
node recovery-agent-restart.cjs setup "http://localhost:${API_PORT}" "$DATABASE_URL"
