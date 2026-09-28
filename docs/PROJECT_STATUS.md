# GPUbnb — Current Project Status

_Last updated: 2026-09-11._

## Release qualification

The project has now reached a real physical Host/Workspace/GPU/cleanup milestone on the exact published Host baseline:

- release: `host-v0.2.0-beta.85`;
- Agent: `0.6.6`;
- build commit: `4615a880752a8a97c161c4a37f0f50bf6f1bca03`;
- real provider PC A and separate renter PC B;
- public Developer Workspace opens to a usable real code-server environment;
- renter terminal sees the exact leased physical GPU UUID `GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a` (`NVIDIA GeForce GTX 1650`, driver `592.82`, `4096 MiB`);
- rental stops through the normal lifecycle;
- the GPU/listing returns to available/bookable;
- read-only Docker inventory after stop finds no `gpubnb-dev-*` container, `gpubnb-dev-proxy-*` proxy, `gpubnb-workspace-*` volume or `gpubnb-workspace-internal-*` network.

The exact validated runtime commit is preserved as:

`baseline/physical-pass-beta85-2026-09-11`

Detailed physical record: `docs/PHYSICAL_BASELINE_2026-09-11_BETA85.md`.

This is one of the strongest end-to-end physical results in the project so far: the product has moved beyond CI/simulation and partial Workspace rendering to a real renter reaching an interactive development environment backed by the exact physical GPU that was leased, followed by clean release and reuse.

The current automated qualification path on `main` also exercises the real rental lifecycle rather than the old Developer-only shortcut: production `GPU_PROOF` runs before Developer preparation; activation requires genuine upstream code-server WebSocket traffic; recovery covers an Agent restart while preserving a single runtime/allocation; post-stop verification proves per-session Docker cleanup and GPU reuse; and the live Developer container is required to expose exactly the `Accelerator.hardwareUuid` leased to the booking.

## Qualification scope and honesty boundary

The beta.85 clean run locks the Host/Agent identity and physically validates the Host/Workspace/GPU/cleanup path. The final evidence package did not independently re-capture the exact API/frontend release identities in the same run, so the project must not describe this as a complete all-component deployment attestation.

`docs/CURRENT_PHYSICAL_QUALIFICATION.md` remains the release-gate source of truth and now distinguishes the physically passed Host/Workspace baseline from the still-pending full API/frontend release identity lock.

## Current hardening priorities

### 1. Interrupted-rental recovery — resilience priority

Issue #190 tracks the remaining high-value failure mode: a Host power loss/reboot during an active rental can leave the previous server-owned booking/session/allocation authority blocking reuse until the old rental window expires.

The fix must produce one deterministic server-authoritative outcome: safe resume with a fresh fenced generation, or deterministic termination/cleanup/release. It must never admit a new rental while old authority is live and must never require ProgramData deletion, force-clear or manual DB edits.

### 2. Workspace startup performance — measurement first

Issue #191 tracks stability and network/startup performance after the physical pass.

Do **not** optimize by blindly increasing timeouts or weakening queue/fencing/auth rules. First measure the individual stages: runtime/container startup, code-server readiness, gateway registration, API/Redis command transit, local WebSocket handshake, first browser frame, first useful code-server frame, time to interactive Workspace, reconnect behavior and cleanup latency.

Only optimize the stage proven to dominate real startup time, compare against the frozen beta.85 baseline, and rerun the physical PC A ↔ PC B qualification before promotion.

### 3. Machine state projection correctness

A separate known state-model issue can map generic `MachineOperational.DEGRADED` to `DIAGNOSTIC_FAILED` even when the latest mandatory diagnostic checks completed successfully. That should be split into a generic degraded/runtime state versus a true diagnostic failure while keeping publication/booking fail-closed for the real degradation cause.

## Stability policy from this point

The beta.85 baseline is now the minimum acceptable normal-path behavior. Changes to Workspace transport, Agent authority, queueing, cleanup or GPU allocation should be isolated on branches and must preserve:

- signed Agent authentication and anti-replay;
- server-owned rental authority;
- monotonic fencing generations;
- exact GPU exclusivity;
- quarantine semantics;
- bounded queue/payload/frame behavior;
- per-session browser isolation and Service Worker scope;
- one runtime per Workspace session;
- normal stop and four-resource Docker cleanup;
- safe listing/resource reuse only after release is complete.

No performance improvement is worth weakening those invariants.

## Historical status snapshot

The previous `PROJECT_STATUS.md` mission snapshot from 2026-08-30 remains preserved at `docs/history/PROJECT_STATUS_2026-08-30.md` for audit/history purposes. Its statements about then-current branch state, test counts, limitations, or the harness shortcutting the real `GPU_PROOF` path are historical and must not be used as current release evidence.

## Next release action

Keep `host-v0.2.0-beta.85` / Agent `0.6.6` / commit `4615a880...` as the physical reference while hardening continues on isolated branches.

The next runtime-affecting release should not replace this baseline until exact-head CI is green and a repeated real PC A ↔ PC B run proves: usable Workspace, exact renter-side GPU UUID, stable connection, normal stop, zero per-session Docker leftovers and safe resource/listing reuse. Reboot recovery from #190 must be treated as a separate resilience gate rather than hidden inside ordinary startup tuning.
