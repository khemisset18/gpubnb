#!/usr/bin/env sh
set -eu
# Deliberately scoped to only what is honestly provable without a real
# /dev/dri render node - see NOT_YET_WORKING.md and
# workspaces/cloud-desktop/NOT_YET_WORKING.md. Does NOT check GPU
# rendering - there is no way to check that here.
command -v blender >/dev/null 2>&1 || {
  echo "missing_required_tool:blender" >&2
  exit 1
}
curl -fsS -o /dev/null http://127.0.0.1:3000/ || wget -q -O /dev/null http://127.0.0.1:3000/
