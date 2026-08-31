# GPUbnb Workspace Runtime Architecture — as actually built

This document describes the architecture **as it is really implemented and
tested today**, not the original aspirational design. Where the original
plan (VM-per-family, WebRTC-first streaming, etc.) turned out differently
once real infrastructure was actually built and tested, this document says
so explicitly. For which of the 13 workspaces are real vs. blocked and why,
see `docs/WORKSPACES_OVERVIEW.md`. For the step-by-step procedure to unblock
the 4 desktop-GPU workspaces on a real Linux host, see
`docs/SESSION_RESUME.md` section 9.

## One runtime family, not several

The original plan split workspaces into "Container", "Desktop VM",
"Isolated VM" and "Streaming VM" families. As built, **every one of the 13
workspaces runs the same way: a Docker container, launched and supervised
by `GatewaySupervisor`** (`agent/gpubnb_agent/workspace_gateway.py`). There
is no VM/hypervisor infrastructure anywhere in this codebase. Mobile and
Security Lab do not use a stronger "isolated VM" boundary — they are
regular hardened containers, just built from custom local Dockerfiles
instead of an official upstream image. Creator/Cloud Desktop/CAD/Gaming are
not a separate "Desktop VM" family either — they share one common
Selkies-GStreamer-based container image and one shared launch profile (see
below), the same "runtime commun" pattern the rest of the fleet already
uses.

## How a workspace is launched

1. A renter books a machine and requests a specific workspace slug
   (`POST /bookings/:id/workspace/:slug`). The API creates a
   `WorkspaceSession` and a `Job` of type `WORKSPACE_PREPARE`.
2. The agent's job runner picks up the job, resolves the pinned image for
   that slug (`runtime_images.workspace_image()` — every image is
   content-addressed by digest, official upstream where one exists,
   custom-built-and-locally-pinned for Mobile/Security Lab/the desktop
   family), and runs a one-shot, real functional healthcheck container
   (`workspace_health_command()` in `agent/gpubnb_agent/runner.py`) before
   ever starting the persistent session — this is what proves e.g. real
   CUDA availability, real ffmpeg NVENC, or a real Gradle offline build
   works, not just that the container starts.
3. Once the health job reports success, `GatewaySupervisor._start_runtime()`
   launches the real persistent workspace container plus a dedicated proxy
   container (see **The loopback proxy** below), on a fresh per-session
   internal Docker network, with a fresh per-session volume mounted at the
   image's own writable path (`/workspace`, `/home/jovyan/work`, or
   `/config` for the Selkies-based family).
4. `_launch_workspace_container()` (same file) branches per slug family —
   Jupyter/Data-stack images share one branch, Mobile/Security Lab each
   have their own entrypoint-preserving branch, and Creator/Cloud
   Desktop/CAD/Gaming share one branch using the confirmed-working
   hardening profile for that base image (see **Hardening, by family**).
5. When a signed rental-resource authority is available
   (`workspace_gateway_v5.py`), the exact leased GPU hardware UUID is
   substituted for every GPU-attached slug
   (`GPU_ATTACHED_WORKSPACE_SLUGS`) instead of a fixed device index — this
   is what makes billing/exclusivity correct on a multi-GPU host.
6. The API's `POST /agent/workspace-gateway/:sessionId/register` call
   populates `connectionMetadata` once the proxy is confirmed healthy —
   only then does `GET /bookings/:id/workspace` report `canOpen: true`.
   `READY` alone never means "openable" — see **Interactive readiness and
   billing** below, unchanged from the original design and still enforced.

## The loopback proxy

Every workspace surface — regardless of which image or slug — is exposed
through the exact same relay: `workspaces/developer/loopback-proxy.js`, a
small, dumb, raw-TCP byte relay to `WORKSPACE_ENTRY_PORT` (3000) inside the
target container. It is reused unmodified for all 13 workspaces; adding a
new workspace surface has never required a new relay component. The proxy
container is created on the shared gateway network first (so `-p` port
publishing works), then separately `docker network connect`ed to the
session's own internal network — the renter's browser only ever reaches the
proxy's published loopback port, never the workspace container directly.

