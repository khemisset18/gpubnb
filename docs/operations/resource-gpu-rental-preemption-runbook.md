# Resource-Scoped GPU Rental Preemption v1 Runbook

## Production state

This feature is a safety foundation only. Do not enable public mining command dispatch or broaden existing rollout percentages from this PR.

Direct resource-scoped rental preemption v1 is qualified for NVIDIA GPUs whose `Accelerator.hardwareUuid` resolves uniquely through `nvidia-smi` and whose workspace is launched through the v5 Developer Workspace gateway.

## Required canary hardware

Use one physical host with at least two qualified NVIDIA GPUs. Both GPUs must have stable UUIDs and independent `MiningResource` rows.

Before canary start record:

- GPU UUID and PCI address for both devices;
- MiningResource ids;
- pinned miner binary hash;
- driver version;
- Docker/NVIDIA runtime version;
- Agent version/commit;
- API and Gateway commit;
- idle VRAM/utilization baseline for each GPU.

## Core canary

1. Start mining on GPU A and GPU B with different resource leases/fencing tokens.
2. Confirm both exact miner process identities are persisted.
3. Create a Developer Workspace reservation allocated only to GPU A.
4. Confirm the API rental authority contains only A's resource id/UUID and a fencing token greater than A's mining generation.
5. Confirm the Agent terminates only A's persisted miner PID/creation identity.
6. Confirm B's miner PID, process identity, hash rate and runtime generation remain unchanged.
7. Confirm A produces three target-UUID quiescence samples with zero compute PIDs and bounded VRAM/utilization.
8. Inspect the Developer Workspace container. `HostConfig.DeviceRequests` must contain A's UUID exactly and must not contain B or `device=0` semantics.
9. Run a GPU workload inside the workspace and confirm it appears only on A.
10. Confirm B continues mining throughout the rental.
11. Stop the rental.
12. Confirm workspace/proxy/volume/network cleanup completes before the Agent accepts cleanup.
13. Confirm A again reaches target-UUID quiescence.
14. Confirm the exact rental lease is released after stop intent.
15. Acquire a newer mining lease for A and confirm A can resume without restarting B.

## Failure drills

### PID reuse

After recording a miner runtime, replace/reuse the PID identity in a test harness. Rental preemption must quarantine A and must not terminate the unknown process.

### Stale fence

Replay a rental authority whose fencing token is older than the local runtime generation. No process may be terminated and no workspace may start.

### Wrong Docker binding

Present an existing workspace container whose DeviceRequests contain B while the authority expects A. The Agent must not adopt it. The container must be removed and a fresh quiescence proof must pass before restart.

### Agent restart during rental

Restart the Agent while a correctly UUID-bound workspace and matching `RENTAL_ACTIVE` claims exist. It may adopt only when the exact DeviceRequest set and local claims match the server authority. Ambiguous state must be torn down and reproved.

### API unavailable during start

If rental authority is unavailable because API/Agent versions are staggered, the runtime must remain on the legacy machine-wide mining guard. It must never infer a resource-scoped allocation locally.

### API unavailable during cleanup release

If cleanup is proven locally but server lease release fails, no workspace may remain. The server rental lease is allowed to expire naturally; do not bypass its fencing token.

### Quiescence failure

Inject a compute PID, utilization above 5 percent, or VRAM above threshold on A. A must quarantine and the workspace must not start. Activity only on B must not block A.

## Evidence required before rollout

Archive:

- Agent logs around preemption/quiescence/cleanup;
- API rental-authority responses with lease ids redacted only if operational policy requires it, never fencing tokens needed for correlation;
- Redis fence progression per resource;
- Docker inspect DeviceRequests;
- `nvidia-smi` UUID/process/utilization snapshots;
- miner PIDs before and after;
- B continuity/hash-rate evidence;
- Windows installer/preflight evidence for the exact Agent build.

## Rollback

Rollback is configuration-first: keep the new code installed but disable any future resource-scoped rollout switch and use the legacy machine-wide guard. Never roll back by disabling fencing, process identity validation, GPU UUID validation, or quiescence checks.
