# Mission History

Chronological record of technical missions on this repository. Each entry is a synthesis, not a log dump — see the referenced commits/files for full detail. Newest first.

---

## 2026-08-30 — Real E2E + Recovery validation

**Branch**: `main` (the previous mission's 4 commits were merged into `main` via PR #133, merge commit `eedee14a09aa9809b3dacf1a9068490c82e412e7`, just before this mission started).

**Objective**: The previous mission's `e2e/run.sh` had only ever been proven step-by-step, manually, because of a sandbox constraint (the dev sandbox was independently confirmed, via `docker events`, to kill freshly-created Docker containers on an unpredictable schedule). This mission's job was to actually run it as **one unattended script**, on real infrastructure, and then prove at least one real recovery scenario (an injected fault, not a unit test) - finishing with updated documentation.

**What was executed**: `git fetch`/checked out `main` fresh from `origin/main`, read `docs/PROJECT_STATUS.md`/`docs/MISSION_HISTORY.md`/`e2e/README.md`/`e2e/RESULTS.md` to avoid re-proving what was already established, then ran `./e2e/run.sh`. It failed. Investigated and fixed, in order, re-running the full script from scratch after each fix (never assuming a fix worked without re-observing it):

1. `gpubnb-agent setup` exits 1 by design on a fresh, unlinked config dir (it re-runs the same diagnostic as `gpubnb-agent diagnose`) - `run.sh`'s `set -e` treated this as fatal. Harness fix: `|| true`.
2. The API server's Windows process tree (`npx tsx src/server.ts` → cmd shim → node → tsx loader child) wasn't being fully killed by cleanup, leaving orphans that locked the Prisma query engine DLL and broke the *next* run's `prisma generate`. Diagnosed by finding a genuinely-orphaned `python.exe` process from an earlier manual test still alive minutes later, then confirming with `taskkill`/WMI experiments that `$!` in Git Bash on Windows is an MSYS-internal PID unusable for `taskkill`. Harness fix: discover the real PID via `netstat` (as before), kill with `taskkill /F /T` (process-tree kill) instead of plain `kill`.
3. **Real agent-CLI bug**: `gpubnb-agent start --daemon` failed intermittently with "démarrage non confirmé" - a hardcoded 5-second self-confirmation deadline, too tight given the child must load config/key/resolve its workspace image/start threads *and* each Windows confirmation poll spawns a real ~0.3-1.5s PowerShell subprocess. Fixed: `DAEMON_START_CONFIRM_TIMEOUT_SECONDS = 20`, with a new test that reproduces the exact failure against the old value and passes against the new one.
4. **Real, significant agent-CLI/security bug**: even with #3 fixed, the agent's own retry-forever loop (from the *previous* mission's bug fix #1) never actually cleared. Investigated with raw `nvidia-smi --query-compute-apps` calls: 8 consecutive samples, 2 seconds apart, all identically showing `explorer.exe`/`dwm.exe`/`TextInputHost.exe` - Windows's own desktop compositor, permanently "present" per NVML on any ordinary desktop session. This made GPU quiescence structurally unprovable on Windows, not a transient condition. Fixed with a narrow, security-conscious exclusion (`_is_windows_desktop_compositor_path`): only paths NVML itself reports as living inside `%SystemRoot%` are excluded, verified directly against the real GPU (quiescence failed before the fix, succeeded after, on the same live machine state) as well as with 3 new unit tests.
5. Machine stuck at `machine_not_publishable` (`state: "DIAGNOSTIC_RUNNING"`) - the harness's DB shortcut past the real GPU_PROOF diagnostic job set `lastCudaProbeOk`/`verifiedAt`/`moderationStatus` but forgot `operational`, which the real anti-spoofing executor had already flipped to `VERIFYING`. Harness fix: also set `operational: 'AVAILABLE'`, matching `gpu-proof-completion.ts`'s own production behavior.
6. Real gateway registration and Docker verification (`nvidia-smi`/`python3`/`node`/`/workspace` all real and correct inside the live container) succeeded once #1-5 were fixed - but the harness's own WebSocket "activation" step 404'd, then 401'd. Root cause: the gateway's upgrade route requires a trailing path segment after the session id, and real browser activation requires first GETting `openPath` (which consumes the one-time grant and sets a session cookie) before ever opening the WebSocket - the harness skipped both. Harness fix: perform the real GET, extract `Set-Cookie`, attach it to the WebSocket request, target the corrected path.
7. `./e2e/run.sh` then completed **fully unattended, end to end**. Repeated it a second time from a clean state to confirm reproducibility (not a fluke) - also succeeded, surfacing one more small race (checking the session's final status before the agent's async `/stopped` call had a chance to run) which was fixed by polling for a terminal status instead of reading it once.
8. **Recovery scenario**: wrote a new, permanent harness (`e2e/recovery-agent-restart.sh`/`.cjs`, reusing the same real production functions as `run.cjs`) that gets a workspace to `READY`+gateway-registered+`canOpen:true`, then genuinely kills the real agent OS process (`taskkill /F /T`, simulating a crash, not `gpubnb-agent stop`). Observed live: the Docker container survives unmanaged; heartbeats stop; restarting the agent resumes heartbeats within the normal window; after one real reconciliation cycle there are exactly 2 containers (no duplicate) and exactly 1 live resource allocation (no double-booking); a normal stop/cleanup then completes exactly as in the non-crash path, and a second, independent booking on the same GPU succeeds. Ran twice; both times clean.
9. Re-ran the full API (466)/agent (241, +4 new tests)/frontend (17) suites plus `tsc --noEmit` and `npm run build` after all product-code changes - no regressions.
10. Updated `docs/PROJECT_STATUS.md` and this file. `e2e/RESULTS.md` update and the actual commit/push/PR are the next steps (not yet done as of this entry - see `docs/PROJECT_STATUS.md`'s **Git / Branch**).

**Result**: `e2e/run.sh` is now a genuinely working, reproducible, unattended harness (2/2 clean runs) - the single biggest gap called out in the previous mission's own "Next Mission" section. A real agent-crash recovery scenario is proven and has its own permanent, reusable script. 2 real product bugs (agent daemon-start timing; GPU quiescence false-positive on Windows) and 5 harness-only bugs were found and fixed, each with regression coverage or a documented live re-verification. Nothing has been committed yet.

---

## 2026-08-30 — Workspace-gateway hardening: quarantine bug, READY bug, real E2E proof, CI fix

**Branch**: `fix/rental-timer-starts-at-workspace-open` (built on top of `99cb920`, an earlier unrelated fix already sitting on this branch since 2026-08-27 — see that commit's own message for its scope).

**Why**: The Host Workspace rental workflow (single-GPU case: booking → Docker → code-server → gateway → "Ouvrir") had accumulated "beta/test/proof" scaffolding and had never been proven correct end-to-end against real infrastructure. Two specific incidents were suspected: a machine could get permanently GPU-quarantined for a condition that should self-resolve, and the renter-facing "READY" state could be shown before the workspace was actually openable.

**What was done, in order**:

1. **Audit** of the Workspace/Docker/Gateway/Agent chain (`WorkspaceSession` state machine, `Job` lifecycle, agent reconciliation loop, gateway registration) against the actual code, not assumptions.
2. **Bug fix #1 — GPU quarantine on transient busy-GPU condition.** `agent/gpubnb_agent/gpu_rental_preemption.py`: distinguished 3 transient quiescence-failure reasons from permanent ones; transient failures now retry instead of quarantining the machine. Added/renamed unit tests in `agent/tests/test_gpu_rental_preemption.py`, plus a human-readable operator message in `agent/gpubnb_agent/cli.py`.
3. **Bug fix #2 — premature READY.** `apps/api/src/workspace-renter-routes.ts`: `preparationPhase()` now reports a distinct `GATEWAY_NOT_READY` phase whenever the session status is `READY` but the gateway hasn't registered (`connectionMetadata` still null), instead of echoing the raw, misleading `READY`. `safeConnection`/`preparationPhase` exported for direct testing. UI updated in `apps/web/workspace-developer-flow.js`/`workspace-bookings.js` to show "Connexion de l'espace de travail…" for that phase.
4. **Frontend wording cleanup**: removed "GPU Proof"/"bêta" language from renter-facing surfaces (`apps/web/session.html`, `session.js`, `workspace-bookings.js`) in favor of neutral "vérification" language, per the explicit instruction to never show internal/test terminology to real users. Internal test file and route names were deliberately left unchanged.
5. **New regression tests**: `apps/api/test/workspace-developer-phase.test.ts` (phase-logic unit tests) and `apps/api/test/workspace-gateway-register-e2e.test.ts` (full HTTP-level test — real Fastify app, real Ed25519-signed v2 agent request, real Postgres/Redis — proving the `GATEWAY_NOT_READY`→`READY` transition and register-idempotence).
6. **Real, non-simulated E2E validation** on the operator's actual GTX 1650: real wallet auth, real agent pairing, real heartbeats, real booking, real Docker container with GPU passthrough, real gateway registration, a real WebSocket activation, real cleanup, and — critically — **the exact original real-world triggers for both bugs were reproduced live** (Epic Games Launcher holding the GPU; the READY-before-register race) and the fixes were confirmed against those live reproductions, not just against unit tests. A genuine sandbox constraint was hit and investigated rigorously (the sandbox's own Docker supervisor was killing freshly-created containers on an unpredictable schedule, confirmed via `docker events`, unrelated to GPUbnb's code) rather than accepted as inconclusive.
7. **Built `e2e/` as a permanent, reusable harness** (`run.sh`, `run.cjs`, `README.md`, `RESULTS.md`) so the same lifecycle can be re-run unattended on a normal machine, packaging every step proven manually above into one script.
8. **Pre-commit finalization review**: full `git diff`/`git status` review, secret/artifact scan (none found; one non-secret GPU hardware UUID in `RESULTS.md` was genericized out of caution), confirmed `e2e/run.sh` was missing a build step (`apps/api/dist/*.js` is required by `run.cjs` but nothing built it) — fixed before commit. Full local validation re-run (466 API / 237+2 agent / 17 frontend tests, `tsc --noEmit`, build) — all green.
9. **Committed** (`c84908c`) and **pushed** to `origin/fix/rental-timer-starts-at-workspace-open`.
10. **CI came back red** on the `api` job only. Investigated precisely rather than dismissed: both new test files used a *static* import of a module that transitively validates `PLATFORM_WALLET` via `config.ts` at import time; static imports are hoisted before the repo's usual `process.env.X ??= ...` CI-fallback convention could run. This was masked locally because `tsx` auto-loads the local (gitignored) `.env`, which CI doesn't have.
11. **Fixed** by converting those imports to dynamic `await import(...)`, matching the existing convention used elsewhere in the repo (`gpu-proof-completion.test.ts` and others). Verified the fix by physically hiding the local `.env` files and re-running the two tests against a real disposable Postgres/Redis — reproducing CI conditions exactly rather than trusting the fix by inspection.
12. **Committed** (`d7de304`) and **pushed**. GitHub Actions run `33287208009` came back **green on all 6 jobs**.
13. **Closure/documentation** (this mission): reconstructed the full branch history from git (not from memory/assumption), and wrote `docs/PROJECT_STATUS.md` + this file so a future session can resume without re-reading the full conversation.

**Result**: 3 unmerged commits on `fix/rental-timer-starts-at-workspace-open` (`99cb920`, `c84908c`, `d7de304`), all green on CI, no PR opened yet — see `docs/PROJECT_STATUS.md` for the current state and the recommended next mission (open the PR, run `e2e/run.sh` unattended on a non-sandboxed machine, test a real recovery scenario).

---

## 2026-08-27 — Rental timer anchored to actual workspace start

**Branch**: `fix/rental-timer-starts-at-workspace-open` (commit `99cb920`).

**Why**: `POST /workspace-sessions/:id/start` left a session's `expiresAt` at the value set when the `WorkspaceSession` was created (`booking.endsAt`, the original reservation window). If preparation (GPU_PROOF or Developer workspace setup) ran long, that ate into the renter's paid duration, or could even leave them with an already-"expired" session before they'd connected at all.

**What was done**: Re-anchored `expiresAt` to the renter's actual `startedAt` plus `expectedSeconds`, matching the equivalent logic already used by the Developer-workspace activation path in `workspace-gateway.ts`. Added `apps/api/test/workspace-session-start-timer.test.ts`: a static source-shape check (would have failed against the previous code) plus a real-Postgres integration test of the same formula.

**Result**: Committed on this branch ahead of the 2026-08-30 mission above; not yet merged into `main` as of this writing (its regression test is included in and passing with the 466-test API suite referenced in `docs/PROJECT_STATUS.md`).

---

## Earlier history

Older work (initial audit, wallet/auth, agent CLI, marketplace, RC1 hardening campaign, mainnet-readiness passes, host-desktop installer, mining/idle-resource features, etc.) predates this file and is not reconstructed here. See `CHANGELOG.md` (RC1 campaign detail), `docs/AUDIT.md`, `docs/IMPLEMENTATION_STATUS.md`, and `docs/STATUT_RELEASE.md` for that history.
