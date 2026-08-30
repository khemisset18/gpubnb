# Mission History

Chronological record of technical missions on this repository. Each entry is a synthesis, not a log dump — see the referenced commits/files for full detail. Newest first.

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
