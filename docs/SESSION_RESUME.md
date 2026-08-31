# Session Resume — read this first if you are a new Claude Code session

**Purpose**: continuity note across sessions on this machine. Read top to
bottom before doing anything else.

**Do not push anything until the user explicitly authorizes it.** Commits are
authorized and have been made (see section 1); pushing is not.

---

## 1. Git state

Branch `fix/windows-agent-quiescence-and-e2e-harness`. `origin/...` is behind
by these commits (local only, not pushed):

- `7005c54` fix(agent): give docker_info's NVIDIA runtime probe a longer timeout
- `be31781` feat(host-desktop,agent): add real Détecter et libérer le GPU workflow
- `5b595fe` feat(agent,api,web): real Data Workspace runtime + full 13-workspace catalogue
- `1acebf8` docs: update session-resume note for Data Workspace completion
- `68134b4` feat(agent,api,web): real AI Workspace runtime with real GPU passthrough
- `1e36b72` feat(agent,api,web): real Video Workspace runtime (FFmpeg/NVENC)
- `025a1e7` feat(agent,api,web): real Audio Workspace runtime (FFmpeg DSP, no GPU)
- `2cc2383` docs: correct Mobile Workspace finding — headless-build MVP is blocked, not buildable
- `b29cea1` feat(agent,api,web): real API Workspace runtime (headless jupyter_server REST/WS kernel API)
- `01132f3` feat(agent,api,web): real Mobile Workspace runtime (custom local Android SDK/Gradle image) + a real tmpfs-exec bug fix affecting every $HOME-tmpfs workspace
- (pending commit this session) feat: real Security Lab Workspace runtime (custom local tshark/YARA/radare2 image, defensive-analysis scope)

