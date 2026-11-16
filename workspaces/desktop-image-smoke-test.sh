#!/usr/bin/env bash
# CPU-only packaging/liveness check, never GPU, video or input qualification.
set -euo pipefail
slug="${1:?workspace slug required}"
image="${2:?local candidate image required}"
case "$slug" in creator|cloud-desktop|cad|gaming) ;; *) exit 2 ;; esac
container="gpubnb-ci-desktop-${slug}-${RANDOM}"
network="${container}-net"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run --rm --network=none --entrypoint /bin/sh "$image" -ec '
  command -v eglinfo >/dev/null
  test -x /init
  test -x /usr/local/bin/gpubnb-desktop-liveness
  sh -n /usr/local/bin/gpubnb-desktop-liveness
'
case "$slug" in
  creator) docker run --rm --network=none --entrypoint /bin/sh "$image" -ec 'command -v blender' ;;
  cad) docker run --rm --network=none --entrypoint /bin/sh "$image" -ec 'command -v freecad' ;;
  gaming) docker run --rm --network=none --entrypoint /bin/sh "$image" -ec 'test -x /usr/games/steam' ;;
esac
# The documented Webtop lab profile needs a writable root and s6 capabilities.
# No GPU, host devices, host paths, registry publishing or public port here.
docker network create --internal "$network" >/dev/null
docker run -d --name "$container" --network "$network" \
  --security-opt=no-new-privileges --pids-limit=1024 --memory=4g --cpus=2 \
  --shm-size=1g --tmpfs=/tmp:rw,exec,nosuid,size=1024m \
  --tmpfs=/config:rw,exec,nosuid,size=512m \
  --env PUID=1000 --env PGID=1000 \
  --publish 127.0.0.1::3000 "$image" >/dev/null
port="$(docker port "$container" 3000/tcp | sed -n 's/^127\.0\.0\.1://p')"
test -n "$port"
ready=false
for attempt in $(seq 1 90); do
  if docker exec "$container" /usr/local/bin/gpubnb-desktop-liveness >/dev/null 2>&1 \
    && curl --fail --silent --max-time 3 "http://127.0.0.1:${port}/" | grep -Eiq 'selkies|<html|<!doctype'; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  docker logs --tail 120 "$container"
  echo 'CPU-only HTTP liveness failed; GPU streaming has not been tested.' >&2
  exit 1
fi
docker rm -f "$container" >/dev/null
if docker inspect "$container" >/dev/null 2>&1; then
  echo 'Container cleanup unverified' >&2
  exit 1
fi
docker network rm "$network" >/dev/null
if docker network inspect "$network" >/dev/null 2>&1; then
  echo 'Network cleanup unverified' >&2
  exit 1
fi
echo "${slug}: tools, CPU HTTP liveness, CI cleanup passed. GPU/video/input NOT TESTED."
