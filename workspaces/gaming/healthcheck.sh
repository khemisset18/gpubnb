#!/usr/bin/env sh
set -eu
# Deliberately scoped to only what is honestly provable without a real
# /dev/dri render node - see NOT_YET_WORKING.md and
# workspaces/cloud-desktop/NOT_YET_WORKING.md. Does NOT check GPU
# rendering, real game streaming, or gamepad/audio round-trips - there is
# no way to check any of that here.
test -x /usr/games/steam || {
  echo "missing_required_tool:steam" >&2
  exit 1
}
curl -fsS -o /dev/null http://127.0.0.1:3000/ || wget -q -O /dev/null http://127.0.0.1:3000/
