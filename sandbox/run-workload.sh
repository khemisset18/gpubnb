#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
IMAGE=${1:?usage: run-workload.sh IMAGE@sha256:DIGEST [COMMAND...]}; shift
[[ "$IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Image must be pinned by a lowercase sha256 digest' >&2; exit 2; }
[[ ${EUID:-$(id -u)} -ne 0 ]] || { echo 'Do not invoke the launcher as root; use a dedicated service account' >&2; exit 2; }
BOOKING_ID=${BOOKING_ID:?BOOKING_ID required}; [[ "$BOOKING_ID" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || { echo 'invalid BOOKING_ID' >&2; exit 2; }
GPU_DEVICE=${GPU_DEVICE:-0}; [[ "$GPU_DEVICE" =~ ^[0-9]+$ ]] || { echo 'invalid GPU_DEVICE' >&2; exit 2; }
MAX_RUNTIME=${MAX_RUNTIME:-25h}; [[ "$MAX_RUNTIME" =~ ^[1-9][0-9]*[smhd]$ ]] || { echo 'invalid MAX_RUNTIME' >&2; exit 2; }
PIDS_LIMIT=${PIDS_LIMIT:-256}; [[ "$PIDS_LIMIT" =~ ^[1-9][0-9]{0,4}$ ]] || { echo 'invalid PIDS_LIMIT' >&2; exit 2; }
MEMORY_LIMIT=${MEMORY_LIMIT:-16g}; [[ "$MEMORY_LIMIT" =~ ^[1-9][0-9]*[kKmMgG]$ ]] || { echo 'invalid MEMORY_LIMIT' >&2; exit 2; }
CPU_LIMIT=${CPU_LIMIT:-8}; [[ "$CPU_LIMIT" =~ ^[1-9][0-9]*(\.[0-9]{1,3})?$ ]] || { echo 'invalid CPU_LIMIT' >&2; exit 2; }
NAME="gpubnb-${BOOKING_ID:0:35}-$(printf %s "$BOOKING_ID" | sha256sum | cut -c1-12)"
BASE=${JOB_ROOT:-/var/lib/gpubnb/jobs}; WORKDIR="$BASE/$BOOKING_ID"
mkdir -p -- "$BASE"
[[ ! -L "$BASE" && ! -L "$WORKDIR" ]] || { echo 'job paths must not be symbolic links' >&2; exit 2; }
mkdir -p -- "$WORKDIR/input" "$WORKDIR/output"
BASE_REAL=$(realpath "$BASE"); WORKDIR_REAL=$(realpath "$WORKDIR")
[[ "$WORKDIR_REAL" == "$BASE_REAL/"* ]] || { echo 'work directory escapes JOB_ROOT' >&2; exit 2; }
[[ -z $(find "$WORKDIR" -xdev -type l -print -quit) ]] || { echo 'job directory contains a symbolic link' >&2; exit 2; }
[[ $(stat -c %u "$WORKDIR") -eq $(id -u) ]] || { echo 'job directory is not owned by the launcher account' >&2; exit 2; }
chmod 700 -- "$WORKDIR" "$WORKDIR/input" "$WORKDIR/output"
SECURITY_ARGS=(--read-only --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit="$PIDS_LIMIT" --memory="$MEMORY_LIMIT" --memory-swap="$MEMORY_LIMIT" --cpus="$CPU_LIMIT" --network=none --user="$(id -u):$(id -g)" --ipc=private --uts=private --stop-timeout=10 --ulimit nofile=1024:1024 --ulimit "nproc=$PIDS_LIMIT:$PIDS_LIMIT" --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g,mode=1777)
[[ -f /etc/gpubnb/seccomp.json ]] && SECURITY_ARGS+=(--security-opt seccomp=/etc/gpubnb/seccomp.json)
[[ -n ${GPUBNB_APPARMOR_PROFILE:-} ]] && SECURITY_ARGS+=(--security-opt "apparmor=$GPUBNB_APPARMOR_PROFILE")
timeout --signal=TERM --kill-after=20s "$MAX_RUNTIME" docker run --rm --pull=never --name "$NAME" --gpus "device=$GPU_DEVICE" "${SECURITY_ARGS[@]}" \
 --mount "type=bind,src=$WORKDIR/input,dst=/input,readonly" --mount "type=bind,src=$WORKDIR/output,dst=/output" \
 --label "gpubnb.booking=$BOOKING_ID" --label 'gpubnb.managed=true' "$IMAGE" "$@"
