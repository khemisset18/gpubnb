# Resource GPU Supervisor v1 — Operations Runbook

## Scope

This runbook covers the dark-qualified resource-scoped mining supervisor introduced above #112. Public mining command production is intentionally disabled until hardware qualification is complete.

## Runtime authority

The always-running Agent is the local process authority. Do not use the desktop GUI, Task Manager, a shell script or a database update to manufacture a `MINING` state.

The durable local journal is `gpu-resource-runtime-v1.json` under the Agent configuration directory. It contains only runtime identity required for ownership/recovery: resource id, GPU UUID, generation, PID, process creation identity, canonical executable path and binary hash.

## Healthy state

For a resource reported as `MINING`, all of the following must agree:

- the API resource maps to the expected `Accelerator.hardwareUuid`;
- the active Redis resource lease is current;
- runtime generation equals the lease fencing token exactly;
- the local runtime record uses the same resource and hardware UUID;
- the PID exists;
- PID creation identity and canonical executable path equal the persisted values;
- the executable still matches the approved release hash.

Any identity disagreement is an incident, not a reason to guess.

## Quarantine behavior

The supervisor quarantines a local resource when it cannot prove that a PID is the process it originally spawned. In particular, PID reuse must never trigger a kill.

When `QUARANTINED` appears:

1. keep production mining command rollout at zero;
2. inspect the resource's hardware UUID and current Redis lease;
3. inspect the OS process by PID, executable path and creation timestamp;
4. confirm whether the process belongs to GPUbnb;
5. capture Agent logs and the local runtime record;
6. do not manually edit the state file while the Agent is running;
7. do not clear quarantine until the process/resource ownership conflict is understood.

If a process is not positively identified as GPUbnb-owned, leave it untouched.

## Startup recovery

After reboot or Agent restart:

- exact process identity still alive -> adopted as `MINING`;
- recorded process no longer exists -> journal becomes `STOPPED`;
- identity mismatch -> `QUARANTINED`.

A missing process is not automatically restarted with the old generation. A new start requires a newer resource lease/fencing token.

## Stale command / fence incidents

Expected fail-closed errors include:

- `mining_resource_lease_required`
- `mining_resource_lease_mismatch`
- `mining_runtime_generation_fence_mismatch`
- `mining_runtime_generation_stale`
- `mining_runtime_generation_replay`
- `mining_runtime_generation_future`

Do not retry these by mutating payloads. Reconcile the server lease/command producer first. A legitimate new start obtains a current resource lease and therefore a current fence.

## GPU identity incidents

Expected identity failures include:

- `resource_gpu_not_present`
- `resource_gpu_identity_not_unique`
- `resource_gpu_pci_identity_invalid`
- `mining_resource_hardware_identity_conflict`

Check `nvidia-smi` UUID/PCI inventory and the API Accelerator row. Slot order changes are safe: the resource key is hardware-UUID based. A changed hardware UUID means the physical identity changed and must not inherit the previous runtime silently.

## Miner provenance incidents

The supervisor refuses a miner when the approved binary is missing, outside the canonical miner root or has a different SHA-256. Treat this as supply-chain/runtime integrity failure.

Do not bypass the hash check. Restore the approved packaged miner through the normal Host installation/update mechanism.

## Hardware qualification before public canary

A real multi-GPU Windows host is required. At minimum run this matrix repeatedly:

1. GPU A mining, GPU B idle -> stop A only.
2. GPU A mining, GPU B mining -> stop A and prove B remains alive and productive.
3. Start A with one fence, stop A, start A with next fence -> replay old stop and prove new process survives.
4. Restart Agent while A and B mine -> exact processes are adopted.
5. Kill miner externally -> Agent recovery marks only that resource stopped.
6. Simulate PID reuse -> no unrelated process is killed; resource quarantines.
7. Reorder GPU enumeration/driver restart -> API resource IDs/configurations remain bound to hardware UUID.
8. Preempt A for rental -> prove A miner exits and target GPU compute/VRAM is clean before renter workload; B keeps mining.
9. Repeat under network loss/reconnect and stale command replay.

Record GPU UUID, PCI BUS:SLOT, process identity and lease fencing token for each case.

## Rollback

This layer is dark by default. Normal rollback requires no Host reinstall:

- keep the production Delivery Worker from producing mining commands;
- set `MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS=0` if direct control traffic must be disabled globally;
- set `AGENT_CONTROL_CHANNEL_ROLLOUT_BPS=0` if the QUIC control channel itself must be disabled;
- retain local journals for forensic/recovery purposes; do not delete them as a routine rollback action.

Developer Workspace rental safety remains on the existing fail-closed mining guard until a separately qualified resource-scoped rental-preemption cutover is merged.