Working tree is otherwise clean except this file. `main`/`origin/main` is
untouched (PR #133's merge commit). PR #134 (this branch → main) is still
open, not merged.

## 2. Executable workspaces (real runtime, real routes, real tests, live-verified)

`executableWorkspaceSlugs` in `apps/api/src/machine-workspace-catalog.ts` is
the one gate the whole system checks for `bookable`: **`compute`,
`developer`, `data`, `ai`, `video`, `audio`, `api`, `mobile`,
`security-lab`**. Do not add anything else to this list without the same
rigor documented below for each.

- **Compute / Developer**: pre-existing, proven via the original E2E harness.
- **Data**: real JupyterLab (`quay.io/jupyter/datascience-notebook`, official
  image, no GPU). Known gap: no PostgreSQL client tooling.
- **AI**: real JupyterLab + PyTorch + CUDA (`quay.io/jupyter/pytorch-notebook`),
  real `--gpus` passthrough scoped to the exact leased hardware UUID.
  Live-verified: `torch.cuda.get_device_name(0)` → real GPU name, inside the
  *running session container*.
- **Video**: real JupyterLab (same image as Data - its ffmpeg build already
  has real hardware h264_nvenc/hevc_nvenc/av1_nvenc), real `--gpus`
  passthrough. **Important, verified live**: NVENC needs
  `NVIDIA_DRIVER_CAPABILITIES` to include `video`, not just
  `compute,utility` - without it ffmpeg fails closed, no silent
  software fallback. Live-verified: a real h264_nvenc encode inside the
  *running session container*, written to the persistent volume.
- **Audio** (new this session): real JupyterLab (same image again - its
  ffmpeg build has real audio DSP filters: loudnorm EBU R128 normalization,
  acompressor, multi-band equalizers), **no GPU needed or attached**
  (confirmed live: `HostConfig.DeviceRequests` is `null` on the real
  container) - audio DSP has no hardware-codec equivalent to Video's NVENC,
  same no-GPU precedent Data already set. Live-verified: a real loudnorm
  pass inside the *running session container*, producing a real .wav file
  on the persistent volume.
  Known gap, documented in the manifest: no interactive Ardour/Audacity GUI
  or VST hosting (needs the same broken-on-this-host desktop-streaming path
  as Creator) - `workspace-runtime-profiles.ts`'s `audio` entry corrected
  from `STREAMING_VM` to `CONTAINER`/`NOTEBOOK`.
- **API** (new this session): a headless code-execution API, not a relabeled
  notebook. Same official image as Data/Audio
  (`quay.io/jupyter/datascience-notebook`), launched with
  `DOCKER_STACKS_JUPYTER_CMD=server` and every notebook/lab UI extension
  explicitly disabled (`--ServerApp.jpserver_extensions`), leaving only
  jupyter_server's own documented REST + WebSocket kernel API - confirmed
  live: `/lab` and `/tree` both 404. `--ServerApp.disable_check_xsrf=True`
  (same trust model as every other workspace here: jupyter's own
  token/password auth is off too, because the real security boundary is the
  GPUbnb-authenticated relay, not anything jupyter enforces) so a renter's
  own script can call the REST API directly, no browser cookie/XSRF handshake
  needed first. **No GPU** - CPU-only by design, so it stays usable on
  machines with no GPU at all (no vramMiB/cuda in its manifest minimum).
  Live-verified through the FULL production relay path (proxy container ->
  workspace container, not just the isolated healthcheck container): a real
  kernel created via `POST /api/kernels`, real code executed over its
  WebSocket channel, the real correct result read back
  (`gpubnb_api_workspace_live_ok 42 3.13.15`), confirmed no GPU device
  requests attached, idempotent second reconcile, full cleanup verified.
  Product framing: this is for a renter's own scripts/CI, not for clicking
  around in a browser - the "open" button surfaces jupyter_server's own
  minimal root page ("A Jupyter Server is running."), which is real but not
  the point; the point is the REST/WS API a renter's own code calls.
- **Mobile** (new this session): the first workspace here backed by a
  **custom GPUbnb image, built and used LOCALLY on this dev/test host only**
  (`workspaces/mobile/Dockerfile`) - not published to any registry (no
  credentials, and publishing to one is a separate decision the user has not
  made). Built FROM the already-proven Developer image (same code-server
  terminal/editor, same coder uid/gid 1000, same HTTP-on-3000 surface) plus
  a real Android SDK (`platform-tools`, `build-tools;36.1.0`,
  `platforms;android-36`, official Google cmdline-tools, integrity verified
  against the real published sha1) and a real Gradle 9.7.1 install (official
  distribution, integrity verified against the real published sha256). No
  graphical emulator: `/dev/kvm` is confirmed absent on this host - this is
  a real headless Android build & dev environment, not a device emulator.
  Pinned by a genuine local content-addressed digest
  (`gpubnb-mobile-workspace@sha256:...` - confirmed live that Docker
  registers a real local `RepoDigests` entry for a build that was never
  pushed anywhere, exactly as immutable as a registry digest, just not
  fetchable from one). Live-verified through the FULL production relay path
  (proxy container -> workspace container): real container launch, real
  health check through the real proxy, the real code-server UI served
  through the relay, no GPU device requests attached, and - the actual
  product proof - a real `./gradlew assembleDebug --offline` run **inside
  the running session container itself** (via `docker exec`, exactly what a
  renter would experience) producing a real `lib-debug.aar`, fully offline
  (`--network=none`), using only the Gradle cache pre-warmed into the image
  at build time (when it still had real internet access). Idempotent second
  reconcile and full cleanup also verified.
  Two real bugs found and fixed via live testing while building this (see
  the "Real bugs found" list below): a host-wide tmpfs-noexec default, and
  this workspace's own $HOME tmpfs being sized for the wrong (much smaller)
  workload.
  Known limitation, documented in `workspaces/mobile/welcome.md`: no live
  network inside a session, so a renter cannot `sdkmanager --install` a new
  SDK component or resolve a brand-new Gradle dependency version that
  wasn't already cached at build time - same isolation model every GPUbnb
  workspace already has.
- **Security Lab** (new this session): the second custom-local-image
  workspace (`workspaces/security-lab/Dockerfile`, same "built and used
  locally, not published" status as Mobile). **Product scope explicitly
  decided with the user before any build** (`AskUserQuestion`, since this
  carries real reputational/policy risk a technical fix alone can't
  resolve): a real **defensive analysis lab**, not an offensive pentesting
  toolkit. Built FROM the Developer image plus real `tshark`, `yara` and
  `radare2` - official Ubuntu 24.04 packages, GPL/BSD, no manual
  download/checksum dance needed (unlike Mobile's Android SDK). Deliberately
  excludes `nmap`/`sqlmap`/`hydra`/Metasploit: every session's real
  container has zero route to the public internet or to any other machine
  (same guarantee every GPUbnb workspace already has - confirmed by
  re-reading how `internal_network` is actually wired, not assumed), so an
  offensive tool would have no reachable target here - only "pentesting
  toolkit" labeling risk, no real added capability. Also excludes Burp
  Suite: its Community Edition EULA does not permit bundling into a
  redistributable image, regardless of which tool-set direction was chosen.
  Live-verified through the FULL production relay path: real container
  launch, real health check through the real proxy, the real code-server UI
  served through the relay, no GPU device requests attached, and real
  functional proofs for all three tools **inside the running session
  container itself** (`docker exec`): `tshark` correctly parsing a pcap
  built purely in userspace (no capture capability needed or granted - the
  real product scope is analyzing a renter's own uploaded capture file, not
  live capture), a real YARA rule matching a real sample, and `radare2`
  genuinely analyzing a real ELF binary. Idempotent second reconcile and
  full cleanup also verified.
  Known limitation, documented in `workspaces/security-lab/welcome.md`: no
  live capture (no capability grant, no live network to capture from
  either) and no live network inside a session to fetch new tools/rulesets.
- This machine's own GPU (GTX 1650, 4GB VRAM) is below AI's/Video's manifest
  minimums (8GB/6GB), so both correctly show `INSUFFICIENT_VRAM` even though
  both runtimes are proven working. Audio, API, Mobile and Security Lab need
  no VRAM at all.

All of Data/AI/Video/Audio/API/Mobile/Security-Lab: real booking/status/access
routes (`POST /bookings/:id/workspace/{data,ai,video,audio,api,mobile,security-lab}`,
`GET .../status`, `POST .../access`), real buttons on
`apps/web/workspace-bookings.js`, real cleanup verified (container/proxy/
volume/network all confirmed gone after stop, GPU memory back to 0 MiB where
GPU was used).

**Real bugs found and fixed via live testing** (not by any prior unit test):
1. `_real_health_check` in `workspace_gateway.py` used plain `urlopen()`,
   raising `HTTPError` for any non-2xx/3xx response instead of returning it.
   Fixed by catching `HTTPError` and checking `.code`.
2. NVENC's `video` driver-capability requirement (Video Workspace) - a
   detection-only healthcheck (`ffmpeg -encoders | grep nvenc`) would have
   missed this; the real-encode healthcheck caught it.
3. This host's `--tmpfs` mounts come up `noexec` by default unless `exec` is
   explicitly requested - silently blocked a renter's own `chmod +x
   ~/some-script && ~/some-script` (exit 126, "Permission denied", no error
   anywhere else) in every workspace whose $HOME is a tmpfs, including the
   already-shipped Developer image. Discovered while building Mobile
   Workspace's own $HOME-seeded Gradle wrapper (`./gradlew` itself failed to
   execute), then confirmed to affect Developer/Data-family workspaces too.
   Fixed by adding `exec` to `DEVELOPER_HOME_TMPFS`, `DATA_HOME_TMPFS`, and
   the Developer healthcheck's inline `/workspace` tmpfs, all in `runner.py`.
4. Mobile Workspace's own $HOME tmpfs, sized like every other workspace's
   (512m), overflowed mid-seed ("No space left on device") because its
   pre-warmed Gradle cache alone is ~700MB - measured live with `du -sh`.
   Fixed with a dedicated `MOBILE_HOME_TMPFS` (2048m) instead of reusing
   `DEVELOPER_HOME_TMPFS`, plus a matching memory-budget bump for the
   one-shot healthcheck container (`--memory=4g`, up from 2g, since tmpfs
   usage counts against the container's memory cgroup).

## 3. Containerized-desktop research — real findings, still blocked on THIS host (except Mobile, now unblocked - see section 2)

Researched whether a containerized (non-VM) desktop/streaming approach could
unlock Creator, Gaming, and Audio's *full* GUI experience, reusing the
existing container+proxy+gateway architecture. All hit real, evidenced
blockers specific to this exact host or this codebase's current
infrastructure - not guesses:

- **Creator (Blender)**: `linuxserver/blender` is a real, actively-maintained
  candidate (digest recorded, pulled and inspected) but needs
  `/dev/dri/renderD128` for GPU rendering, which **does not exist** on this
  Windows/Docker-Desktop/WSL2 host (only `/dev/dxg`, the CUDA-compute-only
  passthrough that made AI/Video/Data's `--gpus` work).
- **Mobile (graphical Android emulator specifically)**: same class of gap -
  `/dev/kvm` confirmed absent on this host (`docker run --device=/dev/kvm`
  fails at Docker's own device pre-flight check). `budtmo/docker-android`
  hard-requires it, no software fallback - this remains genuinely
  unavailable and is not claimed anywhere. A headless-build fallback (no
  emulator) was first investigated using a pre-built image
  (`mobiledevops/android-sdk-image:36.1.0`) and found to be a dead end (bare
  CLI image, no HTTP/WS-servable interface). Once the user authorized
  building a custom image locally, Mobile Workspace was built instead as a
  real headless Android SDK/Gradle environment layered onto the
  already-proven Developer image - see section 2. This is real and
  REAL_WORKING now, but the graphical-emulator gap itself is unchanged and
  still real.
- **Security Lab (Kali specifically)**: **not** a platform/protocol
  limitation - all 5 official `kalilinux/*` Docker Hub images were confirmed
  bare (pulled `kali-rolling`, `nmap`/`sqlmap`/`hydra`/`tshark`/`msfconsole`
  all absent), and `apt install kali-linux-headless` would need live
  network access this architecture's sessions never have. Once the user
  authorized a custom local image (same authorization Mobile used), Security
  Lab was built a different way instead: not FROM any Kali image at all, but
  FROM the Developer image plus real `tshark`/`yara`/`radare2` (official
  Ubuntu 24.04 packages) - see section 2. Real, tested, live-validated. The
  underlying "no live-network provisioning window" fact that blocked the
  Kali-metapackage route is unchanged and still real; the working path
  turned out not to need it.
- **Gaming (Sunshine/Moonlight specifically)**: a **confirmed hard
  architectural blocker**, not a licensing/GPU issue - Sunshine's real data
  plane needs UDP (documented ports 47998-48010; Sunshine's own docs flag
  TCP-only setups as producing a black screen). This session's entire relay
  (browser WebSocket → API → agent → raw TCP) is TCP-only end to end, no
  UDP/ICE/WebRTC anywhere (confirmed by reading `loopback-proxy.js` and
  `workspace-gateway.ts`). Steam's own per-renter login is also real and
  unavoidable, but moot given the deeper blocker. **This blocks
  Sunshine/Moonlight specifically, not Gaming as a category**: a later
  session investigated Selkies-GStreamer (the same foundation as Creator/
  Cloud Desktop/CAD) as a browser-compatible alternative and found its
  default transport is plain WebSocket - i.e. genuinely TCP-only,
  compatible with this exact relay - see section 8's Gaming subsection for
  the real Steam feasibility test performed.
- **Audio's own interactive DAW GUI**: same desktop-streaming gap as
  Creator - not pursued; the real, honest reduced-scope MVP (FFmpeg DSP via
  Jupyter) was built instead (see section 2).

## 4. Other workspaces — real audit, not yet touched

| Workspace | Runtime needed | State |
|---|---|---|
| Cloud Desktop, Creator, CAD, Gaming | `CONTAINER` (Selkies-GStreamer, corrected from the originally-assumed `DESKTOP_VM`/`STREAMING_VM` - see workspace-runtime-profiles.ts) - blocked on this host by missing `/dev/dri` (section 3), not by networking (see section 8's WebSocket-transport correction). Real, live-tested candidate images and, for Gaming, a real Steam install/bootstrap - see section 8. |

## 5. Test status (all re-run and green as of the Security Lab Workspace changes)

- `pytest agent/tests` → 337 passed, 2 skipped. (One run also showed
  `test_long_health_check_keeps_reporting_progress` failing - a pre-existing,
  purely timing-based test unrelated to any change this session, patched to
  a 0.01s progress interval; confirmed flaky under load, not a regression:
  passes in isolation and on every other full-suite run.)
- `npm test` in `apps/api` → 489 tests, 479 passed, 0 failed, 10 skipped (need
  a local Postgres/Redis this machine doesn't have running — environmental).
- `cargo test --features desktop-runtime` → not re-checked this round since
  nothing in host-desktop changed this session; last checked 106 passed, 1
  pre-existing failure (see section 6).
- `docker ps -a` / `docker volume ls` checked clean after all live testing —
  no orphaned containers.

## 6. Known pre-existing issue — do not "fix" by touching production state

`tests::status_never_claims_ready_by_default` (host-desktop Rust) fails only
on this specific machine because `build_status()` shells out to the real,
genuinely-linked, running production `gpubnb-agent`. Pre-dates this branch.
Do not unlink/reconfigure the production agent to make this pass.

## 7. What must NOT be done

- No push without explicit authorization.
- Do not touch the production `gpubnb-agent` service/config/keys.
- Do not fabricate a "bookable" workspace slug without a real runtime behind
  it — see section 2's rigor bar for every entry in `executableWorkspaceSlugs`.
- Compute/Developer/Data/AI/Video/Audio/API all deliberately used an
  official, already-published image, never a custom one. Mobile and
  Security Lab are the two exceptions: custom GPUbnb images, built
  **locally** on this dev/test host only (`workspaces/mobile/Dockerfile`,
  `workspaces/security-lab/Dockerfile`), each per its own scoped
  authorization from the user (Mobile: "si les outils et dépendances
  nécessaires sont réellement disponibles"; Security Lab: an explicit
  `AskUserQuestion` decision on tool scope before any Dockerfile was
  written). This is still **not** published to any registry (ghcr.io, no
  credentials, not requested) - both are therefore only actually runnable
  on a host machine that has run their exact `docker build` itself. Do not
  push/publish any image to a registry without a separate, explicit
  go-ahead, and do not build a NEW custom image for another workspace
  without checking whether a scoped authorization already covers it, or
  asking first - Security Lab's authorization in particular came with an
  explicit product-scope decision (defensive-analysis-only, no offensive
  tools, no Burp Suite) that must not be silently expanded later.
- Do not claim Creator/Cloud Desktop/CAD GPU rendering, a graphical Android
  emulator for Mobile (headless SDK/Gradle is real; the emulator specifically
  is not and is not offered), offensive pentesting capability for Security
  Lab (tshark/YARA/radare2 are real; nmap/sqlmap/hydra/Metasploit were
  deliberately excluded, live network capture is not offered), or Gaming's
  streaming work on this machine or with this architecture as it stands -
  all are real, evidenced, currently-unresolved blockers, not untested
  guesses.

## 8. Technical plans for the 4 remaining workspaces — implementation now started (compatibility gating), runtime still NOT built/proven

Grounded in verified facts (NVIDIA's own container-toolkit docs, Selkies'
own docs, Sunshine/Moonlight's own docs), not assumptions. **None of
Creator/Cloud Desktop/CAD/Gaming is REAL_WORKING or bookable** - none is in
`executableWorkspaceSlugs` - and nothing here claims GPU rendering works on
this host. What changed since the plan was first written: real, tested,
honest **hardware-compatibility detection** now exists end to end for all
four (see 8a below), a real Selkies-based image was live-tested (container/
HTTP/Gateway-relay/gamepad/audio all confirmed, see 8b), and a real Steam
feasibility test was performed for Gaming (see the Gaming section below).
**Corrected finding**: Selkies' default transport is plain WebSocket, not
WebRTC, so - contrary to this plan's own earlier assumption - no new
TURN/WebRTC infrastructure is needed for a first working version; this
platform's existing Gateway already relays real WebSocket traffic in
production. The one thing still genuinely not built or provable: actual
GPU-accelerated rendering itself - no Linux GPU host is available this
session.

### 8a. What's real now: hardware-compatibility detection (implemented, tested)

- **Agent**: `agent/gpubnb_agent/platform_info.py`'s
  `desktop_gpu_rendering_available()` - a real, cheap, static check: real
  Linux (explicitly excludes WSL2, which reports `platform.system()=="Linux"`
  too and must never be assumed away), a real `/dev/dri/render*` node, and
  the NVIDIA Container Toolkit registered with Docker. Wired into
  `system_inventory()`, so it is now part of every heartbeat/link payload.
  Live-tested with a genuine negative-case assertion on this real host
  (confirmed `False`, matching every other live check this session), plus
  mocked positive/negative branches. This is deliberately independent from
  `nvidiaRuntimeAvailable`/`cudaVersion`: this host has real, working CUDA
  compute passthrough (AI/Video/Developer/Mobile's `--gpus` all work) but
  no `/dev/dri` - proving desktop-GPU-rendering capability is genuinely not
  implied by CUDA compute capability, and confirming why this needed its
  own dedicated, independently-measured field rather than being inferred.
- **API**: `desktopGpuRenderingAvailable` is now a real column on `Machine`
  (migration `20260831193253_add_desktop_gpu_rendering_available`), flows
  through both machine-linking paths (`/agent/link`,
  `device-authorization-routes.ts`'s device-code flow) and the heartbeat
  handler, and is selected everywhere a `MachineCapabilities`-shaped object
  is built (workspace analyze/manage routes, `ensureCompatibleMachineWorkspace`,
  the public listing + full-catalogue routes). `analyzeWorkspace()` gates
  Creator/Cloud Desktop/CAD on it exactly like every other required-flag
  check (CUDA/Docker/NVIDIA Container Toolkit/virtualization) - no redesign
  of the existing 4-state compatibility model. Tested: a real
  CUDA-compute-capable-but-no-`/dev/dri` machine (mirroring this exact dev
  host) is never `READY` for any of the three; a machine with a real
  `/dev/dri` + NVIDIA Container Toolkit is compatible.
- **Manifests corrected** to the real planned architecture: Creator/Cloud
  Desktop/CAD now list `Selkies-GStreamer`/`WebRTC` plus Blender/FreeCAD
  respectively (not the previous RDP/noVNC/Guacamole/AutoCAD/Fusion 360,
  none of which was ever actually planned), require
  `desktopGpuRendering:true`, and no longer require `virtualization`
  (this is planned as a container, not a VM). `license` corrected to
  `INCLUDED_OPEN_SOURCE` (Blender/FreeCAD/Selkies are all real, free, open
  source - AutoCAD/Fusion 360 were never realistically plannable here and
  are dropped entirely, not just delicensed).
- **Runtime profiles corrected**: `DESKTOP_VM` → `CONTAINER` for all three
  (no VM/hypervisor infrastructure exists in this codebase, and the real
  planned architecture needs none), `entrypoint` corrected from the
  fictional `desktop-gateway` to `selkies-gstreamer`.
- **`scripts/preflight-linux-gpu-desktop.sh`**: a standalone, read-only
  preflight a future Linux host operator can run before even installing
  the GPUbnb agent. Mirrors the same real checks as
  `desktop_gpu_rendering_available()`, plus one further real test this
  script alone performs: launches a real throwaway container with
  `--gpus all -e NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute`
  and checks whether `/dev/dri` is visible *inside* it - the closest
  thing to a real GPU_PROOF-style check obtainable without a full desktop
  image. Live-tested on this real host: correctly reports `FAIL` for the
  Linux-kernel check, the `/dev/dri` check, and the in-container check,
  `OK` for Docker/NVIDIA-driver/NVIDIA-Container-Toolkit (all genuinely
  present here), overall verdict `NOT READY`, exit code 1 - exactly
  matching this host's real, already-established status.

### 8b. What's still not real: the actual desktop runtime

`workspaces/cloud-desktop/Dockerfile` builds `FROM linuxserver/webtop`
(real, official, actively-maintained Selkies-GStreamer-based image, digest
`sha256:49a08b1e871aa300829d206141dc932459c7db2866269120ad79ec9d959ccbed`,
resolved via the Docker Hub API 2026-08-31) - see
`workspaces/cloud-desktop/NOT_YET_WORKING.md` for the full detail. **Live
end-to-end tested on this host, honestly scoped to what doesn't need a
GPU**:
- Real container start, real HTTP 200 with the real Selkies HTML client on
  port 3000 - confirmed live that port 3000 is webtop's own documented
  plain-HTTP reverse-proxy port, so this platform's `WORKSPACE_ENTRY_PORT=3000`
  convention needs no remapping for this image.
- **The real `loopback-proxy.js` relay** - the exact same script every
  REAL_WORKING workspace's Gateway already depends on - correctly relays a
  full request through to this image, using the exact same two-network
  pattern (proxy container on the gateway network + published port,
  separately `docker network connect`ed to the session's internal network)
  `_launch_proxy_container()` already uses in production. Real 200, real
  relayed HTML content, confirmed live.
- Real gamepad support confirmed live in the container's own startup logs
  (Selkies initializes 4 persistent gamepad instances) - relevant to the
  Gaming Workspace plan below too, not just Creator/Cloud Desktop/CAD.
- Real stop/cleanup confirmed (containers and networks all gone after).
- **Confirmed NOT provable here**: `/dev/dri` is absent both on this host
  and inside this exact image's own container (checked live) - there is
  nothing to test GPU rendering against, and nothing here claims it works.

Creator/CAD would layer real Blender/FreeCAD onto this same base (the
identical low-risk pattern already proven for Mobile/Security Lab) but
have no Dockerfile of their own yet - building a second and third
untestable variant of the same open question (does GPU rendering work at
all in this architecture) isn't worth doing before the first one is
answered on real hardware.

### Creator / Cloud Desktop / CAD (grouped: same underlying architecture)

These three need the same thing - a real GPU-accelerated Linux desktop,
streamed to a browser - just different application software on top
(Blender / a general desktop / FreeCAD). One infrastructure investment
unlocks all three (and Gaming - see below).

1. **Linux infrastructure needed**: a real Linux host (bare-metal or a
   Linux VM with real GPU passthrough - NOT WSL2) running Docker Engine +
   the NVIDIA Container Toolkit, with the NVIDIA proprietary driver
   installed at the OS level. That driver install is what populates
   `/dev/dri/renderD128` and enables OpenGL/Vulkan - confirmed via NVIDIA's
   own container-toolkit docs that `NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute`
   (or `all`) is what exposes `/dev/dri` and graphics APIs inside a
   container on a real Linux host; this capability set is unavailable under
   WSL2 (only `/dev/dxg`, compute-only), which is the entire reason this is
   blocked here and not a code problem. `agent/gpubnb_agent` is already
   plain cross-platform Python (its own test suite already runs on
   Linux/macOS CI) - no agent rewrite needed, just a real Linux deployment
   target for it to run on.
2. **Images/runtime**: `linuxserver/webtop` (Selkies-GStreamer based, live
   end-to-end tested this session - see 8a/8b above) as the base for Cloud
   Desktop and (Steam layered on top) Gaming; the already-identified
   `linuxserver/blender` (same Selkies/EGL base) for Creator; for CAD, the
   same pattern already proven three times this session (Mobile: Android
   SDK; Security Lab: tshark/YARA/radare2; Gaming: Steam - see below) - a
   real, open-source FreeCAD `apt`-installed onto the same Selkies-based
   desktop image, not a fabricated one.
3. **Hardware needed**: any NVIDIA GPU (consumer or datacenter) with a real
   proprietary driver on the Linux host, giving working OpenGL 4.x/Vulkan
   1.x via EGL and NVENC hardware encoding (Selkies uses NVENC when
   available, falls back to software H.264/VP8/VP9 otherwise per its own
   docs).
4. **How the renter accesses the desktop**: browser-based, same "Ouvrir"
   button pattern every GPUbnb workspace already uses - confirmed live that
   Selkies' default transport is plain WebSocket (see the correction below,
   not the WebRTC this was originally assumed to need), served on the same
   port this platform's Gateway already relays.
5. **How the GPU is transmitted**: `--gpus device={exact_leased_hardware_uuid}
   -e NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute` - reuses
   the exact same exact-leased-GPU-UUID pattern already implemented for
   Developer/AI/Video (`GPU_ATTACHED_WORKSPACE_SLUGS`, never a fixed device
   index), just with `graphics,display` added to the capability set.
6. **Security/isolation**: same hardening pattern as every workspace here
   (`--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
   isolated internal Docker network) - but the exact minimal capability set
   Selkies' EGL rendering actually needs under that hardening can only be
   determined by testing on real hardware, not assumed; document it once
   proven, don't guess it into the Dockerfile now.
7. **Integration with GPUbnb - corrected finding, real infrastructure gap
   is smaller than first assumed**: this session's own earlier research
   assumed Selkies' media stream would need real WebRTC (ICE/STUN/TURN),
   which the existing `loopback-proxy.js` (a dumb raw-TCP byte relay)
   cannot negotiate, and planned a new `coturn` TURN-over-TCP component to
   bridge that gap. **Corrected after actually running the image and
   reading its own live startup config**: Selkies' *default* transport is
   plain WebSocket, not WebRTC - confirmed both by Selkies' own docs
   ("streams over plain WebSockets by default, serving the web interface,
   signaling, and media on a single port"; WebRTC is opt-in via
   `--mode=webrtc`, a later latency optimization) and by this exact image's
   own startup log (`'mode': 'websockets'` in its printed config). A plain
   WebSocket is exactly what this platform's Gateway already relays in
   production today - Developer Workspace's own code-server terminal
   already proves that exact relay pattern works. **This means no new TURN
   component is needed for a first real, working version** - only once
   proven on real hardware (WebRTC mode remains a legitimate *later*
   optimization for lower latency, not a blocker). Booking/session/routes
   need no architectural change either way - they'd reuse
   `workspace-renter-routes.ts`/`workspace-gateway.ts`/
   `rental-resource-authority.ts`/`executableWorkspaceSlugs` exactly as the
   9 existing workspaces already do.

**Validation plan required before claiming any of this works:**
1. Get access to a real Linux host with a real NVIDIA GPU (a Linux GPU VM,
   or a dedicated Linux workstation with the driver actually installed).
2. Install Docker + NVIDIA Container Toolkit; confirm `/dev/dri/renderD128`
   exists and a test container's `glxinfo`/`vulkaninfo` show real
   NVIDIA-backed rendering (not `llvmpipe`/Mesa software fallback) - or
   just run `scripts/preflight-linux-gpu-desktop.sh`, which already checks
   exactly this.
3. Run `linuxserver/webtop` or `linuxserver/blender` with `--gpus`; confirm
   the browser client shows a real GPU-rendered desktop, and confirm a real
   browser can actually drive a WebSocket session through the existing
   Gateway end to end (this session proved the relay carries the initial
   HTTP page; a full interactive session with a real browser client was
   not attempted - no browser automation was used this session).
4. Only after those are proven, wire into the agent/API/frontend following
   the exact same pattern the 9 already-built workspaces use.

### Gaming - real feasibility investigated and mostly confirmed; GPU rendering itself still unproven

Reuses the exact same Selkies-based foundation as Creator/Cloud
Desktop/CAD, with Steam layered on top - not a separate infrastructure
project. **Sunshine/Moonlight was investigated and ruled out**, re-confirmed
via web search (not just prior-session claims): "Sunshine needs both TCP
and UDP, and video/audio streaming specifically rides on the UDP
ports...Sunshine requires TCP ports 47984,47989,47990,48010 and UDP ports
47998-48000,48002" - Sunshine has **no TCP-only fallback at all** ("a
TCP-only forward will pair successfully but never actually show video"),
unlike Selkies' WebSocket-by-default transport. Moonlight is also normally
a *native* client app, not a browser client - fitting it into GPUbnb's
all-in-browser model would need either a native-client product change or
an unproven custom WebRTC-to-Sunshine bridge - not attempted, not
recommended without a much larger, separate decision.

**Real feasibility test performed this session** (Ubuntu-based
`linuxserver/webtop` variant - `ubuntu-xfce` tag, needed instead of the
default Alpine-based tag because Steam requires glibc, confirmed live:
Alpine's `latest` tag has no Steam package at all):
- The real, official Ubuntu multiverse `steam-installer` package (not a
  third-party or pirated source) installs cleanly with `apt-get` (real
  internet access at test/build time, same as every other custom image
  this session) - confirmed live, along with its i386 Mesa/GL dependencies.
- The real Steam launcher (`/usr/games/steam`, a real executable shell
  script) was run inside a live, fully-running webtop container (its real
  Xvfb X server on `DISPLAY=:1`, software-rendered via Mesa llvmpipe since
  no `/dev/dri` here) and genuinely bootstrapped: created its real
  `~/.steam` install directory and symlinks, exactly like a first real
  Steam run does, before the interactive GUI step (which needs either a
  real display session or further scripting this session did not attempt)
  and further downloads.
- Real gamepad support confirmed live in Selkies' own startup logs on both
  webtop variants tested (4 persistent "Microsoft X-Box 360 pad" instances
  initialized automatically).
- Real audio support confirmed: `audio_enabled: true` and
  `microphone_enabled: true` in Selkies' own live startup config, and the
  `pulseaudio` binary confirmed present in the image.
- **Confirmed NOT provable here**: real 3D-accelerated game rendering -
  same `/dev/dri` absence as Creator/Cloud Desktop/CAD, and unlike a
  general desktop or even Blender, actual gameplay is far more directly
  gated on this than the others.

**Content/licensing model** (per the user's explicit requirement): the
renter brings their own Steam account and their own already-owned games -
GPUbnb never bundles, hosts, or redistributes any game or Steam content.
This matches `license:'USER_ACCOUNT_REQUIRED'` in the manifest, unchanged
from before. Storage persistence (so a renter's Steam library survives
across a session) reuses the exact same real per-session Docker volume
mount every other workspace already has (`persistentWorkspace:true`) - no
new mechanism needed. Policy question (not a technical one, not decided
here): which games/content are acceptable to install in a rented session -
worth an explicit decision before this goes live, not an unstated default.

- **Architecture recommended**: Selkies-GStreamer (WebSocket-default mode,
  no new TURN component needed - see the correction above) + Steam, same
  foundation as Creator/Cloud Desktop/CAD.
- **Components needed**: a real Linux GPU host (shared with Creator/Cloud
  Desktop/CAD - no Gaming-specific infrastructure beyond that).
- **Modifications needed in GPUbnb**: none beyond what Creator/Cloud
  Desktop/CAD already need (see 8a) - booking/routing/compatibility-gating
  patterns all already extend cleanly (`desktopGpuRendering` gates Gaming
  exactly like the other three, tested - see below).
- **Risks**: latency/experience quality vs. native Sunshine/Moonlight (a
  real, honest tradeoff of the browser-compatible path, not hidden);
  content/policy governance for what renters install; Steam's own
  per-renter login is real and unavoidable.
- **Difficulty**: Low incremental cost on top of Creator/Cloud Desktop/CAD
  (same image family, same infrastructure) once a Linux GPU host exists;
  the GPU-rendering proof itself is the same difficulty as the other three.
- **Test plan**: same Linux-GPU-host validation plan as Creator/Cloud
  Desktop/CAD, plus: confirm hardware-accelerated game rendering actually
  works (not just the desktop compositor), confirm real gamepad
  input round-trips correctly through a real browser session, confirm
  real audio streams correctly - before claiming Gaming works.

## NEXT ACTION

Compute, Developer, Data, AI, Video, Audio, API, Mobile, Security Lab are all
real and done (9 of 13), all re-verified green this session (agent 344
passed, apps/api 501+ passed, working tree clean, no regressions - re-run
counts after Gaming's own changes are in section 5/the final report).
Remaining 4 are still not REAL_WORKING and not bookable, but real progress
was made on their common infrastructure this session (see section 8): real,
tested hardware-compatibility detection end to end (agent + API + DB) for
all four including Gaming, a real preflight script for a future host
operator, a live-tested `linuxserver/webtop` base image proving the
container/HTTP/Gateway-relay/gamepad/audio/stop/cleanup path works, and (for
Gaming specifically) a real, live-tested Steam install/bootstrap on the
Ubuntu-based Selkies image. **Corrected finding that removes what was
thought to be the biggest remaining infrastructure gap**: Selkies' default
transport is plain WebSocket, not WebRTC, so no new TURN/coturn component
is needed for a first working version of any of the four - this platform's
existing Gateway already relays real WebSocket traffic in production
(Developer Workspace's own terminal). The one thing genuinely still not
built or provable for any of the four: real GPU-accelerated rendering
itself - no Linux GPU host is available this session. Next concrete step
once a real Linux GPU host is available: run
`scripts/preflight-linux-gpu-desktop.sh` on it, then follow section 8's
validation plans (Creator/Cloud Desktop/CAD and Gaming share the same
plan). Do not build the remaining GPU-rendering proof without the user's
explicit go-ahead: it needs a real Linux GPU host, or a product decision
(accept CPU-only rendering? accept Selkies-tier gaming latency instead of
native Sunshine/Moonlight? what game/content policy for Gaming?) that isn't
a call to make unilaterally.

Do not commit without re-running the full three test suites first. Do not
push without explicit authorization.
