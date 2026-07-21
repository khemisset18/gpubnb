#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
BOOKING_ID=${1:?booking id required}; [[ "$BOOKING_ID" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || exit 2
BASE=${JOB_ROOT:-/var/lib/gpubnb/jobs}; TARGET="$BASE/$BOOKING_ID"
[[ -d "$TARGET" && "$(realpath "$TARGET")" == "$(realpath "$BASE")/"* ]] || exit 2
docker rm -f "gpubnb-${BOOKING_ID:0:48}" >/dev/null 2>&1 || true
find "$TARGET" -xdev -type f -exec shred -u -n 1 -- {} + 2>/dev/null || true
rm -rf --one-file-system -- "$TARGET"
