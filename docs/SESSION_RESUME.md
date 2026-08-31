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
| Gaming | `STREAMING_VM` - **hard architectural blocker**, confirmed: Sunshine/Moonlight need UDP, this relay is TCP-only (section 3). Would need a new tunneling infrastructure project. |

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

## NEXT ACTION

Compute, Developer, Data, AI, Video, Audio, API, Mobile, Security Lab are all
real and done (9 of 13). Remaining 4, in the user's stated priority order:
1. **Creator, Cloud Desktop, CAD**: blocked by missing `/dev/dri` on this
   Windows/Docker-Desktop/WSL2 host. Needs either a real Linux host to test
   GPU rendering on, or a user decision to accept CPU-only software
   rendering as a documented limitation.
2. **Gaming**: hard architectural blocker - Sunshine/Moonlight need UDP,
   this relay is TCP-only end to end. Needs a new UDP/WebRTC tunneling
   infrastructure project, not a workspace-level task.

Do not commit without re-running the full three test suites first. Do not
push without explicit authorization.
