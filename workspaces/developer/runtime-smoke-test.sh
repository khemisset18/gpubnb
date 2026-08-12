#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: runtime-smoke-test.sh <image>" >&2
  exit 2
fi
image="$1"
suffix="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
workspace="gpubnb-developer-smoke-$suffix"
proxy="gpubnb-developer-proxy-smoke-$suffix"
internal="gpubnb-developer-internal-smoke-$suffix"
gateway="gpubnb-developer-gateway-smoke-$suffix"
volume="gpubnb-developer-smoke-$suffix"
browser_dom="$(mktemp)"
browser_log="$(mktemp)"
browser_profile="$(mktemp -d)"
browser_pid=""

cleanup() {
  status=$?
  if [[ -n "$browser_pid" ]]; then
    kill "$browser_pid" >/dev/null 2>&1 || true
    wait "$browser_pid" >/dev/null 2>&1 || true
  fi
  if (( status != 0 )); then
    for container in "$workspace" "$proxy"; do
      echo "diagnostics for $container" >&2
      docker inspect --format 'state={{json .State}} ports={{json .NetworkSettings.Ports}} networks={{json .NetworkSettings.Networks}}' "$container" 2>/dev/null || true
      docker logs --tail 200 "$container" 2>/dev/null || true
    done
    echo "headless browser diagnostics" >&2
    cat "$browser_log" >&2 2>/dev/null || true
    echo "headless browser DOM tail" >&2
    tail -c 20000 "$browser_dom" >&2 2>/dev/null || true
  fi
  docker rm -f "$proxy" "$workspace" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
  docker network rm "$internal" "$gateway" >/dev/null 2>&1 || true
  rm -f "$browser_dom" "$browser_log"
  rm -rf "$browser_profile"
  exit "$status"
}
trap cleanup EXIT

docker network create --internal "$internal" >/dev/null
docker network create "$gateway" >/dev/null
docker volume create "$volume" >/dev/null

# The renter-controlled workspace has no published port and no non-internal
# network. CI has no GPU, so GPU passthrough is the only production flag omitted.
docker run -d --name "$workspace" \
  --network "$internal" \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=512 --memory=4g --cpus=2 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --tmpfs /home/coder:rw,nosuid,size=512m,uid=1000,gid=1000,mode=0700 \
  --mount "type=volume,source=$volume,target=/workspace" \
  --entrypoint code-server "$image" \
  --bind-addr 0.0.0.0:3000 --auth none /workspace >/dev/null

# Only this minimal proxy joins the ordinary bridge. It has no GPU and no renter
# volume, and Docker publishes it on host loopback only.
docker run -d --name "$proxy" \
  --network "$gateway" \
  --publish 127.0.0.1::3000 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=64 --memory=128m --cpus=0.25 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --user=1000:1000 --no-healthcheck \
  --env "GPUBNB_TARGET=$workspace" \
  --entrypoint node "$image" \
  /usr/local/lib/gpubnb/loopback-proxy.js >/dev/null
docker network connect "$internal" "$proxy"

port=""
for _ in $(seq 1 60); do
  for container in "$workspace" "$proxy"; do
    running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)
    if [[ "$running" != "true" ]]; then
      echo "$container exited before the workspace became healthy" >&2
      exit 1
    fi
  done
  published=$(docker port "$proxy" 3000/tcp 2>/dev/null || true)
  port=$(printf '%s\n' "$published" | sed -nE 's/.*127\.0\.0\.1:([0-9]+).*/\1/p' | head -n1 || true)
  if [[ -n "$port" ]] && curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null; then
    break
  fi
  sleep 0.5
done

if [[ -z "$port" ]]; then
  echo "loopback proxy port was not published within 30 seconds" >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null

# A healthy /healthz endpoint is not enough: a real rental needs the browser
# workbench and the remote ExtensionHost. Chrome is controlled through CDP so a
# white page produces actionable JS/network/WebSocket diagnostics in CI.
browser="${CHROME_BIN:-}"
if [[ -z "$browser" ]]; then
  for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      browser="$(command -v "$candidate")"
      break
    fi
  done
fi
if [[ -z "$browser" ]]; then
  echo "headless Chromium/Chrome is required for Developer workbench smoke testing" >&2
  exit 1
fi

debug_port=9222
"$browser" \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-component-update \
  --disable-default-apps \
  --disable-extensions \
  --no-first-run \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$debug_port" \
  --user-data-dir="$browser_profile" \
  about:blank >/dev/null 2>"$browser_log" &
browser_pid=$!

for _ in $(seq 1 50); do
  if curl --fail --silent --max-time 1 "http://127.0.0.1:$debug_port/json/version" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$browser_pid" >/dev/null 2>&1; then
    echo "headless browser exited before CDP became available" >&2
    exit 1
  fi
  sleep 0.1
done
curl --fail --silent --max-time 1 "http://127.0.0.1:$debug_port/json/version" >/dev/null

node_cmd=(node)
if [[ "$(node -p 'typeof WebSocket')" != "function" ]]; then
  node_cmd=(node --experimental-websocket)
fi
set +e
"${node_cmd[@]}" workspaces/developer/browser-smoke-test.mjs \
  "http://127.0.0.1:$debug_port" \
  "http://127.0.0.1:$port/?folder=/workspace" \
  "$browser_dom" >>"$browser_log" 2>&1
browser_status=$?
set -e
if (( browser_status != 0 )); then
  echo "Developer workbench browser smoke failed (exit $browser_status)" >&2
  exit 1
fi

extension_host_ready=false
for _ in $(seq 1 40); do
  runtime_logs="$(docker logs "$workspace" 2>&1 || true)"
  if grep -Eq '\[ExtensionHostConnection\].*New connection established|Launched Extension Host Process' <<<"$runtime_logs"; then
    extension_host_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$extension_host_ready" != "true" ]]; then
  echo "Developer workbench opened but Remote ExtensionHost never established" >&2
  exit 1
fi
if grep -Eq 'Extension Host Process exited with code: [1-9]|Converting circular structure to JSON' <<<"$runtime_logs"; then
  echo "Remote ExtensionHost crashed during browser smoke test" >&2
  exit 1
fi

test "$(docker network inspect --format '{{.Internal}}' "$internal")" = "true"
test "$(docker network inspect --format '{{.Internal}}' "$gateway")" = "false"
workspace_networks=$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$workspace")
proxy_networks=$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$proxy")
export WORKSPACE_NETWORKS="$workspace_networks" PROXY_NETWORKS="$proxy_networks"
export EXPECTED_INTERNAL="$internal" EXPECTED_GATEWAY="$gateway"
python3 - <<'PY'
import json
import os

workspace = set(json.loads(os.environ["WORKSPACE_NETWORKS"]))
proxy = set(json.loads(os.environ["PROXY_NETWORKS"]))
internal = os.environ["EXPECTED_INTERNAL"]
gateway = os.environ["EXPECTED_GATEWAY"]
if workspace != {internal}:
    raise SystemExit(f"workspace network isolation violated: {sorted(workspace)}")
if proxy != {internal, gateway}:
    raise SystemExit(f"proxy network topology violated: {sorted(proxy)}")
PY
if printf '%s\n' "$published" | grep -Eq '0\.0\.0\.0|\[::\]|:::'; then
  echo "proxy was published beyond loopback: $published" >&2
  exit 1
fi

echo "code-server workbench and ExtensionHost are healthy through an isolated loopback-only proxy"
