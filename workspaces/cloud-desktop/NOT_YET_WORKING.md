# Cloud Desktop Workspace - architecture prepared, NOT working, NOT bookable

**This workspace is not REAL_WORKING.** It is not in `executableWorkspaceSlugs`,
it cannot be booked, and nothing in this directory has been proven to
actually render a GPU-accelerated desktop. Do not change that without a
real Linux GPU host and the validation steps below actually passing.

## Why it can't be tested here

This dev host is Windows/Docker Desktop/WSL2, which has no `/dev/dri`
render node - confirmed live, repeatedly, throughout this project. Docker
containers on this host can get real NVIDIA CUDA compute passthrough
(`--gpus`, used by AI/Video/Developer/Mobile) but not real desktop
GPU rendering (OpenGL/Vulkan/EGL). `scripts/preflight-linux-gpu-desktop.sh`
documents and tests this distinction directly - run it yourself to see the
exact same live FAIL this session recorded.

## What's real in this directory

- `Dockerfile`: builds `FROM linuxserver/webtop` (a real, actively
  maintained, Selkies-GStreamer-based image, digest-pinned) with the
  `--gpus`/`NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute`
  flags this workspace would need at runtime. **What was actually tested
  live on this host** (see docs/SESSION_RESUME.md section 8 for the full
  results):
  - Real container start, real HTTP 200 response with the real Selkies
    HTML client on port 3000 (confirmed: port 3000 is documented as the
    plain-HTTP reverse-proxy port, exactly matching this platform's
    `WORKSPACE_ENTRY_PORT=3000` convention - no remapping needed).
  - **The real `loopback-proxy.js` relay** (the exact same script every
    REAL_WORKING workspace's Gateway uses) correctly relays a full
    request through to this image, on the exact same two-network pattern
    production uses (proxy on the gateway network + published port,
    separately joined to the session's internal network) - confirmed live,
    real HTTP 200, real relayed HTML content.
  - Real gamepad support confirmed live in the container logs (Selkies
    initializes 4 persistent gamepad instances at startup) - relevant to
    the Gaming Workspace plan too, not just Creator/Cloud Desktop/CAD.
  - Real stop/cleanup: containers and networks all confirmed gone
    afterward.
  - **What was NOT and cannot be tested here**: whether the desktop it
    serves is genuinely GPU-rendered - confirmed live that `/dev/dri` is
    absent both on the host and inside this exact image's container (no
    `/dev/dri` to pass through, so nothing to prove GPU rendering against).
- `healthcheck.sh`: deliberately scoped to only the HTTP-liveness check
  that's honestly provable without a GPU - it does **not** claim to
  verify GPU rendering.

## What real validation would require (see docs/SESSION_RESUME.md section 8)

1. A real Linux host - run `scripts/preflight-linux-gpu-desktop.sh` on it
   first.
2. Confirm a test container's `glxinfo`/`vulkaninfo` shows a real NVIDIA
   vendor string, not `llvmpipe`/Mesa software rendering.
3. Run this Dockerfile's image with `--gpus` on that host and confirm the
   browser client shows real GPU-rendered content.
4. Only then would this be honestly reclassified as REAL_WORKING, added to
   `executableWorkspaceSlugs`, and given real booking/status/access routes
   (mirroring the exact pattern the 9 already-REAL_WORKING workspaces use).

## Creator / CAD

Same base image, same unresolved GPU-rendering question. The plan (not yet
built - no point building an untestable second/third variant of the same
open question) is: Creator = this image + real Blender (`apt-get install
blender`, GPL, same low-risk pattern as Mobile's Android SDK/Security
Lab's tshark-YARA-radare2 layered onto Developer); CAD = this image + real
FreeCAD (`apt-get install freecad`, GPL). Neither has its own Dockerfile
yet since it would face the exact same untestable-here blocker as this one.
