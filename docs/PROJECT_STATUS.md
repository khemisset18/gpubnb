# GPUbnb — Project Status

_Last updated: 2026-08-30, end of the "Real E2E + Recovery validation" mission, branch `main`._

## Current State

The GPUbnb Host Workspace workflow (booking → GPU assigned → Docker container → code-server → gateway → renter opens the workspace → cleanup → GPU released) has been fully proven end-to-end on a real single GTX 1650, **as one unattended, unbroken script run** (`e2e/run.sh`), twice in a row — no manual steps, nothing mocked. A real agent-crash recovery scenario has also been proven end-to-end (`e2e/recovery-agent-restart.sh`): the agent process was actually killed mid-session, and the system recovered without double-booking the GPU. The 4 commits from the previous "Workspace-gateway hardening" mission (`99cb920`, `c84908c`, `d7de304`, `a2c5e48`) are merged into `main` via PR #133 (merge commit `eedee14a09aa9809b3dacf1a9068490c82e412e7`). This mission's own changes (harness fixes, two further product fixes discovered while getting `run.sh` to actually complete unattended, and a new recovery-scenario script) are **not yet committed** as of this writing — see **Git / Branch**.

## Mission Completed

**Previous mission ("Workspace-gateway hardening", now merged into `main` via PR #133):**
- Audited the Workspace/Docker/Gateway/Agent chain for a single-GPU host.
- Fixed the GPU-quarantine-on-transient-condition bug and the premature-READY bug (see **Bugs Fixed** #1 and #2).
- Added real HTTP/DB-level regression tests for both, removed "GPU Proof"/"bêta" wording from the renter UI, built the original `e2e/` harness, and fixed a CI-only env-fallback gap.

**This mission ("Real E2E + Recovery validation"):** the actual objective was to run `e2e/run.sh` as **one unattended script**, not step-by-step — this had never been done before (the previous mission's harness was proven manually, one step at a time, due to a sandbox constraint). Doing so surfaced and fixed **7 real, previously-invisible bugs** spanning the agent CLI, the GPU quiescence check, and the harness itself:
- Fixed a real agent-CLI bug (`command_start --daemon`'s 5-second self-confirmation deadline was too tight under ordinary system load, causing agent startup to fail intermittently and deterministically block the whole lifecycle).
- Fixed a real, significant agent-CLI/quiescence bug: on Windows, `nvidia-smi --query-compute-apps` reports the OS's own desktop compositor (`dwm.exe`, `explorer.exe`, shell-experience helpers) as "compute apps" at all times, making GPU quiescence **structurally unprovable** on any normal Windows desktop host — not an edge case, a near-universal one for Windows hosts with a display attached. Fixed with a narrow, security-conscious exclusion (see **Bugs Fixed** #5).
- Fixed 5 further bugs in `e2e/run.sh`/`e2e/run.cjs` itself (process-tree kill on Windows, `setup`'s expected non-zero exit code, a machine-publishability shortcut that forgot to reset `operational`, a WebSocket URL/auth flow that didn't match what a real browser actually does, and a cleanup check that read the session's terminal status before the agent had asynchronously set it).
- Proved the complete lifecycle end-to-end via `./e2e/run.sh` alone, twice in a row, with zero manual intervention.
- Built and proved a new, real recovery scenario (`e2e/recovery-agent-restart.sh`): killed the real agent process mid-session, confirmed the container survives unmanaged, restarted the agent, confirmed heartbeats resume and reconciliation does not double-book the GPU (exactly one live allocation, exactly one runtime+proxy container pair), then completed a normal stop/cleanup and a second rental.
- Re-ran the full API/agent/frontend/typecheck/build regression suite after all product-code changes — no regressions.

## Bugs Fixed

### 1. GPU quarantined permanently on a transient busy-GPU condition

- **Problem**: When the agent tried to preempt a GPU for a new rental and the GPU wasn't yet quiescent (another local program was using it), the machine was quarantined permanently, requiring manual administrative intervention even though the condition was temporary and self-resolving.
- **Cause**: `RentalPreemptionSupervisor.preempt_for_rental()` in `agent/gpubnb_agent/gpu_rental_preemption.py` treated every `ExecutionControlError` raised by the quiescence probe as fatal and called `self._quarantine(...)` unconditionally, without distinguishing a transient busy-GPU condition from a genuinely unrecoverable one (e.g. a miner-identity mismatch).
- **Correction**: Introduced `TRANSIENT_QUIESCENCE_REASONS` (`rental_gpu_compute_processes_present`, `rental_gpu_utilization_not_quiescent`, `rental_gpu_memory_not_quiescent`). When the raised error matches one of these, the supervisor re-raises (triggering an automatic retry on the next reconciliation cycle) instead of quarantining. Any other reason (e.g. identity mismatch) still quarantines as before. Added a human-readable explanation in `agent/gpubnb_agent/cli.py`'s `_GATEWAY_ERROR_EXPLANATIONS`.
- **Files**: `agent/gpubnb_agent/gpu_rental_preemption.py`, `agent/gpubnb_agent/cli.py`, `agent/tests/test_gpu_rental_preemption.py`.
- **Validation**: Unit tests updated/added (`test_transient_quiescence_failure_blocks_only_target_resource_without_quarantine`, `test_transient_quiescence_failure_self_heals_on_next_retry`, `test_miner_identity_mismatch_still_quarantines_despite_transient_fix` as a regression guard on the non-transient path). **Also reproduced live**: the real gateway reconciliation loop hit `rental_gpu_compute_processes_present` because Epic Games Launcher (the actual original real-world trigger) held a GPU compute context, logged the new human-readable message, retried automatically, and succeeded once the GPU became quiescent — see `e2e/RESULTS.md`.

### 2. Renter-facing "READY" reported before the workspace was actually openable

- **Problem**: A Developer `WorkspaceSession` could show `status: READY` — and the renter-facing phase literally said `"READY"` — while `connectionMetadata` was still `null`, i.e. before the agent's real gateway registration had happened. Clicking "Ouvrir" at that point failed with `409 workspace_gateway_not_ready`, with no explanation to the renter.
- **Cause**: `POST /agent/jobs/:id/complete` (in `apps/api/src/server.ts`) sets the `WorkspaceSession` to `READY` as soon as the container/runtime finishes preparing, with no knowledge of whether `POST /agent/workspace-gateway/:sessionId/register` (in `apps/api/src/workspace-gateway.ts`) has run yet — the only place that actually populates `connectionMetadata`. `preparationPhase()` in `apps/api/src/workspace-renter-routes.ts` didn't account for this gap and echoed the raw `READY` status straight through.
- **Correction**: `preparationPhase()` now takes an explicit `connectionReady: boolean` parameter and returns a new phase, `GATEWAY_NOT_READY`, whenever `status === READY && !connectionReady`. `safeConnection()` and `preparationPhase()` are now exported so they can be tested directly. The renter UI (`apps/web/workspace-developer-flow.js`) maps `GATEWAY_NOT_READY` to "Connexion de l'espace de travail…" instead of implying the workspace is ready.
- **Files**: `apps/api/src/workspace-renter-routes.ts`, `apps/web/workspace-developer-flow.js`, `apps/web/workspace-bookings.js`.
- **Validation**: `apps/api/test/workspace-developer-phase.test.ts` (unit-level phase logic) and `apps/api/test/workspace-gateway-register-e2e.test.ts` (full HTTP-level regression: real Fastify app, real signed agent `/register` call, asserts `canOpen`/`blockedReason`/`phase` before and after registration, plus register-idempotence). **Also reproduced live**: at the exact original bug moment, `GET /bookings/:id/workspace` correctly returned `canOpen: false, blockedReason: "GATEWAY_NOT_READY"` instead of the misleading bare `"READY"` — see `e2e/RESULTS.md`.

### 3. (CI-only, found after push) New tests crashed in CI on a missing env var

- **Problem**: Right after pushing bug fixes #1 and #2, the pushed commit's CI run failed: `apps/api/test/workspace-developer-phase.test.ts` and `apps/api/test/workspace-gateway-register-e2e.test.ts` both crashed at module load with `PLATFORM_WALLET: Required` (a zod validation error from `apps/api/src/config.ts`).
- **Cause**: Both files used **static** imports of `../src/workspace-renter-routes.js` (which transitively imports `config.ts`). Static ES-module imports are hoisted before any other top-level statement, so the repo-wide convention of setting `process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111'` before importing (already used by `gpu-proof-completion.test.ts` and 5 other files) never had a chance to run before `config.ts` validated the environment. Locally this was masked because `tsx` auto-loads `apps/api/.env` (gitignored, contains a real value), which does not exist in CI.
- **Correction**: Converted the relevant imports in both new files to dynamic `await import(...)`, evaluated after the same `process.env.X ??= ...` fallback block already used elsewhere in the repo. No product code was touched.
- **Files**: `apps/api/test/workspace-developer-phase.test.ts`, `apps/api/test/workspace-gateway-register-e2e.test.ts`.
- **Validation**: Re-ran both files locally with `apps/api/.env`/`apps/api/.env.supabase.local` deliberately renamed aside (to exactly reproduce a CI checkout with no local env file) against a real disposable Postgres/Redis — 6/6 passed. Pushed as commit `d7de304`; GitHub Actions run `33287208009` came back **green on all 6 jobs** (`api`, `agent`, `security-static-analysis`, `production-gates`, `contract`, `dependency-audit`).

### 4. Agent daemon start failed intermittently under ordinary system load

- **Problem**: Trying to run `e2e/run.sh` as one unattended script (this mission's actual objective) reproducibly failed at `gpubnb-agent start --daemon` with "Le démarrage de l'agent n'a pas pu être confirmé" — even though the daemon process itself started up fine (proven by re-running the exact same command by hand seconds later, which succeeded).
- **Cause**: `command_start`'s daemon-confirmation loop (`agent/gpubnb_agent/cli.py`) had a hardcoded 5-second deadline. On Windows, each poll iteration verifies the spawned child's identity via a real `Get-CimInstance` PowerShell subprocess, individually measured at ~0.3-1.5s depending on system load — and the child itself must finish loading config/key, resolving its workspace image, and starting its background threads before it even writes the pid record the parent is polling for. Right after the harness's own Docker/build activity, 5 seconds wasn't reliably enough.
- **Correction**: Extracted the deadline into `DAEMON_START_CONFIRM_TIMEOUT_SECONDS = 20`, giving realistic margin. A genuinely hung/crashed child still fails fast via the existing `process.poll() is not None` check, unaffected by this change.
- **Files**: `agent/gpubnb_agent/cli.py`, `agent/tests/test_process_lifecycle.py`.
- **Validation**: New test `test_daemon_start_tolerates_a_slow_but_real_confirmation` — simulates 8 slow (1s each) confirmation polls before matching; verified this test genuinely fails against the old 5s value (reproducing the exact real error message) and passes at 20s. Also confirmed live: `e2e/run.sh` no longer fails at this step.

### 5. GPU quiescence unprovable on a normal Windows desktop (false-positive "busy GPU")

- **Problem**: With bug #4 fixed, `e2e/run.sh` still failed further along, stuck oscillating between `HEARTBEAT_STALE` and `GATEWAY_NOT_READY` for the workspace's entire gateway-registration wait window. The agent's own log showed the real cause: `rental_gpu_compute_processes_present` — the exact transient-quiescence code path from the *previous* mission's bug fix #1, retrying exactly as designed, but never actually clearing.
- **Cause**: Investigated with `nvidia-smi --query-compute-apps` directly against the real GPU: **8 consecutive samples, 2 seconds apart, all identical** — `explorer.exe`, `dwm.exe`, and `TextInputHost.exe` (Windows's own desktop compositor and shell) permanently present. On Windows (WDDM), `nvidia-smi --query-compute-apps` reports every process holding a GPU context, including the OS's own always-on desktop compositor - not just genuine foreign compute workloads. `gpu_rental_preemption.py`'s quiescence probe treated *any* non-empty PID list as "another program is using the GPU," which is **never actually empty** on an ordinary Windows desktop with a display attached - a near-universal condition for Windows hosts, not a niche one.
- **Correction**: Added `process_name` to the existing `--query-compute-apps` query (zero extra subprocess cost — nvidia-smi already had to do the work, this just requests one more CSV column) and a new `_is_windows_desktop_compositor_path()` check: on Windows only, a PID is excluded from the "foreign process" set if NVML reports it running from inside `%SystemRoot%` itself. A real foreign workload (game, miner, benchmark) runs from Program Files / a user profile / elsewhere and is still correctly treated as blocking; an attacker cannot relocate a hidden workload into the Windows installation directory without a level of system compromise this check was never designed to defend against. Does not change behavior on Linux, where compute-apps reporting doesn't include the compositor.
- **Files**: `agent/gpubnb_agent/gpu_rental_preemption.py`, `agent/tests/test_gpu_rental_preemption.py`.
- **Validation**: 3 new tests (`test_windows_desktop_compositor_never_blocks_quiescence`, `test_genuine_foreign_process_outside_windows_directory_still_blocks`, `test_compositor_path_helper_is_windows_only_and_prefix_scoped`) plus a fix to an existing test whose mocked CSV rows silently stopped being checked once the query gained a 4th column. **Also verified directly against the real GPU** (not just mocks): `NvidiaGpuQuiescenceProbe().prove(realHardwareUuid)` failed before the fix and succeeded (3 clean samples) after it, on the exact same live machine state that was failing moments earlier.

### Harness-only fixes (no product behavior changed)

Found and fixed while getting `e2e/run.sh`/`e2e/run.cjs` to actually complete as one unattended script — each reproduced deterministically, not sandbox-specific:

- **Windows process-tree kill**: `npx tsx src/server.ts &` is a 3-4 process chain on Windows (a cmd.exe npx shim, node, tsx's loader child); a plain `kill $API_PID` only ever reached one process, leaving the rest running and holding a lock on the Prisma query engine DLL that broke the *next* run's `prisma generate`. Fixed with `taskkill //F //T //PID` (falls back to `kill` where taskkill doesn't exist). Also discovered and avoided a Git-Bash-on-Windows trap: `$!` after backgrounding a compound command is an MSYS-internal PID that neither `tasklist` nor `taskkill` can resolve - the real PID must come from `netstat` once the port is actually bound.
- **`gpubnb-agent setup`'s expected exit code**: `setup` ends by running the same diagnostic as `gpubnb-agent diagnose`, which intentionally returns exit code 1 whenever the machine isn't linked yet — true on every fresh config directory, by design. `run.sh`'s `set -e` treated this as fatal. Fixed with `|| true`; the real readiness gate is further down the script (`link` + `start` + wait-for-publishable).
- **Machine-publishability shortcut incomplete**: `run.cjs` force-sets `lastCudaProbeOk`/`verifiedAt`/`moderationStatus` to shortcut past the real GPU_PROOF diagnostic job (out of scope for a harness proving the Developer path) but forgot `operational`, which the real anti-spoofing executor had already set to `VERIFYING` - leaving the machine permanently stuck at `machine_not_publishable`. Fixed by also setting `operational: 'AVAILABLE'`, matching what `gpu-proof-completion.ts` does in production.
- **WebSocket activation didn't match what a real browser does**: two compounding gaps - (1) the gateway's upgrade handler requires `/workspace-gateway/:sessionId/<something>`, but the harness opened a bare `/workspace-gateway/:sessionId?grant=...` (404); (2) the grant is consumed and a session cookie set only by an initial HTTP GET to `openPath` (which a browser follows automatically before its WebSocket ever connects) - the harness skipped that GET and connected with no cookie (401). Fixed by performing the real GET first, extracting the `Set-Cookie` header, and attaching it to the WebSocket request, targeting the correct trailing-slash path.
- **Cleanup check raced the agent's own async status update**: the session only reaches its real terminal status (`COMPLETED`/`TIMED_OUT`) once the agent separately calls `POST /agent/workspace-gateway/:sessionId/stopped` *after* verifying container removal - a real, short async gap after `docker ps` already shows the container gone. The harness checked status exactly once, immediately. Fixed by polling for a terminal status with a bounded timeout instead of a single read.

## E2E Validation

A full rental lifecycle was exercised against **real infrastructure** on the operator's actual machine (one real NVIDIA GeForce GTX 1650, real Docker Desktop with the NVIDIA Container Toolkit, the real `gpubnb-agent` running under an isolated config directory so the real production agent/service was never touched). Nothing in this list was mocked, faked, or self-declared by the harness — see `e2e/RESULTS.md` for the exact evidence (log lines, HTTP statuses, `docker exec`/`docker events` output).

**Validated live, end-to-end, on real infrastructure:**
- Wallet/auth — real Ed25519 keypairs, real `/auth/nonce` → signature → `/auth/verify` → real Redis session.
- Agent pairing — real `/machines/link-code` → real `gpubnb-agent link` → real `/agent/link`, with the agent's actual reported inventory (real GPU, real Docker version, real NVIDIA runtime).
- Heartbeat — real heartbeats landing in Postgres, `connectivity: ONLINE`.
- GPU — real `nvidia-smi` detection; the real anti-spoofing `acceleratorSecurity` check transitioning `VERIFY`→`NONE` correctly across heartbeats.
- Booking — real listing, real booking, real `allocateBookingResources` (`SELECTED_ACCELERATORS` mode).
- Workspace preparation — real `POST /bookings/:id/workspace/developer` → real `WorkspaceSession`(`PREPARING`) + real `Job`(`WORKSPACE_PREPARE`) → real agent job pickup → real ephemeral verification container against the real `gpubnb-developer` image → `COMPLETED`.
- Docker — real persistent containers (`gpubnb-dev-<suffix>`, `gpubnb-dev-proxy-<suffix>`) reaching `healthy`; verified inside the live container: `nvidia-smi` (GTX 1650, 4096 MiB), `python3 --version` (3.12.3), `node --version` (v24.15.0), `/workspace` with `imports/`, `output/`, `WELCOME.md`.
- Gateway — real `POST /agent/workspace-gateway/:sessionId/register` populating real `connectionMetadata` (`runtimeId`, `localPort`, `gatewayPath`); `GET /bookings/:id/workspace` transitioning `GATEWAY_NOT_READY` → `READY`/`canOpen: true` exactly at that point.
- code-server — real HTTP reachability through the authenticated gateway tunnel (`302` from code-server, `302` through the proxied `/workspace-gateway/:id?grant=...` path).
- WebSocket — a genuine WebSocket "activation" was performed against the real gateway tunnel using the `ws` package (not just an HTTP GET).
- Cleanup — real `POST /workspace-sessions/:id/stop` → real agent-driven container + proxy removal, confirmed via `docker ps`.
- Second rental on the same GPU — after releasing the first booking's allocation via the real `releaseBookingResources`, a fresh booking + workspace request on the **same physical GTX 1650** succeeded end-to-end a second time (job completed, new container healthy, gateway registered, `canOpen: true`) — directly proving "GPU released and rentable again."
- Double-booking protection — attempting a second rental of the same GPU while the first `AcceleratorAllocation` was still `ACTIVE` correctly failed with `accelerator_not_rentable` (a real DB-level exclusion, not application logic).
- GPU temporarily busy — the original real-world trigger (Epic Games Launcher holding a GPU compute context) was reproduced live; the agent retried automatically (bug fix #1) instead of quarantining, and succeeded once the GPU became quiescent.
- **`e2e/run.sh` run as one unattended, unbroken script, twice in a row** (this mission) — the exact thing the previous mission could not do because of a sandbox constraint. No sandbox constraint was hit this time; the real blockers were the 7 real bugs documented above (agent daemon-start timing, the Windows GPU-quiescence false positive, and 5 harness-only defects), all now fixed.
- **Real agent-crash recovery** (this mission, `e2e/recovery-agent-restart.sh`) — with a workspace `READY`, gateway-registered, and `canOpen: true`, the real agent OS process was killed (`taskkill /F /T`, not `gpubnb-agent stop` — the point was to simulate an actual crash, not a graceful shutdown). Observed live: the Docker container kept running unmanaged (proving the container's lifecycle isn't tied to the agent process staying alive); the machine's heartbeat-derived connectivity was affected while the agent was down; restarting the agent (`gpubnb-agent start --daemon`) resumed real heartbeats within the normal window; after one real reconciliation cycle, there were exactly 2 containers (runtime + proxy, no duplicate) and exactly 1 live `AcceleratorAllocation` for the booking (no double-booking); a normal stop reached cleanup and container removal exactly as in the non-crash path; a second, independent booking on the same GPU then succeeded, proving full recovery.

**Validated only by automated tests, not by a live run:**
- The exact `GATEWAY_NOT_READY`→`READY` HTTP contract is also covered by `workspace-gateway-register-e2e.test.ts` against a disposable (not the operator's real) Postgres/Redis — this is real HTTP/DB behavior, just not on the physical GPU.
- Register idempotence (a second `/register` call from an agent retry/restart must not duplicate the booking transition) — proven only by the automated test, not separately reproduced live.
- The agent-side transient-vs-permanent quarantine distinction for the two other transient reasons (`rental_gpu_utilization_not_quiescent`, `rental_gpu_memory_not_quiescent`) — only the compute-process reason was hit live; the other two are unit-tested only.

**Not validated at all, even after this mission:**
- Recovery from a Docker daemon restart, or a gateway/API crash mid-session — only the agent-process-crash scenario was chosen and tested (the safest and most representative of the three suggested); the other two remain untested.
- A genuine WebSocket "first-frame" billing activation via the automated harness — both `e2e/run.cjs` and `e2e/recovery-agent-restart.cjs` open and cleanly close a WebSocket to prove the tunnel/auth work, but never exchange an actual data frame with code-server, so the session correctly (by the code's own documented contract - "only the first authenticated upstream WebSocket frame starts paid time") ends `TIMED_OUT` rather than `COMPLETED` in the automated runs. This is fail-closed-correct, not a bug, but it means the exact `COMPLETED` outcome (as opposed to `TIMED_OUT`) has only been observed with a real browser/code-server exchanging real frames, not through the unattended script.
- Multi-GPU hosts (out of scope for both missions so far).

## Tests

Last full local run (2026-08-30, against a disposable Postgres 17 + Redis 7, after this mission's product-code changes):

| Suite | Result |
|---|---|
| API (`apps/api`, `node --test test/*.test.ts`) | **466 / 466 passed** |
| Agent (`agent`, `pytest`) | **241 passed** (+4 vs. previous mission), **2 skipped** (pre-existing, unrelated), 9 subtests passed |
| Frontend (`apps/web`, `node --test`) | **17 / 17 passed** |
| TypeScript (`tsc --noEmit`, `apps/api`) | 0 errors |
| Build (`npm run build`, `apps/api`) | succeeds |

**CI**: not yet re-run for this mission's changes (nothing has been committed/pushed yet — see **Git / Branch**). The previous mission's final commit (`a2c5e48`, now merged into `main` as part of `eedee14`) had a fully green run — [`33287568313`](https://github.com/khemisset18/gpubnb/actions/runs/33287568313).

## Git / Branch

- **Current branch**: `main` (checked out and synced with `origin/main` at the start of this mission, per instruction).
- **Previous mission's 4 commits are merged**: `99cb920`, `c84908c`, `d7de304`, `a2c5e48` all landed in `main` via **PR #133**, merge commit `eedee14a09aa9809b3dacf1a9068490c82e412e7`.
- **This mission's changes are uncommitted as of this writing**, made directly on `main` (checked out fresh from `origin/main` at the start of this mission, as instructed):
  - `agent/gpubnb_agent/cli.py`, `agent/gpubnb_agent/gpu_rental_preemption.py` + their tests — the two real product fixes (Bugs Fixed #4, #5).
  - `e2e/run.sh`, `e2e/run.cjs` — the 5 harness-only fixes.
  - `e2e/recovery-agent-restart.sh`, `e2e/recovery-agent-restart.cjs` (new) — the recovery-scenario harness.
  - `.gitignore` — added `e2e/.agent-config/` and `e2e/.api.pid` (both harnesses' transient, key-bearing working directories were previously untracked-but-not-ignored, a real risk of an accidental commit).
- **Working tree**: not clean — see `git status` at commit time; nothing has been pushed.
- **PR**: none for this mission's changes yet.

## Known Limitations

- Docker-daemon-restart and gateway/API-crash recovery scenarios remain untested (only the agent-crash scenario was covered this mission, per instruction to pick one).
- The automated harnesses prove the WebSocket tunnel and cookie-based auth work, but don't exchange a real code-server data frame, so they always observe `TIMED_OUT` rather than `COMPLETED` at final cleanup - a correct, documented fail-closed outcome for what they actually do, not a bug, but it means `COMPLETED` itself is only observed with a real browser.
- Multi-GPU host behavior remains unverified by either mission.
- The Windows-desktop-compositor quiescence fix (Bug #5) has only been exercised on this one machine/driver/Windows build; the `_is_windows_desktop_compositor_path` prefix check is deliberately broad (anything under `%SystemRoot%`) specifically so it should generalize, but that generalization itself hasn't been tested on a second Windows machine.

## Remaining Work

Nothing is blocking. The concrete next steps are procedural:

1. Commit and push this mission's changes (product fixes + harness fixes + new recovery script + `.gitignore`), open a PR, get CI green, get it reviewed/merged.
2. Then pick up the next mission below.

## Next Mission

1. **Objective**: Close the two remaining gaps explicitly called out above — the untested recovery scenarios (Docker daemon restart, gateway/API crash) — and re-run the now-working `e2e/run.sh`/`recovery-agent-restart.sh` on a second machine to confirm they're not tuned to quirks of this one dev machine.
2. **Priority**: Medium — the core workflow and one recovery path are now proven; this closes remaining verification gaps rather than fixing something broken.
3. **Steps**:
   - Merge this mission's PR, confirm CI green.
   - Deliberately restart the Docker daemon mid-session (real workspace `READY`, real container running) and document the real observed behavior — does the agent detect the daemon outage, does the session reach a safe terminal state, does the GPU become rentable again afterward?
   - Deliberately kill/restart the gateway (the API process itself) mid-session and do the same.
   - Run both `e2e/run.sh` and `e2e/recovery-agent-restart.sh` on a second, different Windows machine (or a CI runner with a real GPU) to confirm the fixes in this mission generalize and aren't specific to this one machine's exact driver/Windows build.
4. **Success criteria**:
   - Both new recovery scenarios documented with real evidence (logs, DB state, container state) - not asserted from code reading alone.
   - `e2e/run.sh` and `e2e/recovery-agent-restart.sh` both complete unattended on a second machine.
   - `docs/PROJECT_STATUS.md` and `docs/MISSION_HISTORY.md` updated again with the outcome.
