#!/usr/bin/env bash
# Real-checks-only preflight for a future Linux GPU desktop host (Creator /
# Cloud Desktop / CAD Workspaces - see docs/SESSION_RESUME.md section 8).
# Run this BEFORE connecting a machine to GPUbnb as a host, so an operator
# can see exactly what is missing rather than discovering it after linking.
# Mirrors the same real checks agent/gpubnb_agent/platform_info.py's
# desktop_gpu_rendering_available() performs once the agent is running -
# this script exists so a host operator can self-diagnose without the agent
# installed yet. Read-only: never installs, modifies, or configures
# anything on the host.
set -uo pipefail
failed=0
check(){ local label="$1"; shift; if "$@" >/dev/null 2>&1; then echo "OK:   $label"; else echo "FAIL: $label"; failed=1; fi; }
warn_only(){ local label="$1"; shift; if "$@" >/dev/null 2>&1; then echo "OK:   $label"; else echo "WARN: $label (not required, but recommended)"; fi; }

echo "== GPUbnb Linux GPU Desktop preflight =="
echo

is_linux(){ [ "$(uname -s)" = "Linux" ]; }
check "Real Linux kernel (uname -s)" is_linux

not_wsl(){ ! grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; }
check "Not WSL2 (a real native Linux host is required, not a Windows-hosted VM)" not_wsl

docker_installed(){ command -v docker >/dev/null 2>&1; }
check "Docker installed" docker_installed

docker_daemon_reachable(){ docker version >/dev/null 2>&1; }
check "Docker daemon reachable" docker_daemon_reachable

nvidia_driver_present(){ command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; }
check "NVIDIA driver present (nvidia-smi)" nvidia_driver_present

nvidia_container_toolkit_registered(){ docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -qi nvidia; }
check "NVIDIA Container Toolkit registered with Docker" nvidia_container_toolkit_registered

dri_render_node_present(){ ls /dev/dri/render* >/dev/null 2>&1; }
check "Real /dev/dri render node present" dri_render_node_present

# The actual proof this platform cares about: a container with
# NVIDIA_DRIVER_CAPABILITIES=graphics can see /dev/dri too, not just the
# host. This is the closest this script gets to the real one-shot
# GPU_PROOF-style container test the agent performs at booking time - it
# does NOT prove OpenGL/Vulkan rendering itself works, only that the device
# node is passed through correctly.
container_sees_dri(){
  docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute \
    ubuntu:24.04 sh -c 'ls /dev/dri/render* >/dev/null 2>&1'
}
check "A test container can see /dev/dri via --gpus + NVIDIA_DRIVER_CAPABILITIES=graphics" container_sees_dri

ram_ok(){ [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)" -ge 8192 ]; }
warn_only "At least 8GB RAM (Cloud Desktop's minimum; Creator/CAD want 16GB)" ram_ok

disk_ok(){ [ "$(df -Pm . 2>/dev/null | awk 'NR==2{print $4}')" -ge 40960 ]; }
warn_only "At least 40GB free disk (Cloud Desktop's minimum; Creator/CAD want 60GB+)" disk_ok

echo
if (( failed )); then
  echo "PREFLIGHT: NOT READY - see FAIL lines above. This host cannot run a real GPU-accelerated Linux desktop workspace yet."
  exit 1
fi
echo "PREFLIGHT: all real checks passed. This does not yet prove OpenGL/Vulkan rendering works end to end inside a Selkies-based image - that still needs a real build+run test (see docs/SESSION_RESUME.md section 8's validation plan)."