This is also why the Selkies-GStreamer-based desktop family (Creator/Cloud
Desktop/CAD/Gaming) needed no new streaming infrastructure once actually
tested: Selkies' default transport is plain WebSocket (not WebRTC — an
earlier, more cautious assumption in this project's own research), which
this exact relay already carries correctly, confirmed live.

## Hardening, by family

Every workspace container runs non-root where the base image allows it,
never mounts the Docker socket, and is scoped to `/workspace`-equivalent as
its only writable data path. Two real, different hardening profiles exist,
both documented rather than glossed over:

- **Standard profile** (Compute, Developer, Data, AI, Video, Audio, API,
  Mobile, Security Lab): `--read-only --cap-drop=ALL
  --security-opt=no-new-privileges`, a small `noexec` tmpfs for `/tmp`, a
  real writable volume for the project directory only.
- **Reduced profile** (Creator, Cloud Desktop, CAD, Gaming — real,
  live-confirmed, not a shortcut taken for convenience): the
  `linuxserver/webtop` base image genuinely does not tolerate `--read-only`
  (it self-configures nginx/SSL/web assets into several paths at container
  *startup*, not at build time) or `--cap-drop=ALL` (its s6-overlay init
  needs real Linux capabilities to remap PUID/PGID at startup) — confirmed
  via real `Operation not permitted` errors, not guessed. The confirmed
  working substitute: `--security-opt=no-new-privileges`, a real `/config`
  volume (this image's own persistent-data convention), `PUID`/`PGID` env
  vars. This is an open, documented question (a custom Dockerfile that
  pre-bakes the self-configuration at build time could restore the
  standard profile) — not attempted without real hardware to validate
  against.

## Compatibility gating

`apps/api/src/workspace-compatibility.ts`'s `analyzeWorkspace()` is the one
place that decides whether a specific machine can run a specific
workspace. It compares a manifest's `minimum`/`recommended` fields
(`workspace-manifests.ts`) against a machine's measured `MachineCapabilities`
(RAM, disk, VRAM, `cudaVersion`, `dockerAvailable`, `nvidiaRuntimeAvailable`,
`virtualizationAvailable`, and — new this project phase —
`desktopGpuRenderingAvailable`, a real, independently-measured field,
deliberately never inferred from CUDA availability). The result is one of
four states: `READY`, `LIMITED` (meets minimum but not recommended),
`INSTALL_REQUIRED`, or `INCOMPATIBLE`, each with an explicit, renter-visible
reason — a workspace card never just says "unavailable" with no
explanation.

`desktopGpuRenderingAvailable` is computed by the agent
(`platform_info.desktop_gpu_rendering_available()`: real Linux, explicitly
excluding WSL2, a real `/dev/dri/render*` node, NVIDIA Container Toolkit
registered) and flows through every path that builds a
`MachineCapabilities` object — heartbeat, both machine-linking flows, the
workspace analyze/manage routes, and the public listing routes. A machine
can be `READY` for CUDA-only workspaces (Developer/AI/Video/Mobile) while
still correctly `INCOMPATIBLE` for the desktop-GPU-rendering family — this
is the exact, real, live-reproduced situation on this project's own
development host (see `docs/WORKSPACES_OVERVIEW.md`).

**A workspace's presence in the catalogue is never proof it is bookable.**
The actual bookability gate is `executableWorkspaceSlugs`
(`apps/api/src/machine-workspace-catalog.ts`) on the API side and
`GATEWAY_WORKSPACE_SLUGS` (`agent/gpubnb_agent/workspace_gateway.py`) on the
agent side — both currently list exactly the same 9 REAL_WORKING slugs.
Compatibility `READY` plus catalogue presence is not enough by itself;
being in these two sets is what makes a booking attempt actually reach a
real runtime instead of being rejected.

## Booking → runtime lifecycle

Every session follows the same state machine, unchanged from the original
design and enforced identically regardless of workspace family:

`RESERVED → PREPARING → READY → ACTIVE → STOPPING → CLEANUP_VERIFY → TERMINATED`

A failed cleanup goes to `QUARANTINED`, never silently back to machine
availability. `GatewaySupervisor._reconcile_sessions()` runs this loop
continuously: it starts/adopts runtimes for desired sessions, stops
expired or explicitly-stop-requested ones, and sweeps any container/
volume/network that doesn't match a currently-desired session
(`_sweep_orphaned_containers()`) — this is what keeps a host's Docker state
consistent even after an agent crash/restart, proven live for the
Developer workspace (`e2e/recovery-agent-restart.sh`).

## Interactive readiness and billing

`READY` means the isolated runtime and its Gateway registration are
prepared; it does **not** mean the renter has received a usable, billable
session. For the browser-IDE-style workspaces, the sole activation signal
is the first signed frame returned by the host agent on the authenticated
browser WebSocket channel — only then does the session become `RUNNING`,
the booking become `ACTIVE`, and `startsAt`/`endsAt` reset to grant the full
purchased duration. If no interactive frame arrives within the bounded
connection window, cleanup remains fail-closed and the session ends
`TIMED_OUT`, never `COMPLETED`.

## Healthchecks

Two distinct, deliberately different mechanisms exist, and neither is
allowed to pretend to be the other:

- **The deep, one-shot proof job** (`workspace_health_command()` in
  `agent/gpubnb_agent/runner.py`): a real, per-slug functional test run in
  a throwaway container *before* the persistent session container is even
  started — real CUDA availability, a real ffmpeg NVENC/DSP pass, a real
  Jupyter kernel round-trip, a real offline Gradle build, a real
  tshark/YARA/radare2 pass, depending on the slug. This is what a
  detection-only check would have missed at least twice in this project's
  own history (NVENC's `video` driver-capability requirement, and a
  host-wide `tmpfs` `noexec` default that silently broke every renter
  script) — both real bugs, both caught only because the healthcheck
  actually *runs* the real workload, not just checks that a binary exists.
- **The shallow container `HEALTHCHECK` directive** (each workspace's own
  `healthcheck.sh`, baked into the Dockerfile): HTTP liveness plus, for
  Mobile/Security Lab/the desktop family, confirming the expected binary is
  on `PATH` — cheap, continuous, but explicitly documented as proving
  nothing about GPU rendering or deep functional correctness. The desktop
  family (Creator/Cloud Desktop/CAD/Gaming) deliberately has **no** deep
  one-shot proof job yet: writing one that claims to prove GPU-accelerated
  rendering without a real `/dev/dri` host to test it against would be
  exactly the kind of unproven claim this project's own rules forbid — see
  `docs/WORKSPACES_OVERVIEW.md`.

## Stop and cleanup

`_stop_runtime()` always runs the same three real Docker removals, in
order, regardless of workspace family — proxy, workspace container, then
volume and network — and reports success only if all four (`docker
inspect`/`docker volume inspect`/`docker network inspect`) genuinely
confirm removal, not merely that the `rm` command returned. This is the
same path exercised by expiry, explicit renter stop, and the orphan-sweep
on reconciliation. A workspace is never marked available again before this
verification succeeds.

## Access gateway

Interactive runtimes never publish an arbitrary host port to the internet.
The Gateway terminates the renter's connection and validates a short-lived
access grant bound to renter user ID, booking ID, and session ID —
one-session-scoped, stored hashed, never logged, revocable. The renter's
browser cannot supply an arbitrary upstream host/port; only the
server-side session's own registered runtime is reachable.

## Resource contract

A `WorkspaceSession` records an immutable allocation snapshot at start
time: accelerator ID (or none), VRAM expectation, CPU/RAM/disk budget,
runtime image digest, and network policy. The agent executes exactly that
snapshot — it never accepts arbitrary shell/Docker arguments supplied by a
renter or by the API at request time.
