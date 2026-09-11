# Physical baseline — Host beta.85 / Agent 0.6.6 — 2026-09-11

Status: **PHYSICALLY PASSED for the Host/Workspace/GPU/cleanup path described below**.

This document freezes the strongest real PC A ↔ PC B result obtained after the Workspace transport fixes in PRs #188 and #189. It is a factual baseline and rollback reference, not a claim that every fault-injection scenario or every deployment component has been requalified.

## Frozen runtime identity

Validated Host release:

- release tag: `host-v0.2.0-beta.85`;
- Agent version: `0.6.6`;
- Agent build commit: `4615a880752a8a97c161c4a37f0f50bf6f1bca03`;
- installed executable: `C:\Program Files\GPUbnb Host\gpubnb-agent.exe`;
- published Windows installer SHA-256: `20912e631ac5ecca32a51873c402895e81f2a8942c694c6cf4cdbf78afd17678`.

The exact validated Git commit is preserved by branch:

`baseline/physical-pass-beta85-2026-09-11`

Do not move, rewrite or repurpose that branch. It is the rollback/reference point for subsequent stability and performance work.

## Real physical path that passed

The final validation used a real provider PC A and a separate renter PC B through the public GPUbnb Workspace path.

Observed repeatedly on fresh rentals:

- the rental starts through the normal product flow;
- the Developer Workspace opens to the real code-server workbench;
- Explorer and terminal are usable;
- no visible `Time limit reached` / reload loop occurred on the clean beta.85 runs;
- the renter terminal has NVIDIA access inside the Developer container;
- the exact leased GPU is visible from the renter environment;
- the rental ends through the normal lifecycle;
- the same GPU/listing returns to available/bookable state;
- the next rental can be started again without manual state repair.

## Exact renter-side GPU proof

From the Workspace terminal on PC B:

```text
GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a, NVIDIA GeForce GTX 1650, 592.82, 4096 MiB
```

This matches the Host inventory UUID exactly and proves that the renter container sees the intended physical accelerator, not merely a generic NVIDIA-capable environment.

Validated values:

- hardware UUID: `GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a`;
- model: `NVIDIA GeForce GTX 1650`;
- host driver visible in the container: `592.82`;
- VRAM: `4096 MiB`.

## Normal stop and cleanup proof

After the successful rental ended, the GPU/listing was visible as available again in the GPUbnb UI.

PC A then ran read-only Docker inventory checks:

```powershell
docker ps -a --format "{{.Names}}" | Select-String "gpubnb-dev-"
docker ps -a --format "{{.Names}}" | Select-String "gpubnb-dev-proxy-"
docker volume ls --format "{{.Name}}" | Select-String "gpubnb-workspace-"
docker network ls --format "{{.Name}}" | Select-String "gpubnb-workspace-internal-"
```

All four commands returned no matches.

Therefore the validated stop left no GPUbnb per-session:

- Developer container `gpubnb-dev-*`;
- proxy container `gpubnb-dev-proxy-*`;
- Workspace volume `gpubnb-workspace-*`;
- internal network `gpubnb-workspace-internal-*`.

No ProgramData deletion, force-clear, quarantine bypass, manual database mutation or manual Docker deletion was used to obtain this result.

## Why this is a major project milestone

Before the Workspace transport hardening, physical runs could reach parts of the product but fail on stale rental authority, heartbeat/fencing behavior, persistent Workspace startup or WebSocket relay stability.

This baseline proves a materially different level of product integration: a real renter can book a real provider GPU, reach an interactive remote development environment, verify the exact leased physical GPU from inside that environment, finish normally, and leave the provider clean and reusable.

That is one of the strongest end-to-end physical results in the project so far. It should be treated as the minimum behavior that future changes must preserve.

## What this baseline does not claim

This document intentionally does **not** claim that all remaining resilience work is complete.

Still separate:

- #190: unexpected Host power loss/reboot during an active rental can leave old server authority blocking reuse until the old booking window expires. That recovery/termination path still requires deterministic design and physical proof.
- Generic `MachineOperational.DEGRADED` can be projected as `DIAGNOSTIC_FAILED` even when the latest mandatory diagnostic checks passed. That is a state-model/UI correctness issue, not evidence that this clean rental failed.
- Workspace startup speed has not yet been optimized against a measured p50/p95/p99 timing budget. Performance work is tracked separately and must preserve this baseline.

The final clean run locked the Host/Agent identity. It did not independently re-capture a complete API/frontend deployment identity bundle in the same evidence package. Therefore use this record as the qualified **Host/Workspace/GPU/cleanup baseline**; do not silently convert it into an all-component deployment attestation.

## Performance/stability policy after this pass

Do not change timeouts or transport behavior speculatively now that a stable physical path exists.

The next phase must:

1. measure each startup stage independently;
2. separate GPUbnb relay latency from code-server's own behavior;
3. optimize only measured bottlenecks;
4. keep signed Agent auth, anti-replay, fencing, GPU exclusivity, quarantine, bounded queues, browser isolation and cleanup fail-closed;
5. compare every candidate with this frozen baseline;
6. rerun the physical PC A ↔ PC B GPU/Workspace/cleanup test before promotion.

Tracking issue: #191.

## Reference links

- PR #188 — bounded concurrent Workspace WebSocket opens and scoped Service Worker fix.
- PR #189 — Agent 0.6.6 / `workspace_gateway_v7` narrow legacy binary-metadata compatibility.
- Issue #185 — physical Workspace investigation and qualification history.
- Issue #190 — interrupted-rental Host reboot recovery.
- Issue #191 — post-pass measurement, stability and performance hardening.
