#!/bin/sh
set -eu
# /workspace must be a session-scoped, isolated, writable volume.
test -w /workspace || { echo "renter_workspace_volume_required" >&2; exit 1; }
mkdir -p /workspace/imports /workspace/output /workspace/temp
# Models must be provisioned at image build or through a signed, immutable
# verified volume before a functional E2E may promote this workspace.
exec python /opt/ComfyUI/main.py --listen 0.0.0.0 --port 3000 \
  --input-directory /workspace/imports \
  --output-directory /workspace/output \
  --temp-directory /workspace/temp
