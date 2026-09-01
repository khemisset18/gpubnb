# Session Resume — read this first if you are a new Claude Code session

**Purpose**: continuity note across sessions on this machine. Read top to
bottom before doing anything else. For a clean, non-session-log reference
on workspace status, see `docs/WORKSPACES_OVERVIEW.md` (13-workspace table,
what's real, what's blocked and why) and
`docs/WORKSPACE_RUNTIME_ARCHITECTURE.md` (how the runtime actually works).
For the machine quarantine/diagnostics system (built 2026-09-01), see
`docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md` — architecture, reason codes,
security, procedures. Section 0 just below summarizes it.
This document's own section 9 has the step-by-step Linux GPU host
validation checklist, and section 10 has the full this-machine feasibility
study.

**Do not push anything until the user explicitly authorizes it each time.**
Everything described in Section 0 below (2026-09-01) is **local commits on
`main` only — nothing pushed to `origin`, nothing deployed**, per explicit
instruction that session. The 2026-08-31 push mentioned further down (old
Section 1) was a separate, earlier, already-consumed authorization — do not
treat it as standing consent for anything after it.

---

## 0. LATEST SESSION — Quarantine & Diagnostics System (2026-09-01)

**Read `docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md` for the full architecture.**
This section is only the continuity summary.

### What was done

Built a complete, real, tested machine-quarantine/diagnostic/repair/
revalidation lifecycle. Before this: 7 real code paths could quarantine a
machine (`Machine.moderationStatus=QUARANTINED`); **zero** code paths could
ever clear one — a quarantine was permanent by construction, the real cause
was never persisted (only a generic label), and `GET /agent/challenge`
blocked a quarantined agent from even sending a fresh heartbeat.

Now: `quarantine-service.ts` (`enterQuarantine`/`clearQuarantine`, the only
functions allowed to write `moderationStatus`, always append an immutable
`MachineQuarantineEvent` row) + `diagnostic-run-service.ts` (real
`DiagnosticRun`s with 9 real PASS/FAIL/WARNING/UNKNOWN/NOT_CHECKED checks,
sourced only from the authenticated agent, never the browser) +
`machine-repair-service.ts` (one safe automated repair: orphaned GPU
allocation bookkeeping cleanup — never a real process, never
`MiningResource.activeRentalId`) + `machine-diagnostics-routes.ts` (all
endpoints: agent-facing works *even while quarantined*, owner-facing gated
by ownership, admin force-clear gated by `INTERNAL_SERVICE_TOKEN` +
mandatory `confirmRisk` for CRITICAL-severity reasons) + a new Host page
(`apps/web/machine-diagnostics.html`/`.js`).

`computeMachineState()` (`machine-state-service.ts`, **pre-existing**) was
confirmed to already be the single MachineReadiness source of truth used by
both publication (`createExactGpuListing`) and reservation
(`allocateBookingResources`) — enriched to surface the real
`quarantineReasonCode` instead of a generic label, not replaced.

A real Machine/Accelerator inconsistency was found and fixed: entering or
clearing quarantine now updates `Accelerator.moderationStatus`/`.status` in
the same transaction as `Machine.moderationStatus` (previously only
`Machine` was updated; `Accelerator` only caught up on the next heartbeat,
which could silently block republication after a real, valid quarantine
clear). Two real race conditions were found and fixed: `createDiagnosticRun`
now takes a `pg_advisory_xact_lock` per machine (was: two concurrent reruns
could create two RUNNING DiagnosticRuns); `completeDiagnosticRun` now does
an atomic conditional claim (`updateMany` guarded on `status='RUNNING'`,
throws `DiagnosticRunConflictError` on loss) so a duplicate/racing result
submission can never apply its outcome twice.

### Tests

