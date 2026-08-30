# GPUbnb — Project Status

_Last updated: 2026-08-30, end of the Workspace-gateway hardening mission, branch `fix/rental-timer-starts-at-workspace-open`._

## Current State

The GPUbnb Host Workspace workflow (booking → GPU assigned → Docker container → code-server → gateway → renter opens the workspace → cleanup → GPU released) has been audited, two real production-affecting bugs have been fixed with real code changes and regression tests, and the complete lifecycle has been proven end-to-end on a real single GTX 1650 (real Docker, real agent, real gateway — nothing mocked). A reusable `e2e/` harness now exists so this can be re-run on any normal machine. All work is committed on `fix/rental-timer-starts-at-workspace-open` (3 commits ahead of `main`), CI is fully green on the latest commit, and **no PR has been opened yet** — that is the next concrete step.

## Mission Completed

- Audited the Workspace/Docker/Gateway/Agent chain for a single-GPU host, using the renter's `docs/AUDIT.md`/architecture as ground truth rather than assumptions.
- Fixed a bug where a transient GPU-quiescence failure (another local process briefly holding the GPU, e.g. Epic Games Launcher) permanently quarantined the machine instead of retrying — reproduced the exact real-world trigger live and confirmed the fix.
- Fixed a bug where a Developer `WorkspaceSession` could read `status: READY` (and be reported as `"READY"` to the renter) before the gateway tunnel had actually registered, making the "Ouvrir" action fail with a 409 the renter couldn't explain — reproduced the exact original incident live and confirmed the fix.
- Added real HTTP/DB-level regression tests for both incidents (`apps/api/test/workspace-developer-phase.test.ts`, `apps/api/test/workspace-gateway-register-e2e.test.ts`), using real signed Ed25519 agent requests against real Postgres/Redis, not re-implementations of the logic under test.
- Removed user-facing "GPU Proof" / "bêta" wording from the renter UI (`apps/web/session.html`, `session.js`, `workspace-bookings.js`, `workspace-developer-flow.js`) in favor of neutral "vérification"/"connexion" language, while leaving internal test file/route names untouched as instructed.
- Built and validated a real, non-simulated end-to-end run of the entire rental lifecycle on the operator's real GTX 1650 (see **E2E Validation** below), then packaged it as a reusable harness under `e2e/`.
- Found and fixed a CI-only regression introduced by the two new test files (see **Bugs Fixed #3** below), verified against a real disposable Postgres/Redis with the local `.env` deliberately hidden to reproduce CI conditions exactly, then pushed and watched CI go green.

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

**Validated only by automated tests, not by a live run:**
- The exact `GATEWAY_NOT_READY`→`READY` HTTP contract is also covered by `workspace-gateway-register-e2e.test.ts` against a disposable (not the operator's real) Postgres/Redis — this is real HTTP/DB behavior, just not on the physical GPU.
- Register idempotence (a second `/register` call from an agent retry/restart must not duplicate the booking transition) — proven only by the automated test, not separately reproduced live.
- The agent-side transient-vs-permanent quarantine distinction for the two other transient reasons (`rental_gpu_utilization_not_quiescent`, `rental_gpu_memory_not_quiescent`) — only the compute-process reason was hit live; the other two are unit-tested only.

**Not validated at all in this mission:**
- Recovery from an agent process crash/restart mid-session, a Docker daemon restart, or a gateway/API crash mid-session — none of these were deliberately injected during the live run.
- Multi-GPU hosts (the whole point of this mission was proving the single-GPU case works correctly; a host with more than one GPU was out of scope).
- Running `e2e/run.sh` as one unattended, unbroken script execution — every step was proven individually because the sandbox this session ran in was independently confirmed (via `docker events`) to kill freshly-created Docker containers on an unpredictable schedule, unrelated to GPUbnb's own code. On a normal machine or CI runner this constraint does not apply; see `e2e/README.md`/`e2e/RESULTS.md` for the full explanation.

## Tests

Last full local run (2026-08-30, against a disposable Postgres 17 + Redis 7, before the final push):

| Suite | Result |
|---|---|
| API (`apps/api`, `node --test test/*.test.ts`) | **466 / 466 passed** |
| Agent (`agent`, `pytest`) | **237 passed, 2 skipped** (pre-existing, unrelated), 9 subtests passed |
| Frontend (`apps/web`, `node --test`) | **17 / 17 passed** |
| TypeScript (`tsc --noEmit`, `apps/api`) | 0 errors |
| Build (`npm run build`, `apps/api`) | succeeds |

**CI**: the latest pushed commit, `d7de304`, has a **fully green** GitHub Actions run — [`33287208009`](https://github.com/khemisset18/gpubnb/actions/runs/33287208009) — all 6 jobs passed: `api`, `agent`, `security-static-analysis`, `production-gates`, `contract`, `dependency-audit`. (The previous commit `c84908c` had failed CI on the `api` job only, for the `PLATFORM_WALLET` reason documented in Bugs Fixed #3 — that is fixed and confirmed green on `d7de304`.)

## Git / Branch

- **Current branch**: `fix/rental-timer-starts-at-workspace-open`
- **Base/target branch**: `main` (confirmed via `git remote show origin` → `HEAD branch: main`, and via PR #132's `baseRefName`)
- **3 commits ahead of `main`**, none yet merged:
  1. `99cb920` (2026-08-27) — `fix: start rental timer when workspace opens` — re-anchors `expiresAt` to the renter's real `startedAt` in `POST /workspace-sessions/:id/start` so a long preparation doesn't eat into paid time. **Predates this mission** (committed 3 days earlier, on the same branch); not otherwise covered above, but its regression test (`workspace-session-start-timer.test.ts`) is included in and passes with the 466 API tests above.
  2. `c84908c` (2026-08-30) — `fix: GPU quarantine transitoire + READY prématuré du gateway workspace` — this mission's two main bug fixes, new regression tests, and the `e2e/` harness.
  3. `d7de304` (2026-08-30) — `test: fix CI env-fallback gap in new workspace gateway tests` — the CI fix described above.
- **Remote**: local and `origin/fix/rental-timer-starts-at-workspace-open` are in sync at `d7de304`.
- **Working tree**: clean.
- **PR**: none open. A previous PR on this same branch name, **#132**, was already merged into `main` on 2026-08-21 — but that merge only covered the branch's state as of `72a836e` (which included commit `e8065e7`/`72a836e` themselves, a *different, already-merged* fix: "don't complete a booking until its Developer workspace is done"). The 3 commits above were added to the branch **after** that merge and are not in `main` yet.

## Known Limitations

- `e2e/run.sh` has not been executed as a single unattended script end-to-end in this development sandbox (see E2E Validation above); it is expected to work unattended on a normal machine or CI runner, but that has not itself been observed yet.
- No deliberate fault-injection testing (agent crash, Docker daemon restart, gateway/API crash mid-session) has been performed.
- Multi-GPU host behavior is unverified by this mission.

## Remaining Work

Nothing is blocking. The concrete next step is procedural, not technical:

- Open a PR from `fix/rental-timer-starts-at-workspace-open` into `main` and get it reviewed/merged (see **Next Mission**).

## Next Mission

1. **Objective**: Get this branch's 3 commits merged into `main` safely, then close the loop on the "not validated in this mission" list above (recovery scenarios, unattended `e2e/run.sh` run on a non-sandboxed machine/CI runner).
2. **Priority**: Medium — nothing is broken or blocking in production; this is about landing already-proven fixes and closing verification gaps, not urgent firefighting.
3. **Steps**:
   - Open a PR (`fix/rental-timer-starts-at-workspace-open` → `main`) using the summary in this document; confirm CI is green on the PR itself (not just the branch push) before requesting review.
   - After merge, run `e2e/run.sh` unattended, start to finish, on a normal (non-sandboxed) development machine or a CI runner with real Docker + a real or emulated GPU, and update `e2e/RESULTS.md` with that run's evidence.
   - Deliberately test at least one recovery scenario end-to-end (e.g. restart the agent process mid-`PREPARING`, or kill the Docker daemon mid-session) and confirm the system reaches a safe, explainable terminal state rather than a stuck one.
4. **Success criteria**:
   - PR merged into `main` with green CI.
   - `e2e/run.sh` completes unattended, exit code 0, on a machine without the sandbox's container-teardown behavior.
   - At least one injected-fault recovery scenario is documented with real evidence (not asserted from code reading alone).
