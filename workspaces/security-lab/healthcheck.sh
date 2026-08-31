#!/usr/bin/env sh
set -eu
# Shallow, fast, repeated-every-30s liveness check (Docker HEALTHCHECK) - not
# the deep one-shot proof that each tool actually works on real data, which
# is runner.py's SECURITY_LAB_WORKSPACE_HEALTHCHECK_SCRIPT
# (workspace_health_command's "security-lab" branch), run once via docker
# exec before a renter is billed for this workspace.
for tool in code-server tshark yara r2; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing_required_tool:$tool" >&2
    exit 1
  }
done
code-server --version
tshark --version >/dev/null
test "$(id -u)" -ne 0
test -w /workspace
