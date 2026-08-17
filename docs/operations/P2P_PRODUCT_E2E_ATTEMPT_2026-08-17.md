# Product E2E attempt — 2026-08-17

## Scope

This record supplements `P2P_PHYSICAL_QUALIFICATION_2026-08-17.md` with the first private-beta product-level booking attempt performed after the successful physical P2P and physical GPU runner qualifications.

No private signing key, TLS private key, raw peer endpoint list, session cookie, payment credential, or other secret is recorded here.

## Previously proven physical evidence

The following evidence remains valid and is not changed by the failed product-level attempt:

- same-network authenticated direct QUIC: success, direct path, no relay;
- two physical machines on different Internet access networks: authenticated `DIRECT_HOST` success, no relay fallback;
- PC A physical NVIDIA GeForce GTX 1650: the real GPUbnb `run_gpu_proof_workspace()` runner completed the official immutable GPU proof image for 30 seconds with `gpuDetected=true`, `iterations=7441`, and `containerCleaned=true`.

These proofs are separate. They do not by themselves prove a complete marketplace booking flow, and they do not prove that GPU workload payload bytes traverse the direct P2P QUIC path.

## Product-level attempt result

**Result: NOT QUALIFIED / INCONCLUSIVE.**

A real renter booking was created from PC B against the real PC A listing. The product UI reached a `PREPARING` state, but the attempt did not produce sufficient evidence that the intended `GPU_PROOF` job had been created, claimed, executed, finalized, and reflected back to the renter UI. The test was stopped and both physical PCs were shut down. No success claim is made for the product E2E.

## Host evidence observed during the attempt

The source Agent on PC A continued to report healthy signed heartbeats with:

```text
ok=true
publishable=true
agentUpgradeRequired=false
acceleratorSecurity.severity=NONE
```

Earlier in the same Agent log, the product attempt exposed two resource-authority failures:

```text
rental_resource_authority_missing_for_session
rental_gpu_resource_mapping_missing
```

A prior `job_completed` event was also present, but its type was not identified. It must not be represented as a completed `GPU_PROOF`.

## Resource-authority integration defect

The modern accelerator heartbeat path synchronized `MachineAccelerator` inventory, while rental resource authority still resolves a GPU through the legacy `Accelerator -> MiningResource` mapping. A host could therefore be healthy, online and publishable while the rental authority had no GPU resource mapping for the same physical GPU.

Commit `81e9cd6d7007b9ad18d595fc229e5fe138ba2259` adds `syncGpuMiningResourcesFromAccelerators()` to the same heartbeat transaction. The bridge:

- derives stable GPU resource keys from the hardware/device UUID;
- upserts the legacy `Accelerator` row;
- upserts/enables the corresponding `MiningResource`;
- disables stale GPU resources for the same machine;
- preserves CPU resource handling.

Before deployment, the targeted mining-resource stability tests passed `2/2` and the API TypeScript build completed successfully. After the exact commit was deployed, recent Agent log tails showed healthy heartbeats and no new `rental_gpu_resource_mapping_missing` entry. Historical errors remained in the log and must not be confused with post-deploy failures.

This stopped one observed blocker, but it did not prove that the existing pre-fix reservation recovered or that a new `GPU_PROOF` executed.

## Product-routing defects found after the physical attempt was stopped

A full source-path review found two additional integration defects that should have been checked before asking for another physical run.

### 1. Marketplace exposed an unregistered Developer renter flow

`compatibleWorkspaceChoices()` exposed both `developer` and `compute` as executable beta choices. However, the main `server.ts` did not import or call `registerWorkspaceRenterRoutes()` from `workspace-renter-routes.ts`.

Consequently, the UI could offer `Developer Workspace` even though its renter routes were not registered in the running main API process. Source-presence tests had verified the separate module by reading its file, but did not verify route registration in the real server.

### 2. Bookings UI followed Developer instead of Compute/GPU_PROOF

`apps/web/workspace-bookings.js` queried the Developer-specific `/bookings/:bookingId/workspace` endpoint for every booking. On a 404 it displayed `Préparer Developer` and called `/bookings/:bookingId/workspace/developer`.

This meant a valid Compute/GPU_PROOF booking could be presented as if no workspace existed, and the recovery UI could steer the renter toward the unrelated Developer path.

The registered Compute route itself is correct: `POST /bookings/:bookingId/workspace-sessions` accepts `{"workspaceSlug":"compute"}` and `ensureComputePreparation()` creates a `GPU_PROOF` job.

## Corrective private-beta routing changes

The private-beta marketplace is now fail-closed to the path that is actually registered and tied to the qualified GPU proof runtime:

- public workspace discovery exposes only `compute`;
- the bookings page follows `GPU_PROOF` jobs returned by `/dashboard`;
- the bookings page prepares Compute through `POST /bookings/:bookingId/workspace-sessions` with `{"workspaceSlug":"compute"}`;
- it no longer falls back to `Developer` when a Compute booking has no Developer-specific workspace response;
- regression tests now assert that the private-beta marketplace exposes only Compute, that the server Compute route creates `GPU_PROOF`, and that the bookings UI never uses the Developer fallback.

Developer code remains in the repository but is intentionally not offered in the private-beta marketplace until its renter route module is explicitly registered in the main server and covered by a real route-level integration test.

## Current software head

After the routing correction, PR #125 remains open and draft. The branch head at the time this record was created is expected to advance beyond `81e9cd6`; the exact final SHA must be taken from the PR after this documentation commit.

No stacked PR in the #122-#125 sequence was merged as part of this work.

## Qualification gate before another physical test

Do not run another two-PC product test merely because the code is present. Before another physical run, all of the following must be true:

1. the automatic regression suite for the corrected branch is green;
2. the API build is green;
3. the exact branch commit intended for qualification is deployed;
4. the private-beta marketplace visibly exposes only the intended Compute path;
5. a fresh reservation is used after deployment so stale pre-fix session state cannot be mistaken for a recovery result;
6. the physical run captures explicit `GPU_PROOF` creation, Agent claim, execution, signed workload metrics, completion/finalize-proof, booking completion and machine release.

Until those conditions are met, the correct product-level status is **NOT QUALIFIED**.
