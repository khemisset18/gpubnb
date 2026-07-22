#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
BOOKING_ID=${1:?booking id required}; [[ "$BOOKING_ID" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || exit 2
BASE=${JOB_ROOT:-/var/lib/gpubnb/jobs}; TARGET="$BASE/$BOOKING_ID"
[[ ! -L "$BASE" && ! -L "$TARGET" ]] || { echo 'cleanup paths must not be symbolic links' >&2; exit 2; }
[[ -d "$TARGET" && "$(realpath "$TARGET")" == "$(realpath "$BASE")/"* ]] || { echo 'cleanup target escapes JOB_ROOT' >&2; exit 2; }
NAME="gpubnb-${BOOKING_ID:0:35}-$(printf %s "$BOOKING_ID" | sha256sum | cut -c1-12)"
failed=0
if docker container inspect "$NAME" >/dev/null 2>&1; then
  docker rm -f "$NAME" >/dev/null || { echo "failed to remove container $NAME" >&2; failed=1; }
fi
# Overwrite is defense-in-depth only; filesystems and SSDs may not guarantee physical erasure.
if ! find "$TARGET" -xdev -type f -exec shred -u -n 1 -- {} +; then
  echo 'one or more workload files could not be overwritten' >&2
  failed=1
fi
if ! rm -rf --one-file-system -- "$TARGET"; then
  echo 'workload directory removal failed' >&2
  failed=1
fi
(( failed == 0 )) || exit 1
