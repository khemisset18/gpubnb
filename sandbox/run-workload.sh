#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
IMAGE=${1:?usage: run-workload.sh IMAGE@sha256:DIGEST [COMMAND...]}; shift
[[ "$IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Image must be pinned by a lowercase sha256 digest' >&2; exit 2; }
[[ ${EUID:-$(id -u)} -ne 0 ]] || { echo 'Do not invoke the launcher as root; use a dedicated service account' >&2; exit 2; }
BOOKING_ID=${BOOKING_ID:?BOOKING_ID required}; [[ "$BOOKING_ID" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || { echo 'invalid BOOKING_ID' >&2; exit 2; }
GPU_DEVICE=${GPU_DEVICE:-0}; [[ "$GPU_DEVICE" =~ ^[0-9]+$ ]] || { echo 'invalid GPU_DEVICE' >&2; exit 2; }
NAME="gpubnb-${BOOKING_ID:0:48}"
BASE=${JOB_ROOT:-/var/lib/gpubnb/jobs}; WORKDIR="$BASE/$BOOKING_ID"
mkdir -p -- "$WORKDIR/input" "$WORKDIR/output"; chmod 700 -- "$WORKDIR" "$WORKDIR/input" "$WORKDIR/output"
SECURITY_ARGS=(--read-only --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit="${PIDS_LIMIT:-256}" --memory="${MEMORY_LIMIT:-16g}" --memory-swap="${MEMORY_LIMIT:-16g}" --cpus="${CPU_LIMIT:-8}" --network=none --user=65532:65532 --ipc=private --uts=private --stop-timeout=10 --ulimit nofile=1024:1024 --ulimit nproc=256:256 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g,mode=1777)
[[ -f /etc/gpubnb/seccomp.json ]] && SECURITY_ARGS+=(--security-opt seccomp=/etc/gpubnb/seccomp.json)
[[ -n ${GPUBNB_APPARMOR_PROFILE:-} ]] && SECURITY_ARGS+=(--security-opt "apparmor=$GPUBNB_APPARMOR_PROFILE")
timeout --signal=TERM --kill-after=20s "${MAX_RUNTIME:-25h}" docker run --rm --pull=never --name "$NAME" --gpus "device=$GPU_DEVICE" "${SECURITY_ARGS[@]}" \
 --mount "type=bind,src=$WORKDIR/input,dst=/input,readonly" --mount "type=bind,src=$WORKDIR/output,dst=/output" \
 --label "gpubnb.booking=$BOOKING_ID" --label 'gpubnb.managed=true' "$IMAGE" "$@"
