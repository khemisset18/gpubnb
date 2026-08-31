#!/usr/bin/env sh
set -eu
# Shallow, fast, repeated-every-30s liveness check (Docker HEALTHCHECK) - not
# the deep one-shot proof that a real Gradle build actually completes
# offline, which is runner.py's MOBILE_WORKSPACE_HEALTHCHECK_SCRIPT
# (workspace_health_command's "mobile" branch), run once via docker exec
# before a renter is billed for this workspace.
for tool in code-server sdkmanager adb gradle java; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing_required_tool:$tool" >&2
    exit 1
  }
done
code-server --version
adb --version >/dev/null
test "$(id -u)" -ne 0
test -w /workspace
test -d "$HOME/.gradle"
