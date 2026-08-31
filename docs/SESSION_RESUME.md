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
- (pending commit this session) feat: real Video Workspace runtime (FFmpeg/NVENC)

Working tree is otherwise clean except this file. `main`/`origin/main` is
untouched (PR #133's merge commit). PR #134 (this branch → main) is still
open, not merged.

## 2. Executable workspaces (real runtime, real routes, real tests, live-verified)

`executableWorkspaceSlugs` in `apps/api/src/machine-workspace-catalog.ts` is
the one gate the whole system checks for `bookable`: **`compute`,
`developer`, `data`, `ai`, `video`**. Do not add anything else to this list
without the same rigor documented below for each.

- **Compute / Developer**: pre-existing, proven via the original E2E harness.
- **Data**: real JupyterLab (`quay.io/jupyter/datascience-notebook`, official
  image, no GPU). Known gap: no PostgreSQL client tooling (image doesn't ship
  psycopg2/psql; documented in the manifest's `technologies`, not silently
  overclaimed).
- **AI**: real JupyterLab + PyTorch + CUDA (`quay.io/jupyter/pytorch-notebook`,
  official image), with real `--gpus` passthrough scoped to the exact leased
  hardware UUID (same mechanism Developer already used -
  `GPU_ATTACHED_WORKSPACE_SLUGS` in `workspace_gateway.py`). Live-verified: a
  hardened (`--read-only --cap-drop=ALL --network=none`) container's PyTorch
  sees the real GPU (`torch.cuda.get_device_name(0)` → "NVIDIA GeForce GTX
  1650"), and the *running session container* (not just the healthcheck) does
  too.
- **Video**: real JupyterLab (same `quay.io/jupyter/datascience-notebook`
  image as Data - its ffmpeg build already has genuine hardware
  h264_nvenc/hevc_nvenc/av1_nvenc, confirmed live, no new image needed) with
  real `--gpus` passthrough. **Important, verified live**: NVENC requires
  `NVIDIA_DRIVER_CAPABILITIES` to include `video`, not just `compute,utility`
  - without it, ffmpeg fails closed ("Cannot load libnvidia-encode.so.1"),
    it does not silently fall back to software encoding. Handled in both
  `workspace_gateway.py`'s legacy path and v5's exact-UUID path. Healthcheck
  performs a *real* NVENC encode (not just a codec-list check). Live-verified
  end-to-end: a real `h264_nvenc` encode run inside the *running session
  container* (not just at healthcheck time), writing a real .mp4 to the
  persistent `/home/jovyan/work` volume.
  Known gap, documented in the manifest: no DaVinci Resolve (no official
  freely-redistributable Linux container exists) and no interactive Blender
  GUI (see Creator/DRI finding below) - `workspace-runtime-profiles.ts`'s
  `video` entry was corrected from `DESKTOP_VM` to `CONTAINER`/`NOTEBOOK` to
  match what's actually delivered.
- This machine's own GPU (GTX 1650, 4GB VRAM) is below AI's/Video's manifest
  minimums (8GB/6GB), so both correctly show `INSUFFICIENT_VRAM` in the
  compatibility engine even though both runtimes are proven working.

All of Data/AI/Video: real booking/status/access routes
(`POST /bookings/:id/workspace/{data,ai,video}`, `GET .../status`, `POST
.../access`), real buttons on `apps/web/workspace-bookings.js`, real cleanup
verified (container/proxy/volume/network all confirmed gone after stop, GPU
memory back to 0 MiB after AI/Video).

**Real bugs found and fixed via live testing** (not by any prior unit test):
1. `_real_health_check` in `workspace_gateway.py` used plain `urlopen()`,
   which raises `HTTPError` for any non-2xx/3xx response instead of
   returning it — its documented "200 ≤ status < 500 counts as healthy"
   contract silently never worked for a real 4xx. Fixed by catching
   `HTTPError` and checking `.code`. Regression tests: `RealHealthCheckTests`
   in `test_workspace_gateway.py`.
2. NVENC's `video` driver-capability requirement above - would have shipped
   a "Video Workspace" whose GPU encoding silently didn't work, if only
   detection (`ffmpeg -encoders | grep nvenc`) had been checked instead of a
   real encode.

## 3. Creator Workspace / containerized-desktop research — real finding, not yet buildable here

Researched whether a containerized (non-VM) noVNC desktop could unlock
Creator/Cloud Desktop/CAD using the existing container+proxy+gateway
architecture. Found a strong candidate: `linuxserver/blender` (Docker Hub,
pulled and inspected this session, real digest
`linuxserver/blender@sha256:ebf57305c6c32245107916cf1eeda7d675fe6c5c52ac6d41d0241c75fc127237`) -
actively maintained, WebSocket-based Selkies streaming (matches the existing
single-port TCP-relay proxy architecture), no licensing red flags.

**But GPU rendering for it needs `/dev/dri/renderD128` (DRI/DRM render-node
passthrough), which does NOT exist on this Windows/Docker-Desktop/WSL2 host**
- confirmed live: `ls /dev/dri/` fails inside a container here; only
`/dev/dxg` (the WSL2 CUDA-compute passthrough device, which is what makes
`--gpus` work for AI/Video) is present. This is a real, host-platform-specific
limitation, not a guess - a native Linux host would very likely expose
`/dev/dri` normally. **Do not build Creator Workspace on this machine without
either (a) testing on a real Linux host, or (b) accepting CPU-only software
rendering as a documented, degraded `COMPATIBLE_WITH_LIMITATIONS` mode** -
shipping a "GPU rental" product whose GPU rendering silently doesn't work
would be exactly the kind of dishonest workspace this mission forbids.

## 4. Other workspaces — real audit, not yet touched

| Workspace | Runtime needed | State |
|---|---|---|
| API | Unclear — no product definition exists anywhere in the codebase for what "API Workspace" concretely gives a renter (REST access to what, exactly?). **Do not build this without a real product decision** - inventing one myself risks exactly the fake-functionality the mission forbids. |
| Cloud Desktop, Creator, CAD | `DESKTOP_VM` in `workspace-runtime-profiles.ts` - see section 3: a real containerized-desktop candidate exists (`linuxserver/blender`) but its GPU rendering path isn't testable on this Windows host. |
| Mobile, Security Lab | `ISOLATED_VM` - needs real isolation (Android emulation / hardened VM), bigger lift than the above, not investigated yet. |
| Gaming | `STREAMING_VM` + `REQUIRES_USER_LICENSE` (Steam account) - needs streaming infra (Sunshine/Moonlight) that doesn't exist, plus real licensing UX. Not investigated. |
| Audio | `STREAMING_VM` - needs streaming infra that doesn't exist. Not investigated. |

## 5. Test status (all re-run and green as of the Video Workspace changes)

- `pytest agent/tests` → 298 passed, 2 skipped.
- `npm test` in `apps/api` → 470 passed, 0 failed, 10 skipped (need a local
  Postgres/Redis this machine doesn't have running — environmental).
- `cargo test --features desktop-runtime` → not re-checked this round since
  nothing in host-desktop changed this session; last checked 106 passed, 1
  pre-existing failure (see section 6).
- `docker ps -a` / `docker volume ls` / `nvidia-smi` checked clean after all
  live testing — no orphaned containers, 0 MiB GPU memory in use.

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
- Do not build/publish a custom GPUbnb container image without the user's
  explicit go-ahead (registry credentials, CI trigger) — every workspace so
  far deliberately used an official, already-published image instead.
- Do not invent a product definition for API Workspace unilaterally.
- Do not claim Creator/Cloud Desktop/CAD GPU rendering works on this machine
  - it's unverified and the DRI device isn't even present here.

## NEXT ACTION

Compute, Developer, Data, AI, Video are all real and done. Remaining honest
options, in rough order of tractability:
1. Get a real product definition for API Workspace from the user, then build
   it with the same rigor.
2. Test the `linuxserver/blender` containerized-desktop path on a real Linux
   host (not available in this session) to see if Creator Workspace becomes
   genuinely buildable there.
3. Accept CPU-only software rendering as a documented limitation and ship
   Creator Workspace in a clearly labeled degraded mode, if that's an
   acceptable product tradeoff (ask the user - this is a product decision,
   not a purely technical one).
4. Mobile/Security Lab/Gaming/Audio all need infrastructure categories
   (Android emulation, hardened isolation, streaming) that don't exist yet
   and haven't been investigated - do that research before writing any code
   for them, same discipline as this session applied to Creator/Video.

Do not commit without re-running the full three test suites first. Do not
push without explicit authorization.
