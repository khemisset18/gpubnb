#!/usr/bin/env bash
# Real-checks-only preflight for a future Linux GPU desktop host (Creator /
# Cloud Desktop / CAD / Gaming Workspaces - all four share this exact same
# requirement set, see docs/SESSION_RESUME.md section 8/9). Run this BEFORE
# connecting a machine to GPUbnb as a host, so an operator can see exactly
# what is missing rather than discovering it after linking. Mirrors the
# same real checks agent/gpubnb_agent/platform_info.py's
# desktop_gpu_rendering_available() performs once the agent is running -
# this script exists so a host operator can self-diagnose without the agent
# installed yet. Read-only: never installs, modifies, or configures
# anything on the host (the one exception is a throwaway --rm test
# container, removed automatically, used to prove passthrough - no image is
# ever kept, no host file is ever written).
set -uo pipefail
failed=0
check(){ local label="$1"; shift; if "$@" >/dev/null 2>&1; then echo "OK:   $label"; else echo "FAIL: $label"; failed=1; fi; }
warn_only(){ local label="$1"; shift; if "$@" >/dev/null 2>&1; then echo "OK:   $label"; else echo "WARN: $label (not required, but recommended)"; fi; }

echo "== GPUbnb Linux GPU Desktop preflight =="
echo "This checks two DIFFERENT, independently-measured capabilities - a"
echo "machine can have one without the other (confirmed live on this"
echo "platform's own dev host: real CUDA compute works there via --gpus,"
echo "but it has no /dev/dri at all):"
echo "  1) CUDA compute capability (needed by AI/Video/Developer/Mobile)"
echo "  2) GPU desktop rendering capability (needed by Creator/Cloud"
echo "     Desktop/CAD/Gaming - OpenGL/Vulkan via a real /dev/dri node)"
echo

echo "--- Platform ---"
is_linux(){ [ "$(uname -s)" = "Linux" ]; }
check "Real Linux kernel (uname -s)" is_linux

not_wsl(){ ! grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; }
check "Not WSL2 (a real native Linux host is required, not a Windows-hosted VM)" not_wsl

docker_installed(){ command -v docker >/dev/null 2>&1; }
check "Docker installed" docker_installed

docker_daemon_reachable(){ docker version >/dev/null 2>&1; }
check "Docker daemon reachable" docker_daemon_reachable

echo
echo "--- 1) CUDA compute capability ---"
nvidia_driver_present(){ command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; }
check "NVIDIA driver present (nvidia-smi)" nvidia_driver_present

nvidia_container_toolkit_registered(){ docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -qi nvidia; }
check "NVIDIA Container Toolkit registered with Docker" nvidia_container_toolkit_registered

vram_report(){
  local mib
  mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d '[:space:]')"
  [ -n "$mib" ] && [ "$mib" -gt 0 ] 2>/dev/null
}
if vram_report; then
  echo "OK:   Real VRAM detected: $(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1) MiB (GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1))"
else
  echo "FAIL: Real VRAM detected"
  failed=1
fi

echo
echo "--- 2) GPU desktop rendering capability (the one this host lacks) ---"
dri_render_node_present(){ ls /dev/dri/render* >/dev/null 2>&1; }
check "Real /dev/dri render node present on the HOST" dri_render_node_present

# The actual proof this platform cares about: a container with
# NVIDIA_DRIVER_CAPABILITIES=graphics can see /dev/dri too, not just the
# host. This is the closest this script gets to the real one-shot
# GPU_PROOF-style container test the agent performs at booking time.
container_sees_dri(){
  docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute \
    ubuntu:24.04 sh -c 'ls /dev/dri/render* >/dev/null 2>&1'
}
check "A test container can see /dev/dri via --gpus + NVIDIA_DRIVER_CAPABILITIES=graphics" container_sees_dri

# A real OpenGL rendering proof, not just device-node presence: mesa-utils'
# glxinfo actually initializes a GL context. The critical distinction is
# the *renderer string* - "llvmpipe"/"softpipe" means CPU software
# rendering silently succeeded without ever touching the GPU, which would
# be a false positive if only checked for a zero exit code.
opengl_is_hardware_accelerated(){
  local renderer
  renderer="$(docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute \
    ubuntu:24.04 sh -c 'apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mesa-utils >/dev/null 2>&1 && glxinfo -B 2>/dev/null | grep -i "OpenGL renderer"' 2>/dev/null)"
  echo "$renderer" | grep -qi nvidia && ! echo "$renderer" | grep -qiE "llvmpipe|softpipe|swrast"
}
if opengl_is_hardware_accelerated; then
  echo "OK:   Real GPU-accelerated OpenGL confirmed (NVIDIA renderer, not llvmpipe/software)"
else
  echo "FAIL: Real GPU-accelerated OpenGL confirmed (either no GL context at all, or a software/llvmpipe fallback - not real GPU rendering)"
  failed=1
fi

# NVENC hardware video encoding - what Selkies uses for the actual desktop
# stream when a real DRI node is available (its own `dri_node`/VA-API
# setting - confirmed live in Selkies' own startup config this session).
# Mirrors Video Workspace's own real-encode healthcheck rigor (a
# detection-only check would have missed the real NVENC "video" driver
# capability bug this session already found and fixed for Video Workspace).
nvenc_hardware_encode_works(){
  docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video \
    ubuntu:24.04 sh -c '
      apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null 2>&1 &&
      ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=10 -c:v h264_nvenc -preset p1 -f null - >/tmp/preflight-nvenc.log 2>&1
    '
}
warn_only "Real NVENC hardware video encode works (Video Workspace-tier quality for streaming)" nvenc_hardware_encode_works

echo
echo "--- Resources ---"
ram_ok(){ [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)" -ge 8192 ]; }
warn_only "At least 8GB RAM (Cloud Desktop's minimum; Creator/CAD/Gaming want 16GB)" ram_ok

disk_ok(){ [ "$(df -Pm . 2>/dev/null | awk 'NR==2{print $4}')" -ge 40960 ]; }
warn_only "At least 40GB free disk (Cloud Desktop's minimum; Creator/CAD/Gaming want 60GB+)" disk_ok

echo
if (( failed )); then
  echo "PREFLIGHT: NOT READY - see FAIL lines above. This host cannot run any of"
  echo "Creator/Cloud Desktop/CAD/Gaming yet (they share this exact same"
  echo "requirement set - see docs/SESSION_RESUME.md section 8/9)."
  exit 1
fi
echo "PREFLIGHT: all real checks passed for the SHARED requirement (GPU desktop"
echo "rendering). This does NOT yet prove: (1) the actual Selkies-based image"
echo "runs correctly with real --gpus flags end to end (only tested without a"
echo "GPU so far - see workspaces/cloud-desktop/), (2) the exact minimal"
echo "container-capability set this image needs, since --cap-drop=ALL and"
echo "--read-only are both confirmed NOT to work with it as shipped (see"
echo "workspaces/cloud-desktop/NOT_YET_WORKING.md), and (3) for Gaming"
echo "specifically, real gamepad/audio round-trips through a real browser"
echo "session. Follow docs/SESSION_RESUME.md section 8/9's validation plan next."
