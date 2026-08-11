#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: runtime-smoke-test.sh <image>" >&2
  exit 2
fi
image="$1"
suffix="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
container="gpubnb-developer-smoke-$suffix"
network="gpubnb-developer-smoke-$suffix"
volume="gpubnb-developer-smoke-$suffix"

cleanup() {
  status=$?
  if (( status != 0 )); then
    docker inspect --format 'state={{json .State}} ports={{json .NetworkSettings.Ports}}' "$container" 2>/dev/null || true
    docker logs --tail 200 "$container" 2>/dev/null || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker network create --internal "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d --name "$container" \
  --network "$network" \
  --publish 127.0.0.1::3000 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=512 --memory=4g --cpus=2 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --tmpfs /home/coder:rw,nosuid,size=512m,uid=1000,gid=1000,mode=0700 \
  --mount "type=volume,source=$volume,target=/workspace" \
  --entrypoint code-server "$image" \
  --bind-addr 0.0.0.0:3000 --auth none /workspace >/dev/null

for _ in $(seq 1 60); do
  running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)
  if [[ "$running" != "true" ]]; then
    echo "code-server exited before becoming healthy" >&2
    exit 1
  fi
  port=$(docker port "$container" 3000/tcp 2>/dev/null | sed -nE 's/.*127\.0\.0\.1:([0-9]+).*/\1/p' | head -n1 || true)
  if [[ -n "$port" ]] && curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null; then
    echo "code-server hardened runtime is healthy on loopback"
    exit 0
  fi
  sleep 0.5
done

echo "code-server did not become healthy within 30 seconds" >&2
exit 1