**528/528 API tests pass** (503 pre-existing + 25 new across this session's
two passes), **368/368 agent tests pass** (364 pre-existing + 4 new).
New test files: `quarantine-service`/`diagnostic-run-service` coverage is in
`test/diagnostic-run-service.test.ts` (pure, 9 tests incl. the
`ORPHANED_ALLOCATION` mandatory check and the lazy TIMED_OUT computation),
`test/quarantine-diagnostics-system.test.ts` (13 real-Postgres integration
tests: history immutability/REENTERED, clear resolving open events, forced
clear tagged in history, diagnostic PASS→clear, FAIL→maintain with the
right reasonCode, execution-error→maintain, repair never auto-clearing,
publication/booking both blocked while quarantined, the full
QUARANTINED→diagnostic→PASS→CLEAR→publish→FAIL-again→re-quarantine loop
with an Accelerator-consistency assertion, stale-machine lifecycle, the
duplicate-submission conflict guard), `test/machine-diagnostics-routes.
integration.test.ts` (2 real HTTP tests over `app.inject()` with genuine
Ed25519-signed v2 agent requests: cross-machine auth rejection, cross-owner
isolation, a quarantined agent completing a real diagnostic end-to-end,
duplicate-result rejection; force-clear's token/risk-confirmation gates).
6 pre-existing test files were updated (not weakened) to match the new
`enterQuarantine()`-based source shape where they grep literal source text.

### Migrations (local dev DB only, applied and verified)

- `20260901005635_add_quarantine_diagnostics_lifecycle` — `MachineQuarantineEvent`,
  `DiagnosticRun`, 5 new enums, 7 new `Machine` columns. Hand-written (not
  `prisma migrate dev`) to stay strictly additive and avoid an unrelated,
  pre-existing drift on this dev DB (stray `MachineAccelerator`/`OutboxEvent`/
  etc. tables from old local testing, absent from `schema.prisma` already).
- `20260901013945_add_orphaned_allocation_reason_code` — adds the
  `ORPHANED_ALLOCATION` value to `QuarantineReasonCode`.

### Real production machine (`cmsiggruy0004df0tn669f6bn`)

**Not touched.** Still 🔴 quarantined as of the last live check this
session (2026-09-01), last heartbeat unchanged since 2026-08-30T01:14:12.
**Cannot be revalidated with the new system yet** — that requires
`gpubnb.onrender.com`/`gpubnb.netlify.app` to run this code, which requires
a deploy, which requires pushing to `origin`, which was explicitly not
authorized this session ("Ne pousse rien sur origin"). This is the one
genuinely blocked step, not a shortcut taken — see
`docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md` §12.

### Known, documented (not hidden) limitations

- Repair: only orphaned-allocation bookkeeping is automated. Agent
  restart / remote process cleanup would need the "Machine Command Gateway"
  authenticated command channel, which exists in the code but is disabled
  at 0% rollout by an earlier, separate product decision — out of scope to
  build safely in this pass.
- The diagnostic does not verify runtime-level container/network/volume
  cleanup on the agent (only the DB-bookkeeping `allocation` check) — would
  need new agent-side Docker introspection.
- Under genuine simultaneous diagnostic-result submissions, Prisma's
  interactive-transaction pool can occasionally surface a generic timeout
  instead of a clean 409 — data integrity is never at risk (Prisma keeps the
  transaction atomic either way), only the exact HTTP error code in that
  rare race window.

### Useful commands

```bash
# Local Postgres/Redis (already running via docker compose from earlier sessions)
docker ps  # expect gpubnb-postgres-1, gpubnb-redis-1

# API tests (from apps/api)
npx tsc -p tsconfig.json --noEmit          # typecheck
npx tsx --test test/*.test.ts              # full suite (real-DB tests auto-skip if no DB)

# Agent tests (from agent)
python -m pytest tests/ -q

# Clean up test-run leftovers in local dev DB before/after a test run (owner_qd_*,
# owner_a_*/owner_b_*/owner_fc_* wallets are this session's disposable fixtures):
docker exec -i gpubnb-postgres-1 psql -U gpubnb -d gpubnb   # then DELETE ... WHERE wallet LIKE 'owner_qd_%' etc.
```

### Security points not to forget

- `authenticateQuarantinableAgent` (machine-diagnostics-routes.ts) is
  deliberately separate from `authenticateAgent`/`authenticatedAgent`
  elsewhere (workspace-gateway.ts, rental-resource-routes.ts, server.ts) —
  those legitimately still require `moderationStatus=CLEAR` for their own
  routes. Never merge these two helpers.
- `clearQuarantine()` is the only function allowed to write
  `moderationStatus=CLEAR`, anywhere. If a future change needs to clear a
  quarantine, it must call this function (inside its own evidenced logic),
  never write the column directly.
- Force-clear (`/internal/machines/:id/quarantine/force-clear`) must stay
  off the owner-facing route tree. If you ever add an admin UI for it, gate
  it with something stronger than the shared `INTERNAL_SERVICE_TOKEN` (that
  token is fine for a server-to-server/ops-script call, not for a browser
  session) — this was not built because no admin UI/role concept exists yet
  in this codebase.

---

## 1. Git state (OLDER — see Section 0 above for the current state)

`main`, HEAD is the "feat: real quarantine + diagnostic + repair lifecycle
system" commit plus this session's follow-up commit(s) — see `git log
--oneline -10`. Nothing pushed to `origin/main`.

The paragraph below is preserved from an earlier session for history; it
predates Section 0 and no longer reflects the current branch (that branch
was merged to `main` on 2026-08-31, per this file's own note above):

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

This history is superseded — see Section 0.

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

## 4. Other workspaces — architecture prepared, still blocked on hardware

| Workspace | Runtime needed | State |
|---|---|---|
| Cloud Desktop, Creator, CAD, Gaming | `CONTAINER` (Selkies-GStreamer, corrected from the originally-assumed `DESKTOP_VM`/`STREAMING_VM` - see workspace-runtime-profiles.ts) - blocked on this host by missing `/dev/dri` (section 3), not by networking (see section 8's WebSocket-transport correction). All four now have real, built, digest-pinned, live-tested images sharing one common base and one shared agent-side launch profile - see section 8b. Deliberately NOT in `executableWorkspaceSlugs`/`GATEWAY_WORKSPACE_SLUGS` - see section 9 for the validation procedure that must pass before that changes. |

## 5. Test status (re-run as of this session's final "prepare the 4 blocked workspaces" pass)

- `pytest agent/tests` → **356 passed, 2 skipped**, 21 subtests passed, 0
  failed. Includes the new/extended tests for Creator/Cloud
  Desktop/CAD/Gaming's shared launch code (see section 8b). The 2 skips
  are pre-existing and unrelated to this session's changes.
- `npm test` in `apps/api` → **502 passed, 1 failed, 0 skipped** (503
  total). The 1 failure (`GPU_PROOF-only booking (no compatible Developer
  workspace) completes and releases the machine exactly as before`,
  `ResourceAllocationError: resource_conflict` in
  `test/gpu-proof-completion.test.ts`) is the **same accumulated-local-
  fixture-data pattern already documented earlier this session** - this
  session made zero changes to any `apps/api` TypeScript/Prisma source
  file, and re-running that exact test file in isolation
  (`npx tsx --test test/gpu-proof-completion.test.ts`) passes clean, 5/5
  - confirming a leftover row from an earlier full-suite run against this
  same long-lived local dev Postgres container, not a real regression.
  Not reset this time (no fresh explicit user consent requested for a
  third `prisma migrate reset --force` this session, and the API test
  suite compatibility results for the four new workspace slugs - see
  section 8a - already ran and passed within this same run).
- `cargo test --features desktop-runtime` (host-desktop) → not re-run this
  session (nothing in `host-desktop`/Rust changed); last checked 106
  passed, 1 pre-existing failure (see section 6).
- `docker ps -a` / `docker volume ls` checked clean after every live
  container test this session (Cloud Desktop, Creator, CAD, Gaming, the
  preflight script's own throwaway containers) - no orphaned containers
  or volumes left behind.

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
  Security Lab were the first two exceptions: custom GPUbnb images, built
  **locally** on this dev/test host only (`workspaces/mobile/Dockerfile`,
  `workspaces/security-lab/Dockerfile`), each per its own scoped
  authorization from the user (Mobile: "si les outils et dépendances
  nécessaires sont réellement disponibles"; Security Lab: an explicit
  `AskUserQuestion` decision on tool scope before any Dockerfile was
  written). Cloud Desktop/Creator/CAD/Gaming's four images
  (`workspaces/{cloud-desktop,creator,cad,gaming}/Dockerfile`) are the
  same "local-only, never published" status, built per this session's own
  explicit governing instruction (the "OBJECTIF FINAL DE CETTE SESSION"
  message authorizing exactly this preparation work) - **but none of the
  four is wired into a bookable slug list**, unlike Mobile/Security Lab,
  which are. Do not push/publish any image to a registry without a
  separate, explicit go-ahead, and do not build a NEW custom image for
  another workspace without checking whether a scoped authorization
  already covers it, or asking first - Security Lab's authorization in
  particular came with an explicit product-scope decision
  (defensive-analysis-only, no offensive tools, no Burp Suite) that must
  not be silently expanded later.
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
four (see 8a below), all four now have real, built, digest-pinned,
live-tested Selkies-based images sharing one common base and one shared
agent-side launch profile (container/HTTP/Gateway-relay/gamepad/audio all
confirmed, see 8b), and a real Steam feasibility test was performed for
Gaming (see the Gaming section below).
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
  the GPUbnb agent - never installs, modifies, or configures anything on
  the host itself (the one exception is a throwaway `--rm` test
  container, always removed, no image ever kept). Checks, in order:
  platform (real Linux kernel, not WSL2, Docker installed/reachable);
  **1) CUDA compute capability** (NVIDIA driver present, NVIDIA Container
  Toolkit registered, real VRAM via `nvidia-smi`); **2) GPU desktop
  rendering capability** - the one this dev host lacks - real
  `/dev/dri/render*` on the host, a throwaway container's own visibility
  of `/dev/dri` via `--gpus all -e
  NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute`, a real
  OpenGL hardware-acceleration proof (installs `mesa-utils` in a
  throwaway container, runs `glxinfo -B`, and explicitly checks the
  *renderer string* excludes `llvmpipe`/`softpipe`/`swrast` - a
  zero-exit-code-only check would false-positive on a silent CPU
  software-rendering fallback), and a real NVENC hardware-encode check
  (installs `ffmpeg`, runs a real `h264_nvenc` encode - warn-only, since
  Selkies falls back to software encoding per its own docs, so this isn't
  strictly required); resources (RAM/disk, warn-only). The script's own
  header explicitly explains the CUDA-vs-GPU-desktop-rendering
  distinction so an operator understands why a machine can pass one and
  fail the other. **Live-tested end to end on this real host**: correctly
  `FAIL`s the Linux-kernel check (this is a Windows/Git-Bash shell) and
  all three GPU-desktop-rendering checks (no `/dev/dri` anywhere), `OK`s
  Docker/NVIDIA-driver/NVIDIA-Container-Toolkit/VRAM-detection (all
  genuinely present here - real GTX 1650, 4096 MiB) and, notably, `OK`s
  the NVENC check (this card's real hardware encoder does work, even
  though its GL/DRI desktop-rendering path does not - a second live,
  concrete proof that CUDA/NVENC compute capability and GPU-desktop-
  rendering capability are genuinely independent), `WARN`s on free disk
  (below the recommended 40GB on this dev host), overall verdict `NOT
  READY`, exit code 1 - exactly matching this host's real,
  already-established status. Final verdict text (both the ready and
  not-ready paths) explicitly lists what a passing run still would NOT
  prove: the actual Selkies image running correctly with real `--gpus`
  end to end, the exact minimal container-capability set (since
  `--cap-drop=ALL`/`--read-only` are both confirmed not to work as
  shipped), and, for Gaming specifically, real gamepad/audio round-trips
  through a real browser session.

### 8b. What's still not real: the actual desktop runtime

**All four now have real, built, digest-pinned, live-tested images** (this
was "Cloud Desktop only, others not started" as of the previous revision of
this doc - now complete for all four). All four share one base image and
one shared launch profile - the "runtime commun" the user asked for -
rather than four separate implementations:

- **Shared base**: `linuxserver/webtop`, `ubuntu-xfce` tag (glibc-based,
  not the default Alpine tag - Alpine has no Steam package at all,
  confirmed live), digest
  `sha256:1bd141d5d7aaf3e98e47b7d9665f50657d1628617b4ef47bc3bbd43d726fd77e`.
- **`workspaces/cloud-desktop/Dockerfile`** - the bare base image, no
  extra app layered on. Built as `gpubnb-cloud-desktop-workspace:local`,
  real digest `sha256:c3d3cba63692d8bfb1ffd5510328460393c952beb2c649a5990a0807757e713b`.
- **`workspaces/creator/Dockerfile`** - same base + real Blender (official
  Ubuntu `universe` package, GPL). Built as `gpubnb-creator-workspace:local`,
  real digest `sha256:b17566e9a7be21700cd993ae18f356efde55bf8278bb8694c9d0ba70f50bcacf`.
  Live-tested: real HTTP 200, real `blender --version` → "Blender 5.0.1"
  inside the running container, clean stop/cleanup.
- **`workspaces/cad/Dockerfile`** - same base + real FreeCAD. **Not** from
  Ubuntu's own official repo - the base image already has the well-known,
  actively-maintained third-party `xtradeb` PPA configured, which is where
  the installable FreeCAD 1.1.3 candidate comes from - a real, meaningfully
  different trust level versus Blender's/Steam's own official-Ubuntu-repo
  packages, documented, not hidden. Built as `gpubnb-cad-workspace:local`,
  real digest `sha256:f6f4d0c72247cf1252d8f37edf84d136cea7e5bacbcf5b97254d7e51b2908c57`.
  Live-tested: real HTTP 200, real `freecadcmd --version` (the headless
  console binary - the GUI one needs a real display, avoided for this
  smoke test) → "FreeCAD 1.1.3 Revision: 20260725", clean stop/cleanup.
- **`workspaces/gaming/Dockerfile`** - same base + the real, official
  Ubuntu multiverse `steam-installer` package (needs
  `dpkg --add-architecture i386` first). Built as
  `gpubnb-gaming-workspace:local`, real digest
  `sha256:4b2dda2b810447164cdafffe7db9c7cf8d004f9dc64e0f14f32295b3aa2e86b2`.
  Live-tested: real HTTP 200, `/usr/games/steam` present and executable
  inside the running container, clean stop/cleanup. (A separate, earlier
  manual test on the bare base image had already proven the real launcher
  genuinely bootstraps - creates `~/.steam/debian-installation` - inside a
  live running Xvfb display; not re-run against this derived image since
  it changes nothing about that code path.)

All four builds' digests are real, content-addressed, and confirmed live
via `docker inspect --format='{{json .RepoDigests}}'` - not asserted. All
are **local-only, never pushed to any registry** (same status as Mobile's
and Security Lab's images) - only a host that runs the exact `docker
build` can use them.

**Real, live-confirmed, common to all four - the shared "runtime commun"
security finding**: unlike every other workspace image in this codebase,
this image tolerates neither the standard `--read-only` nor
`--cap-drop=ALL` hardening:
- `--read-only` fails because the image self-configures nginx, an SSL
  cert, and copies Selkies' own web assets into several different paths
  at container **startup**, not at build time - confirmed via repeated
  real tests, each adding more tmpfs mounts, still failing with a new
  missing-file/permission error each time.
- `--cap-drop=ALL` fails because s6-overlay's init needs real Linux
  capabilities to remap PUID/PGID at startup - confirmed via real
  `chown: Operation not permitted` and `s6-applyuidgid: fatal: unable to
  set supplementary group list: Operation not permitted` errors.
- **Confirmed working instead** (live-tested cleanly: real HTTP 200, real
  `/config` volume populated with genuine `Desktop`/`ssl` subdirectories,
  clean stop/cleanup): `--security-opt=no-new-privileges --pids-limit
  --memory --cpus --tmpfs=/tmp:rw,exec,nosuid`, a real writable volume at
  `/config` (this image's own persistent-data convention, not
  `/workspace`), `-e PUID=1000 -e PGID=1000`. This is a real, honest,
  **reduced** hardening profile versus the other 9 workspaces - an open
  question, not hidden: either further real-hardware capability-by-
  capability testing could find a true minimal safe set, or a custom
  Dockerfile that pre-bakes the nginx/SSL/web-asset self-configuration at
  **build** time (so the container never needs to chown/write outside
  `/config`/`/tmp` at runtime) could restore the standard hardening -
  neither attempted this session (would be guessing without hardware to
  verify against, and the user's current instruction is to stop inventing
  workarounds for what genuinely needs the missing hardware).
- Real gamepad support confirmed live in every variant's startup logs
  (Selkies initializes 4 persistent "Microsoft X-Box 360 pad" instances).
- Real stop/cleanup confirmed for every container tested (containers and
  any anonymous volumes all gone after `docker rm -f`).
- **Confirmed NOT provable here, for all four**: `/dev/dri` is absent both
  on this host and inside every one of these images' own containers
  (checked live) - there is nothing to test GPU rendering against, and
  nothing here claims it works.

**Shared agent-side launch code** (the "runtime commun" implementation,
not just the shared base image) - real, unit-tested, but **not wired into
any slug-gating list**, so it stays unreachable in production:
- `agent/gpubnb_agent/runtime_images.py`: `DEFAULT_CLOUD_DESKTOP_IMAGE`,
  `DEFAULT_CREATOR_IMAGE`, `DEFAULT_CAD_IMAGE`, `DEFAULT_GAMING_IMAGE` -
  the four real digests above, each with a `workspace_image()` branch.
- `agent/gpubnb_agent/workspace_gateway.py`: `PINNED_CLOUD_DESKTOP_IMAGE`/
  `PINNED_CREATOR_IMAGE`/`PINNED_CAD_IMAGE`/`PINNED_GAMING_IMAGE` regexes
  (same digest-pinning discipline as every other workspace);
  `_workspace_image()` branches for all four; one shared, parameterized
  `_launch_workspace_container()` branch for `workspace_slug in
  ("cloud-desktop", "creator", "cad", "gaming")` using the confirmed
  reduced-hardening profile above, plus
  `--gpus=device=0 -e NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute`
  (legacy fallback path - not compute-only like the other GPU-attached
  workspaces, because Selkies needs the `graphics`/`display` driver
  capabilities for OpenGL/EGL/DRI, not just CUDA compute).
  `GPU_ATTACHED_WORKSPACE_SLUGS` extended to include all four (safe/inert:
  this set is only consulted for slugs already in `GATEWAY_WORKSPACE_SLUGS`,
  which these four are deliberately **not** in).
- `agent/gpubnb_agent/workspace_gateway_v5.py`: a matching branch giving
  these four slugs the exact-leased-GPU-UUID substitution (mirroring the
  existing `ai`/`video` pattern) instead of falling through to Developer's
  generic branch, once/if a rental-resource authority is active for a
  session using one of them.
- **The actual gate that keeps all four non-bookable in production**:
  none of the four slugs is in `GATEWAY_WORKSPACE_SLUGS` (agent) or
  `executableWorkspaceSlugs` (API, `apps/api/src/machine-workspace-catalog.ts`
  - unchanged this session, still exactly the 9 real ones). A session
  claiming one of these four slugs falls back to `"developer"` in
  `_reconcile_sessions()`, the exact same path every other unrecognized
  slug already takes - live-tested (`test_reconcile_does_not_yet_launch_
  any_desktop_workspace_slug` in `test_workspace_gateway.py`).
- New/extended tests, all passing: `test_runtime_images.py` (8 new cases -
  default-digest format + explicit-pin-override for all four slugs),
  `test_workspace_gateway.py` (`DesktopWorkspaceFamilyLaunchTests` - 3
  cases covering all four slugs via `subTest`, proving the shared launch
  args, the reduced hardening profile, the trusted-Developer-image proxy,
  and the reconcile non-bookability gate), `test_workspace_gateway_v5.py`
  (1 new case covering all four slugs' exact-leased-GPU-UUID override).

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

## 9. Linux GPU host validation checklist (follow this, in order, once a real Linux GPU host is available)

None of this has been run - there is no Linux GPU host this session. This
is the concrete, ordered procedure for whoever (human or a future session)
gets one.

1. **Preflight the host itself.**
   `bash scripts/preflight-linux-gpu-desktop.sh`. Must print `PREFLIGHT:
   all real checks passed` and exit 0. If it fails, fix what it reports
   (driver, Container Toolkit, `/dev/dri`, etc.) before continuing - do
   not skip ahead.
2. **Install the GPUbnb agent on that host** the normal way, link it to
   the platform, and confirm the new `desktopGpuRenderingAvailable`
   field actually reaches the API as `true` in its heartbeat/link payload
   (check the `Machine` row, or the machine-detail admin view) - this is
   the same real field `analyzeWorkspace()` already gates on (section 8a).
3. **Build all four images on that host**: `docker build -t
   gpubnb-cloud-desktop-workspace:local workspaces/cloud-desktop/`,
   `.../creator/`, `.../cad/`, `.../gaming/`. Record each real digest
   (`docker inspect --format='{{json .RepoDigests}}'`) - it will differ
   from the ones recorded in section 8b (those are this Windows host's
   own local build; a from-scratch Linux build is a legitimate, expected,
   different digest, same as Mobile's/Security Lab's own precedent).
4. **Run each image manually first, with real `--gpus`**, before touching
   any GPUbnb code path - confirm with your own eyes, in a real browser:
   ```
   docker run -d --security-opt=no-new-privileges --pids-limit=1024 \
     --memory=8g --cpus=4 --tmpfs=/tmp:rw,exec,nosuid,size=1024m \
     -v gpubnb-manual-test:/config -e PUID=1000 -e PGID=1000 \
     --gpus all -e NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute \
     -p 3000:3000 gpubnb-cloud-desktop-workspace:local
   ```
   Open `http://<host>:3000` in a real browser. Confirm: the desktop
   renders, and its own diagnostic (`glxinfo`/Selkies' own logs) shows a
   real NVIDIA GL renderer, not `llvmpipe`/software. This is the one
   thing nothing this session could test.
5. **Confirm real interaction** in that same manual session: keyboard,
   mouse, and (Gaming specifically) a real gamepad all work through the
   browser; audio plays and, if relevant, a microphone round-trips.
6. **Confirm real app-level function** inside that manual session:
   Blender's viewport actually uses GPU rendering (Creator), FreeCAD's
   3D view does too (CAD), Steam can actually log in and launch a
   renter-owned game with playable performance (Gaming).
7. **Only after 4-6 all pass**, wire it into GPUbnb for real: update
   `runtime_images.py`'s four `DEFAULT_*_IMAGE` constants to the new
   Linux-built digests; add `"creator", "cloud-desktop", "cad", "gaming"`
   to `GATEWAY_WORKSPACE_SLUGS` in `workspace_gateway.py`; add the same
   four slugs to `executableWorkspaceSlugs` in
   `apps/api/src/machine-workspace-catalog.ts`. This is the one, single,
   deliberate "flip" this whole session avoided - do it only once 4-6
   are genuinely proven, not before.
8. **Re-run the exact booking→launch→access→stop→cleanup cycle** through
   the real platform (not a manual `docker run`) for at least one full
   session per workspace, exactly like every one of the 9 REAL_WORKING
   workspaces was proven in section 2: real booking, real `GET .../status`
   polling to `READY`, real `POST .../access` opening a real browser
   session through the real Gateway relay, real interactive use, real
   stop, and a real `docker ps -a`/`docker volume ls`/`docker network ls`
   check confirming full cleanup - the same rigor bar as every other
   entry in `executableWorkspaceSlugs`, no exceptions.
9. **Update the manifests' `release` field** (currently `UPCOMING` for
   Creator/Cloud Desktop/CAD, `EXPERIMENTAL` for Gaming, in
   `apps/api/src/workspace-manifests.ts`) once genuinely validated, and
   update this document's section 2/8 to move these four out of "blocked"
   and into the real-workspaces list, following the exact structure
   already used for the 9 above.
10. **For Gaming specifically, decide the content/policy question** this
    session deliberately left open (which games/content are acceptable
    to install in a rented session) before enabling bookings - not an
    unstated default (see the Gaming subsection above).

## 10. This-machine GPU-desktop feasibility study (real, empirical, negative result)

A later session asked, before accepting "need another Linux machine" as
final: can *this* Windows 11 Home / WSL2 / Docker Desktop machine itself be
turned into a real Linux GPU desktop host? Real investigation was done -
no `/dev/dri` was fabricated, no software rendering was presented as real
GPU rendering. **Conclusion: no, not with this exact OS/driver/hardware
combination as it stands today - real, reproducible, kernel-level evidence
below, not a guess.**

**What was audited (all real, live commands on this exact host):**
- OS: Windows 11 **Home** ("Famille"), build 10.0.26200.9168. Home edition
  has **no Hyper-V** at all (`Get-WindowsOptionalFeature -FeatureName
  Microsoft-Hyper-V-All` returns nothing - the feature doesn't exist on
  this SKU, confirmed live) - only `VirtualMachinePlatform` (WSL2's own
  lightweight hypervisor subset) is present.
- GPU: real NVIDIA GeForce GTX 1650, 4096 MiB, driver 592.82 (WDDM),
  CUDA 13.1 - confirmed via `nvidia-smi` on the Windows host, inside
  native WSL2 Ubuntu, and inside a `--gpus` Docker container - all three
  see the real card. A secondary Intel UHD Graphics iGPU also exists
  (`Get-CimInstance Win32_VideoController`).
- WSL2: version 2.7.12.0, kernel `6.18.33.2-microsoft-standard-WSL2`,
  WSLg 1.0.73.2, Direct3D 1.611.1, DXCore 10.0.26100.1.
- `/dev/dxg` (DXCore compute device): present in native WSL2 Ubuntu, in
  Docker Desktop containers via `--gpus`, real, working (this is exactly
  what already makes AI/Video/Developer/Mobile's CUDA passthrough real).
- `/dev/dri` (DRM render node, what OpenGL/Vulkan/EGL/GBM/Selkies need):
  **absent everywhere tested** - native WSL2 Ubuntu, Docker Desktop
  containers, and `/sys/class/drm/` itself is **empty** (only a generic
  `version` file, no `card0`/`renderD128` registered anywhere in the
  kernel's own DRM subsystem) - this is a kernel-level fact, not a
  missing device file/udev-rule/permissions issue that a config change
  could fix.
- `dmesg` shows *why*: `dxgkrnl` (the real Microsoft driver that creates
  `/dev/dxg`) loads and registers as a **misc device**, not a DRM device
  - and its own adapter-info queries genuinely fail live
  (`dxgkio_query_adapter_info: Ioctl failed: -22`, dozens of real
  occurrences, reproduced on demand by the tests below) - plus a real
  kernel warning/bug trace (`memcpy: detected field-spanning write`,
  `dxgvmb_send_wait_sync_object_gpu`) when something tries to use it more
  deeply. This is a genuine incompatibility/bug in this exact WSL2
  kernel build's `dxgkrnl`, not something this session could patch.
- **Mesa's real D3D12 Gallium driver** (`d3d12_dri.so`, Ubuntu's own
  official `mesa-utils`/`libgl1-mesa-dri` package, genuinely installed
  and present - not fabricated) is the one real, supported Linux OpenGL
  path for WSL2's GPU-PV mechanism. Tested live: `eglinfo`'s GBM/Wayland/
  X11 EGL platforms all fail (`eglInitialize failed`); forcing
  `GALLIUM_DRIVER=d3d12` explicitly fails with `failed to create dri2
  screen` - because this driver's DRI2/GBM winsys requires exactly the
  `/dev/dri` this system doesn't have. The **only** EGL platform that
  succeeds is `Surfaceless`, and its own self-reported `EGL driver name`
  is `swrast` - Mesa's **CPU software rasterizer** - explicitly not
  claimed as GPU rendering here, exactly the trap the user asked not to
  fall into.
- **NVIDIA's own separate, proprietary WSL2 OpenGL/Vulkan path**
  (`libEGL_nvidia.so`/`libGLX_nvidia.so`/`libvulkan_nvidia.so`/
  `nvidia_icd.json` - a real, different, non-Mesa mechanism NVIDIA has
  documented for some WSL2 driver channels) was also checked for:
  **none of these files exist anywhere on this host's WSL driver
  store** - this driver build only ships the compute-oriented libraries
  (`libcuda`, `libnvidia-ml`, `libnvidia-encode`, `libnvidia-gpucomp`,
  `libnvwgf2umx`, `libnvdxdlkernels`), not the graphics ICDs.
- **Docker Desktop containers get an even narrower view than native
  WSL2**: `nvidia-container-toolkit` only bind-mounts the CUDA-compute
  library subset (`libcuda`, `libnvidia-ml`, `ptxjitcompiler`,
  `libnvdxgdmal`, `nvidia-smi`) via its 9p driver-store mount, even with
  `NVIDIA_DRIVER_CAPABILITIES=all` - confirming the actual GPUbnb product
  path (Docker containers) is blocked at least as hard as raw WSL2.
- **Hyper-V/VMware/VirtualBox DDA-style full GPU passthrough to a real
  Linux VM**: analyzed, not empirically attempted (would require
  disabling the host's only discrete GPU access and, on Windows Home,
  installing a feature that doesn't exist on this SKU at all - both
  disruptive and against this session's explicit non-destructive/no-
  unnecessary-Windows-changes instruction). Real, externally documented,
  independently-verifiable reasons this would not have helped anyway:
  Windows 11 Home has no Hyper-V (confirmed above, so Hyper-V DDA is not
  even installable here without upgrading the Windows edition), and
  NVIDIA's consumer GeForce driver is well known to detect and disable
  itself in most passthrough/virtualized configurations ("Code 43"), a
  restriction that applies to third-party hypervisors on this same
  hardware too, not just Hyper-V.

**Verdict**: this exact machine's current OS build + WSL2/WSLg version +
NVIDIA driver 592.82 combination provides real, working GPU **compute**
passthrough (`/dev/dxg`, already proven for AI/Video/Developer/Mobile) but
**no real path to `/dev/dri`/GPU-accelerated OpenGL/Vulkan/EGL** for either
native WSL2 or Docker containers - confirmed at the kernel level
(`/sys/class/drm` empty), not just "not configured yet." Nothing here rules
out that a **different** NVIDIA driver release, a future WSL2/WSLg update
that fixes `dxgkrnl`'s DRM registration, or a Windows edition change
(Home → Pro, enabling real Hyper-V DDA) could change this later - but as
of this audit, on this machine, right now, it does not work, and section 9
(a real Linux GPU host) remains the only proven path to validate Creator/
Cloud Desktop/CAD/Gaming. No `/dev/dri` was fabricated, no software
rendering was presented as GPU rendering, and none of Creator/Cloud
Desktop/CAD/Gaming's compatibility gating or bookability was touched by
this investigation - it was read-only/diagnostic (temporary `apt-get
install` of standard Mesa diagnostic packages inside a throwaway `--rm`-
adjacent Docker container, cleaned up after; no persistent change to
Windows, WSL2, or any of the 9 REAL_WORKING workspaces).

## 11. Real PC A -> PC B distributed test — live-executed, 2 real P0 bugs found and fixed, 1 real unresolved finding

A later session executed the actual distributed test from section 9's spirit, but
scoped down per explicit instruction: PC A = everything (API/DB/Redis/Docker/agent/
GPU), PC B = browser only, both roles played on this one physical machine (no
second machine available) - PC A's own LAN IP (`https://<lan-ip>:8443` via a local
Caddy reverse proxy, `tls internal` self-signed cert) was used as the "PC B" origin,
via this session's own browser automation tooling. This is **not** equivalent to a
literal second physical machine (no second NIC/OS/browser-cert-trust-store
involved), but it is a real network round trip through a real reverse proxy to a
real backend, and it is the strongest verification available without a second PC.
Developer Workspace only (not Data - see below), matching the "start with the
simplest REAL_WORKING workspace" instruction.

### Real preconditions verified live, not assumed

- **`assertTrustedOrigin` would have silently 403'd every mutating request from a
  real PC B browser** (`apps/api/src/security.ts`): compares the browser's `Origin`
  header against `config.PUBLIC_APP_DOMAIN`, which defaulted to `localhost`. Fixed
  by setting `PUBLIC_APP_DOMAIN` to the real LAN IP in `.env` (not a code change -
  this is exactly what the env var is for).
- **The Gateway's access-grant cookie is `secure:true` unconditionally**
  (`workspace-gateway.ts:194`, not gated by `NODE_ENV`) - real HTTPS is not
  optional for this flow on any environment. Confirmed live: the cookie is
  genuinely set and automatically resent by the browser across a fresh tab (not
  just visible in `document.cookie`, since it's also `httpOnly`).
- **Supabase's free-tier email rate limit is hit almost immediately** (`429
  over_email_send_rate_limit`) - unusable for repeated test signups. Switched to
  the Phantom wallet nonce/signature flow (`/auth/nonce` + `/auth/verify`,
  Ed25519 via the browser's native `crypto.subtle.generateKey({name:'Ed25519'})`,
  no extension needed for a scripted test), which doesn't touch Supabase at all
  and is the same auth path this project's own E2E harnesses already use.
- Real machine capabilities measured, not assumed: this exact dev machine has
  **12064 MiB RAM total - below Data Workspace's 16384 MiB minimum**, confirmed via
  `GET /listings/:id/workspaces` returning only `compute` as a pre-booking choice
  (a deliberate product design, not a bug - Developer/Data/etc. are post-booking
  add-ons via `POST /bookings/:id/workspace/:slug`, not pre-booking choices - see
  `machine-workspace-catalog.ts`'s own comment) and via `ensureCompatibleMachineWorkspace`
  returning `data_workspace_incompatible` for a real attempt. Developer (8192 MiB
  minimum) is genuinely compatible on this machine and was used for the rest of
  the test.

### 2 real P0 bugs found live and fixed (see git log for full detail)

1. **`agent/gpubnb_agent/cli.py`** - `run_next_job()` resolved a `GPU_DIAGNOSTIC`
   job's image via `workspace_image(config, "compute")` instead of the server's
   real `parameters.diagnosticImage`, since this job type never carries a
   `workspaceSlug`. Reproduced live: real booking -> real job -> real failure ->
   real `DEGRADED` booking, before the fix; real `COMPLETED` booking and a real
   passing `GPU_DIAGNOSTIC` run against the real GTX 1650, after. New test
   `test_gpu_diagnostic_job_flow.py`.
2. **`apps/api/src/server.ts`** - `app.listen({host:'0.0.0.0'})` was hardcoded,
   so the raw API was directly reachable on the LAN, bypassing Caddy entirely
   (confirmed live via `curl` before/after). New `API_BIND_HOST` env var
   (default unchanged - `0.0.0.0` - since production runs the API inside a
   container, where Docker's own port publishing requires it).

### Full chain proven live, real evidence

Real booking (Phantom-authenticated renter) -> real `POST /bookings/:id/workspace/developer`
-> real `WORKSPACE_PREPARE` job picked up by a real, isolated test agent (own
`GPUBNB_CONFIG_DIR`, never touched the real production `gpubnb-agent` Windows
service also running on this machine) -> real `gpubnb-dev-*`/`gpubnb-dev-proxy-*`
containers launched and healthy on PC A -> real Gateway registration, `canOpen:true`
-> real access grant (`POST /bookings/:id/workspace/access`) -> real navigation to
`/workspace-gateway/:sessionId/?folder=/workspace` -> **the real code-server VS Code
workbench genuinely rendered in the browser** (screenshot evidence: file explorer,
Welcome tab, Restricted Mode banner - not a mock, not a static page). Confirmed via
the agent's own trace log (`workspace_trace:ws_open_received` ->
`ws_local_connected` -> `ws_open_ack`) that the WSS frames genuinely traversed
Caddy -> Fastify's WS Gateway -> Redis queue -> the agent's poll-relay -> the
real local WebSocket to the proxy container.

**Isolation confirmed live**: an unauthenticated request, a request with a fake
grant token, and a request from a completely different, real, freshly-authenticated
third identity were all rejected with `401` against the live session's Gateway
path - not by code inspection, by three real HTTP requests against the real
running server.

**Agent-crash recovery confirmed live, with a real session active**: `taskkill /F`
on the isolated test agent's real OS process while the Developer session was
live -> confirmed the real containers kept running unmanaged -> restarted the
agent -> confirmed same container IDs (no duplicate), heartbeat resumed, machine
stayed `ONLINE`. This is the same proof pattern as `e2e/recovery-agent-restart.sh`,
now additionally exercised against this session's own isolated Developer session
rather than only the original E2E harness's own scenario.

**Stop/cleanup confirmed live**: real `POST /workspace-sessions/:id/stop` ->
real container + proxy removal (confirmed via a live wait loop, not a single
check) -> real volume and network removal -> real GPU memory at 0 MiB
(`nvidia-smi`). Stopping the *workspace* is intentionally not the same as ending
the *rental* (the renter paid for the whole booking window) - confirmed by
reading `POST /bookings/:id/cancel`'s own scope (`AWAITING_DEPOSIT` only - no
early-termination route exists for an `ACTIVE` booking, on purpose).

**A real, deeper gap found while waiting for the booking's natural `endsAt` to
prove the full "machine becomes available again" cycle**: an `ACTIVE` booking
that had a Developer Workspace requested on it has **no automatic completion
path at all** in this dev-bypass test configuration, even well past its own
`endsAt` (confirmed live: an 8-minute wait past expiry, booking still `ACTIVE`).
Traced precisely: `reconcileDevBypassSettlements`'s candidate query
(`findDevBypassSettlementCandidates`) only ever matches `COMPLETED` or
`DEGRADED` bookings, never `ACTIVE`; the *other* path that could reach
`COMPLETED` (`reconcileDevelopmentBookings`'s `finishedJobs` handling, tied to
GPU_DIAGNOSTIC success) explicitly excludes any booking with a Developer
session (`workspaceSessions:{none:DEVELOPER_SESSION_FILTER}`); and the *newer*
verified-stop finalization path (`finalizeVerifiedDeveloperStop`, which does
correctly set `Machine.operational` back to `AVAILABLE`) is only reachable
through the "Machine Command Gateway" (`stop_rental` command), which is gated
behind `MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS` - **0% by default**, confirmed via
the delivery worker's own health log on every tick
(`"machineCommandGatewayRolloutBps":0`). The legacy stop path this session
exercised (`POST /workspace-sessions/:id/stop` -> agent reconcile -> real
`POST /agent/workspace-gateway/:sessionId/stopped`) correctly cleans up every
Docker resource and does flip `Machine.operational` back to `AVAILABLE` *at
that moment* - but only when no other booking on the same listing is sitting in
`FUNDED`/`STARTING`/`ACTIVE`/`DEGRADED`. This session's own earlier `DEGRADED`
test bookings (from before the GPU_DIAGNOSTIC fix) were exactly such a blocker,
which is genuinely correct, careful, intentional behavior, not a bug - but it
meant the real completion cycle could only be proven after also discovering and
fixing a **second** real, separate gap: `BETA_TEST_DEV_BYPASS` (a different flag
from `DEV_PAYMENT_BYPASS`, gating `reconcileDevBypassSettlements` specifically)
had never been set in this session's `.env` - once set, the two stale `DEGRADED`
bookings genuinely, correctly settled to `REFUNDED` via the real mechanism.

**Full cycle conclusively, empirically proven after both fixes**: `Machine.operational`
flipped to real `AVAILABLE`; `MiningResource.activeRentalId` for the real GPU
confirmed `NULL` (the actual DB-level exclusivity gate a new allocation checks -
`accelerator.miningResource?.activeRentalId` in `resource-allocation-service.ts`,
not the `AcceleratorAllocation.status` column); and a genuinely **new** booking
on the same listing was created successfully (`200`, not `409
resource_allocation_failed`). One minor, honestly-reported loose end: the
original session's own `AcceleratorAllocation` row was left sitting at
`ACTIVE` forever - practically harmless (it's superseded, the real exclusivity
gate is genuinely clear, Docker resources are genuinely gone), but a real,
permanent bookkeeping inconsistency, not something that self-heals. Explicit
product decision needed to close it for real (not attempted unilaterally this
session - a real product/architecture decision, not a quick patch): either wire
the legacy stop-callback (or a new dev-bypass-aware reconciler) to also
complete/settle an `ACTIVE` booking's own accelerator allocation once its
Developer Workspace has fully stopped and `endsAt` has passed, or turn on
`MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS` for a real deployment so the newer, more
complete `finalizeVerifiedDeveloperStop` path handles it end to end.

**One further real finding while verifying the fix, worth its own note**:
`reconcileDevelopmentBookings`'s `readyBookings` query - the one that dispatches
the GPU_DIAGNOSTIC job that gets a booking from `FUNDED` moving at all - is
short-circuited to `[]` whenever `betaTestDevBypassActive()` is true
(`const readyBookings = betaTestDevBypassActive() ? [] : await db.booking.findMany(...)`).
This means **`BETA_TEST_DEV_BYPASS=true` and a smoothly-progressing fresh
booking are mutually exclusive with the current implementation**: a booking
created after enabling it gets `FUNDED` and then never receives a
GPU_DIAGNOSTIC job, so it can never reach `STARTING`/`COMPLETED` either - a
real catch-22, confirmed live (a fresh booking created to double-check the fix
sat at `FUNDED` with zero jobs for the full observation window). This did not
affect this session's own main proof (that booking was created and completed
*before* `BETA_TEST_DEV_BYPASS` was set), but it means the two dev-bypass flags
cannot both be relied on simultaneously for a smooth test run today - another
real, precise, documented gap for a future session to close (likely:
`readyBookings` should still run under `BETA_TEST_DEV_BYPASS`, or
`reconcileDevBypassSettlements` needs its own `FUNDED`/`STARTING` candidate
path instead of only `COMPLETED`/`DEGRADED`).

### Real, unresolved finding - not a GPUbnb bug, documented honestly

**code-server's own "Management" WebSocket channel takes a consistent, exact
~5000ms before sending its first frame after the local connection opens** -
confirmed via `workspace_trace` log timestamps across 8+ separate connection
attempts (4959-5009ms every time, suspiciously exact, not organic network
jitter). **Proven independent of GPUbnb's relay**: connecting directly to the
proxy container's published port with a raw Python `websocket-client`,
completely bypassing the agent/API/Caddy relay, reproduces the identical
~5003ms delay. **Ruled out**: `--disable-update-check --disable-telemetry`
(code-server's own flags for its network-dependent startup checks) on a fresh
throwaway container - delay unchanged (~5009ms). **Ruled out**: relay latency
itself, measured directly - `ApiClient.request()` against the live LAN Caddy
endpoint averages ~33ms/call (10-call sample), nowhere near enough to explain a
multi-second budget problem.

This ~5s server-side delay eats into code-server's own client-side handshake
timeout budget, so a first connection sometimes succeeds within a few retries
(observed) and sometimes needs several reload cycles (also observed) - genuinely
intermittent, not a hard failure, and not something this session found a fix
for within GPUbnb's own code. Root cause is inside code-server's own server-side
"Management" channel initialization, not investigated further (would require
either patching or deeply reverse-engineering third-party minified JS). Real,
live, reproducible, and left honestly unresolved rather than papered over -
worth revisiting if it matters for real renter usability (an initial connection
did fully succeed and render a real, usable VS Code workbench, so this is a
reliability/UX rough edge, not a hard blocker for the workspace being
functionally real).

### A minor, real, self-inflicted DB inconsistency (not a fresh product bug)

Directly `UPDATE`ing `AcceleratorAllocation.status='RELEASED'` via raw SQL
(to unstick GPU locks held by earlier failed test bookings, before the
GPU_DIAGNOSTIC fix existed) put the DB into a state
`dev-booking-reconciler.ts`'s own Prisma query didn't handle gracefully,
producing one real `gpu_booking_reconcile_failed` error (confirmed via the
delivery worker's log, occurred exactly once, did not recur). Documented as a
test-session artifact from manual intervention, not a fresh finding about the
reconciler's own correctness under its normal, non-manually-touched state
transitions - the untouched, real booking used for the rest of this test
completed and settled without incident.

## NEXT ACTION

Compute, Developer, Data, AI, Video, Audio, API, Mobile, Security Lab remain
the 9 real, done, REAL_WORKING workspaces (unchanged this session - see
section 2). Creator, Cloud Desktop, CAD, Gaming remain the 4 blocked
workspaces - **still correctly, honestly NOT REAL_WORKING and NOT bookable**
(not in `GATEWAY_WORKSPACE_SLUGS` or `executableWorkspaceSlugs`) - but this
session finished preparing their shared "runtime commun" architecture end to
end (see section 8b): all four images are now real, built, digest-pinned,
and live-tested (container start, real app binary/version, HTTP 200 through
the real `loopback-proxy.js` relay, gamepad/audio subsystems present, clean
stop/cleanup); the shared agent-side launch code (image selection, the
reduced-hardening launch profile, the exact-leased-GPU-UUID override) is
written, unit-tested, and deliberately left unreachable in production; the
preflight script now also proves OpenGL hardware-acceleration and NVENC,
live-tested end to end on this host. The one thing genuinely still not built
or provable for any of the four: real GPU-accelerated rendering itself - no
Linux GPU host is available this session. **This session's own explicit
instruction going forward: stop here.** Do not invent further workarounds
for the missing hardware. The next concrete step is section 9's checklist,
run on a real Linux GPU host, by whoever has access to one next.

Do not commit without re-running the full three test suites first. Do not
push without explicit authorization.
