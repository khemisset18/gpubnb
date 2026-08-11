#!/usr/bin/env sh
set -eu
for tool in code-server git python3 node npm java go rustc cargo gcc g++; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing_required_tool:$tool" >&2
    exit 1
  }
done
code-server --version
node --check /usr/local/lib/gpubnb/loopback-proxy.js
test "$(id -u)" -ne 0
test -w /workspace
# A production run mounts /workspace as a fresh tmpfs (required to make it writable
# under --read-only; see runner.py), which starts empty, so these subdirectories
# from the image layer are gone. Recreate them idempotently: a no-op against the
# unsandboxed image used by CI, self-healing against the real hardened profile.
mkdir -p /workspace/imports /workspace/output
test -d /workspace/imports
test -d /workspace/output
