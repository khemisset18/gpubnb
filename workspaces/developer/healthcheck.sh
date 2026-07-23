#!/usr/bin/env sh
set -eu
for tool in code-server git python3 node npm java go rustc cargo gcc g++; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing_required_tool:$tool" >&2
    exit 1
  }
done
test "$(id -u)" -ne 0
test -w /workspace
test -d /workspace/imports
test -d /workspace/output
