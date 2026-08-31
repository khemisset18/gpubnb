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
- (pending commit this session) feat: real Audio Workspace runtime (FFmpeg DSP, no GPU)

Working tree is otherwise clean except this file. `main`/`origin/main` is
untouched (PR #133's merge commit). PR #134 (this branch → main) is still
open, not merged.

## 2. Executable workspaces (real runtime, real routes, real tests, live-verified)

`executableWorkspaceSlugs` in `apps/api/src/machine-workspace-catalog.ts` is
the one gate the whole system checks for `bookable`: **`compute`,
`developer`, `data`, `ai`, `video`, `audio`, `api`**. Do not add anything else
to this list without the same rigor documented below for each.

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
- This machine's own GPU (GTX 1650, 4GB VRAM) is below AI's/Video's manifest
  minimums (8GB/6GB), so both correctly show `INSUFFICIENT_VRAM` even though
  both runtimes are proven working. Audio and API need no VRAM at all.

All of Data/AI/Video/Audio/API: real booking/status/access routes
(`POST /bookings/:id/workspace/{data,ai,video,audio,api}`, `GET .../status`,
`POST .../access`), real buttons on `apps/web/workspace-bookings.js`, real
cleanup verified (container/proxy/volume/network all confirmed gone after
stop, GPU memory back to 0 MiB where GPU was used).

**Real bugs found and fixed via live testing** (not by any prior unit test):
1. `_real_health_check` in `workspace_gateway.py` used plain `urlopen()`,
   raising `HTTPError` for any non-2xx/3xx response instead of returning it.
   Fixed by catching `HTTPError` and checking `.code`.
2. NVENC's `video` driver-capability requirement (Video Workspace) - a
   detection-only healthcheck (`ffmpeg -encoders | grep nvenc`) would have
   missed this; the real-encode healthcheck caught it.

## 3. Containerized-desktop research — real findings across 5 workspaces, none buildable on THIS host

Researched whether a containerized (non-VM) desktop/streaming approach could
unlock Creator, Mobile, Security Lab, Gaming, and Audio's *full* GUI
experience, reusing the existing container+proxy+gateway architecture. All
five hit real, evidenced blockers specific to this exact host or this
codebase's current infrastructure - not guesses:

- **Creator (Blender)**: `linuxserver/blender` is a real, actively-maintained
  candidate (digest recorded, pulled and inspected) but needs
  `/dev/dri/renderD128` for GPU rendering, which **does not exist** on this
  Windows/Docker-Desktop/WSL2 host (only `/dev/dxg`, the CUDA-compute-only
  passthrough that made AI/Video/Data's `--gpus` work).
- **Mobile (Android emulator)**: same class of gap - `/dev/kvm` confirmed
  absent on this host (`docker run --device=/dev/kvm` fails at Docker's own
  device pre-flight check). `budtmo/docker-android` hard-requires it, no
  software fallback. A headless-build fallback was investigated as a reduced
  MVP (no emulator, just Gradle/Android-SDK CLI builds) using
  `mobiledevops/android-sdk-image:36.1.0` (Docker Hub, digest
  `sha256:679b9b29374719ec1160515911d674292d5b00bbb47408eb623a5cbbde57ceb2`,
  amd64 `sha256:af970bbcf86bdbdb2ebb41ceb66aabcd388dd6bb4e43b6ee4e84c033cb210722`,
  pulled and inspected live, then removed after inspection). **This is a dead
  end, not a reduced MVP**: `docker inspect` shows `Entrypoint=null
  Cmd=["/bin/bash"] User= ExposedPorts=null` (runs as root, no exposed
  port), and a live shell into the image found none of `code-server`,
  `ttyd`, `gotty`, `jupyter` on PATH - only `sshd` and `python3`. There is no
  HTTP/WebSocket-servable interface anywhere in this image, and this
  architecture's gateway (`workspace_gateway.py` / `loopback-proxy.js` /
  `workspace-gateway.ts`) only relays HTTP/WS to a fixed port - it cannot
  expose a bare CLI/SSH tool. This is the exact same "no interactive surface
  without a custom-published image" blocker as Security Lab below, not a
  buildable-now MVP as an earlier pass in this session concluded.
- **Security Lab (Kali)**: **not** a platform/protocol limitation - all 5
  official `kalilinux/*` Docker Hub images are confirmed bare (pulled
  `kali-rolling`, `nmap`/`sqlmap`/`hydra`/`tshark`/`msfconsole` all absent).
  Getting real tools needs `apt install kali-linux-headless`, but the
  internal session network is `--network=none` for every workspace, always -
  there is no network-available provisioning window anywhere in this
  architecture. Blocked by needing either a custom-published image (no
  registry credentials) or a new provisioning mechanism (separate
  infrastructure project) - **not** attempted.
- **Gaming (Sunshine/Moonlight)**: a **confirmed hard architectural
  blocker**, not a licensing/GPU issue - Sunshine's real data plane needs
  UDP (documented ports 47998-48010; Sunshine's own docs flag TCP-only
  setups as producing a black screen). This session's entire relay
  (browser WebSocket → API → agent → raw TCP) is TCP-only end to end, no
  UDP/ICE/WebRTC anywhere (confirmed by reading `loopback-proxy.js` and
  `workspace-gateway.ts`). Steam's own per-renter login is also real and
  unavoidable, but moot given the deeper blocker.
- **Audio's own interactive DAW GUI**: same desktop-streaming gap as
  Creator - not pursued; the real, honest reduced-scope MVP (FFmpeg DSP via
  Jupyter) was built instead (see section 2).

## 4. Other workspaces — real audit, not yet touched

| Workspace | Runtime needed | State |
|---|---|---|
| Cloud Desktop, Creator, CAD | `DESKTOP_VM` - blocked on this host by missing `/dev/dri` (section 3). A real candidate image exists (`linuxserver/blender`); untestable here. |
| Mobile | `ISOLATED_VM` - full emulator blocked by missing `/dev/kvm`; the headless-build fallback (`mobiledevops/android-sdk-image:36.1.0`) is also blocked, same pattern as Security Lab: bare CLI image, root user, no HTTP/WS-servable interface, cannot plug into this gateway architecture without a custom-published image (section 3). |
| Security Lab | `ISOLATED_VM`, `network:NONE` - blocked by no pre-tooled official Kali image + no network-available provisioning window in this architecture (section 3). |
| Gaming | `STREAMING_VM` - **hard architectural blocker**, confirmed: Sunshine/Moonlight need UDP, this relay is TCP-only (section 3). Would need a new tunneling infrastructure project. |

## 5. Test status (all re-run and green as of the API Workspace changes)

- `pytest agent/tests` → 315 passed, 2 skipped.
- `npm test` in `apps/api` → 483 tests, 473 passed, 0 failed, 10 skipped (need
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
  official, already-published image, never a custom one. The user has since
  scoped-authorized building a custom image **locally** for Mobile
  specifically, if the tools/dependencies it needs are genuinely available -
  see NEXT ACTION. This is `docker build` on this dev host (real internet
  access during the build step, same as any other build), producing an
  image referenced locally by content digest - not the same thing as
  publishing to a registry (ghcr.io), which still has no credentials and is
  not what was asked for. Do not push/publish any image to a registry
  without a separate, explicit go-ahead.
- Do not claim Creator/Cloud Desktop/CAD GPU rendering, Mobile's emulator or
  headless-build interface, Security Lab's tools, or Gaming's streaming work
  on this machine or with this architecture as it stands - all are real,
  evidenced, currently-unresolved blockers, not untested guesses.

## NEXT ACTION

Compute, Developer, Data, AI, Video, Audio, API are all real and done (7 of
13). The user has authorized building a custom GPUbnb-published image where
genuinely needed (previously a hard blocker - see git log for the go-ahead).
Remaining 6, in the user's stated priority order:
1. **Mobile**: full graphical emulator stays blocked by missing `/dev/kvm`
   (confirmed, do not claim otherwise). Re-investigate whether a real
   headless Android build/dev surface (SDK + Gradle + a real terminal/editor,
   HTTP/WS-servable) is buildable as a custom image now that one is
   authorized - the prior `mobiledevops/android-sdk-image` dead end was a
   bare CLI image with nothing to plug into this gateway, not proof no
   image can work.
2. **Security Lab**: same root blocker as Mobile previously (no pre-tooled
   HTTP/WS-servable image) - re-evaluate with a custom image now authorized,
   but keep `--network=none` and design any provisioning step explicitly and
   securely rather than opening a live network window.
3. **Creator, Cloud Desktop, CAD**: blocked by missing `/dev/dri` on this
   Windows/Docker-Desktop/WSL2 host. Needs either a real Linux host to test
   GPU rendering on, or a user decision to accept CPU-only software
   rendering as a documented limitation.
4. **Gaming**: hard architectural blocker - Sunshine/Moonlight need UDP,
   this relay is TCP-only end to end. Needs a new UDP/WebRTC tunneling
   infrastructure project, not a workspace-level task.

Do not commit without re-running the full three test suites first. Do not
push without explicit authorization.
