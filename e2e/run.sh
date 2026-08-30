#!/usr/bin/env bash
# Real end-to-end harness for the GPUbnb Workspace workflow. See README.md.
# Every resource this script creates is prefixed gpubnb-e2e- and is torn down
# on exit (success or failure) by the trap below.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
API_DIR="../apps/api"
CONFIG_DIR="$(pwd)/.agent-config"
PG_PORT=15432
REDIS_PORT=16379
API_PORT=18787
DATABASE_URL="postgresql://gpubnb:gpubnb@localhost:${PG_PORT}/gpubnb?schema=public"
REDIS_URL="redis://:change-me@localhost:${REDIS_PORT}"

cleanup() {
  echo "--- cleanup ---"
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null || true
  GPUBNB_CONFIG_DIR="$CONFIG_DIR" gpubnb-agent stop 2>/dev/null || true
  docker rm -f gpubnb-e2e-pg gpubnb-e2e-redis 2>/dev/null || true
  docker ps -a --format '{{.Names}}' | grep '^gpubnb-dev-' | xargs -r docker rm -f 2>/dev/null || true
}
trap cleanup EXIT

echo "--- 1. disposable infrastructure ---"
docker rm -f gpubnb-e2e-pg gpubnb-e2e-redis 2>/dev/null || true
docker run -d --name gpubnb-e2e-pg -e POSTGRES_USER=gpubnb -e POSTGRES_PASSWORD=gpubnb -e POSTGRES_DB=gpubnb -p "${PG_PORT}:5432" postgres:17 >/dev/null
docker run -d --name gpubnb-e2e-redis -p "${REDIS_PORT}:6379" redis:7 redis-server --requirepass change-me >/dev/null
for i in $(seq 1 30); do docker exec gpubnb-e2e-pg pg_isready -U gpubnb >/dev/null 2>&1 && break; sleep 1; done

echo "--- 2. schema ---"
(cd "$API_DIR" && DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy >/dev/null)

echo "--- 2b. build (run.cjs requires apps/api/dist/*.js) ---"
(cd "$API_DIR" && npm run build >/dev/null)

echo "--- 3. real API server ---"
(cd "$API_DIR" && DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" PORT="$API_PORT" nohup npx tsx src/server.ts > /tmp/gpubnb-e2e-api.log 2>&1 &)
sleep 1
API_PID=$(netstat -ano 2>/dev/null | grep ":${API_PORT}" | grep LISTENING | awk '{print $NF}' | head -1 || true)
for i in $(seq 1 30); do curl -sf "http://localhost:${API_PORT}/ready" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://localhost:${API_PORT}/ready" || { echo "API never became ready — see /tmp/gpubnb-e2e-api.log"; exit 1; }

echo "--- 4. real isolated agent, real GPU/Docker detection ---"
rm -rf "$CONFIG_DIR" && mkdir -p "$CONFIG_DIR"
export GPUBNB_CONFIG_DIR="$CONFIG_DIR"
gpubnb-agent setup --api-url "http://localhost:${API_PORT}" >/dev/null

echo "--- 5. real wallet auth, pairing, link, agent start ---"
node run.cjs setup "http://localhost:${API_PORT}" "$DATABASE_URL"
